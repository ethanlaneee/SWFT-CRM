const router = require("express").Router();
const { db } = require("../firebase");
const { DEFAULT_PLAN, getPlan } = require("../plans");
const { getUsage } = require("../usage");
const Anthropic = require("@anthropic-ai/sdk");
const {
  createMessagingProfile, buyPhoneNumber, closeMessagingProfile,
  searchAvailableNumbers, orderPhoneNumber, releasePhoneNumber,
  normalizeRegion, cityToAreaCode, SHARED_MESSAGING_PROFILE_ID,
} = require("../telnyx");

// Use the shared Telnyx messaging profile if configured, otherwise create per-user profiles.
async function getOrCreateMessagingProfile(friendlyName, webhookUrl) {
  if (SHARED_MESSAGING_PROFILE_ID) return SHARED_MESSAGING_PROFILE_ID;
  const result = await createMessagingProfile(friendlyName, webhookUrl);
  return result.messagingProfileId;
}

const col = () => db.collection("users");

const VALID_ACCOUNT_STATUSES = ["trialing", "active", "expired", "canceled"];
const ADMIN_EMAILS = ["ethan@goswft.com"];

/**
 * Checks if the user's trial has expired (trialEndDate passed and not subscribed).
 * If so, sets accountStatus to 'expired' in Firestore and returns the updated data.
 * @param {string} uid
 * @param {object} data - current Firestore document data
 * @returns {object} potentially updated data
 */
async function checkTrialExpired(uid, data) {
  if (data.isSubscribed) return data;
  const trialEndDate = data.trialEndDate ? new Date(data.trialEndDate) : null;
  if (trialEndDate && Date.now() > trialEndDate.getTime() && data.accountStatus !== "expired") {
    await col().doc(uid).set({ accountStatus: "expired" }, { merge: true });
    return { ...data, accountStatus: "expired" };
  }
  return data;
}

// GET /api/me
router.get("/", async (req, res, next) => {
  try {
    const doc = await col().doc(req.uid).get();
    if (!doc.exists) {
      // Auto-create user profile from auth token
      const now = Date.now();
      const profile = {
        name: req.user.name || "",
        email: req.user.email || "",
        company: "",
        createdAt: now,
        // Subscription fields
        plan: DEFAULT_PLAN,
        trialStartDate: now,
        trialEndDate: now + 14 * 24 * 60 * 60 * 1000, // 14 days from now
        isSubscribed: false,
        stripeCustomerId: "",
        accountStatus: "trialing",
      };
      await col().doc(req.uid).set(profile);

      // Provision a dedicated Telnyx Messaging Profile + phone number for this user.
      // Use Cloudflare geo headers to get the most local number possible:
      //   city → area code → province/state → country
      try {
        const friendlyName = `SWFT - ${req.user.email || req.uid}`;
        const webhookUrl = `${process.env.APP_URL || "https://goswft.com"}/api/webhooks/telnyx/sms`;
        const countryCode = (
          req.headers["cf-ipcountry"] ||
          req.headers["x-vercel-ip-country"] ||
          req.headers["x-country-code"] ||
          "US"
        ).toUpperCase();
        const rawCity = req.headers["cf-ipcity"] || req.headers["x-vercel-ip-city"] || "";
        const rawRegion = req.headers["cf-ipregion"] || req.headers["x-vercel-ip-region"] || "";
        const regionCode = normalizeRegion(rawRegion, countryCode);
        const areaCode = cityToAreaCode(rawCity);

        console.log(`[user] Provisioning Telnyx for ${req.user.email} — country:${countryCode} region:${regionCode||"?"} city:${rawCity||"?"} areaCode:${areaCode||"?"}`);

        const messagingProfileId = await getOrCreateMessagingProfile(friendlyName, webhookUrl);
        const { phoneNumber, phoneSid } = await buyPhoneNumber(
          messagingProfileId, webhookUrl,
          { countryCode, region: regionCode, city: rawCity, areaCode }
        );

        const telnyxFields = {
          telnyxMessagingProfileId: messagingProfileId,
          telnyxPhoneNumber: phoneNumber,
          telnyxPhoneSid: phoneSid,
        };
        await col().doc(req.uid).set(telnyxFields, { merge: true });
        Object.assign(profile, telnyxFields);
        console.log(`[user] Telnyx provisioned for ${req.user.email}: ${phoneNumber}`);
      } catch (err) {
        // Don't block account creation if Telnyx provisioning fails
        console.error("[user] Telnyx provisioning failed:", err.message);
      }

      return res.json({ id: req.uid, ...profile });
    }
    const data = await checkTrialExpired(doc.id, doc.data());

    // Return effective permissions so the frontend can gate nav/pages correctly.
    // For non-owner roles, check orgRoles for custom overrides, then fall back to built-in defaults.
    const role = data.role || "owner";
    let permissions; // undefined = owner (frontend treats missing as unrestricted)
    if (role !== "owner") {
      const orgId = data.orgId || req.uid;
      const BUILT_IN_PERMS = {
        admin: ["dashboard.view","customers.view","customers.add","customers.edit","customers.delete","jobs.view","jobs.viewAll","jobs.add","jobs.edit","jobs.delete","quotes.view","quotes.add","quotes.edit","quotes.delete","invoices.view","invoices.add","invoices.edit","invoices.delete","schedule.view","schedule.add","schedule.edit","schedule.delete","messages.view","messages.send","ai.use","broadcasts.view","broadcasts.send","automations.view","automations.manage","team.manage","integrations.manage","settings.manage"],
        office: ["dashboard.view","customers.view","customers.add","customers.edit","customers.delete","jobs.view","jobs.viewAll","jobs.add","jobs.edit","jobs.delete","quotes.view","quotes.add","quotes.edit","quotes.delete","invoices.view","invoices.add","invoices.edit","invoices.delete","schedule.view","schedule.add","schedule.edit","schedule.delete","messages.view","messages.send","ai.use","broadcasts.view","broadcasts.send","automations.view"],
        technician: ["dashboard.view","jobs.view","jobs.edit","schedule.view","messages.view","messages.send","ai.use"],
      };
      try {
        const orgRolesDoc = await db.collection("orgRoles").doc(orgId).get();
        if (orgRolesDoc.exists) {
          const customRoles = orgRolesDoc.data().roles || {};
          if (customRoles[role] && Array.isArray(customRoles[role].permissions)) {
            permissions = customRoles[role].permissions;
          }
        }
      } catch (_) {}
      if (!permissions) {
        permissions = BUILT_IN_PERMS[role] || [];
      }
    }

    res.json({ id: doc.id, ...data, ...(permissions !== undefined ? { permissions } : {}) });
  } catch (err) { next(err); }
});

// PUT /api/me
router.put("/", async (req, res, next) => {
  try {
    const updates = {};
    const allowedFields = [
      // Profile
      "name", "firstName", "lastName", "email", "company", "phone",
      // Company
      "address", "country", "website",
      // Defaults
      "taxRate", "paymentTerms", "serviceTypes", "lineItemTypes", "crewNames",
      // Preferences
      "weatherUnit",
      // Gmail
      "gmailAddress", "gmailAppPassword",
      // Logo
      "companyLogo",
      // Business Profile for AI
      "bizAbout", "bizServices", "bizArea", "bizHours", "bizWebsite", "bizNotes",
      "bizPricing", "bizPaymentMethods", "bizBookingLink", "bizFaqs",
      // AI custom instructions
      "aiCustomInstructions",
      // Subscription
      "plan", "isSubscribed", "stripeCustomerId", "accountStatus"
    ];
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.accountStatus && !VALID_ACCOUNT_STATUSES.includes(updates.accountStatus)) {
      return res.status(400).json({ error: `accountStatus must be one of: ${VALID_ACCOUNT_STATUSES.join(", ")}` });
    }
    updates.updatedAt = Date.now();
    await col().doc(req.uid).set(updates, { merge: true });
    const doc = await col().doc(req.uid).get();
    const data = await checkTrialExpired(doc.id, doc.data());
    res.json({ id: doc.id, ...data });
  } catch (err) { next(err); }
});

// GET /api/me/usage — returns current month's usage and plan limits
router.get("/usage", async (req, res, next) => {
  try {
    const doc = await col().doc(req.uid).get();
    const data = doc.exists ? doc.data() : {};
    const plan = getPlan(data.plan);
    const usage = await getUsage(req.uid);
    res.json({
      plan: data.plan || DEFAULT_PLAN,
      planName: plan.name,
      sms:  { used: usage.smsCount, limit: plan.smsLimit === Infinity ? "unlimited" : plan.smsLimit },
      ai:   { used: usage.aiMessageCount, limit: plan.aiMessageLimit === Infinity ? "unlimited" : plan.aiMessageLimit },
    });
  } catch (err) { next(err); }
});

// POST /api/me/setup-telnyx — provision Telnyx for existing users who don't have a number yet
router.post("/setup-telnyx", async (req, res, next) => {
  try {
    const doc = await col().doc(req.uid).get();
    const data = doc.exists ? doc.data() : {};

    if (data.telnyxMessagingProfileId && data.telnyxPhoneNumber) {
      return res.json({ success: true, phoneNumber: data.telnyxPhoneNumber, message: "Telnyx already provisioned" });
    }

    const friendlyName = `SWFT - ${data.email || req.user.email || req.uid}`;
    const webhookUrl = `${process.env.APP_URL || "https://goswft.com"}/api/webhooks/telnyx/sms`;

    const countryCode = (req.body.countryCode || data.country
      || req.headers["cf-ipcountry"] || req.headers["x-vercel-ip-country"]
      || req.headers["x-country-code"] || "US").toUpperCase();
    const rawCity = req.headers["cf-ipcity"] || req.headers["x-vercel-ip-city"] || "";
    const rawRegion = req.headers["cf-ipregion"] || req.headers["x-vercel-ip-region"] || "";
    const regionCode = req.body.region || normalizeRegion(rawRegion, countryCode);
    const areaCode = req.body.areaCode || cityToAreaCode(rawCity) || undefined;

    const messagingProfileId = await getOrCreateMessagingProfile(friendlyName, webhookUrl);
    const { phoneNumber, phoneSid } = await buyPhoneNumber(
      messagingProfileId, webhookUrl, { countryCode, region: regionCode, city: rawCity, areaCode }
    );

    await col().doc(req.uid).set({
      telnyxMessagingProfileId: messagingProfileId,
      telnyxPhoneNumber: phoneNumber,
      telnyxPhoneSid: phoneSid,
    }, { merge: true });

    console.log(`[user] Telnyx provisioned for existing user ${data.email}: ${phoneNumber}`);
    res.json({ success: true, phoneNumber, message: "Telnyx messaging profile and phone number provisioned" });
  } catch (err) { next(err); }
});

// POST /api/me/find-google-business — search Google Places for the user's business
// and return a pre-built Google review URL.
router.post("/find-google-business", async (req, res, next) => {
  try {
    const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!MAPS_KEY) return res.status(503).json({ error: "Google Maps API not configured" });

    const doc = await col().doc(req.uid).get();
    const userData = doc.exists ? doc.data() : {};

    // Build search query from business name + address
    const businessName = req.body.businessName || userData.company || userData.name || "";
    const address = req.body.address || userData.address || "";
    const query = [businessName, address].filter(Boolean).join(" ");

    if (!query.trim()) {
      return res.status(400).json({ error: "No business name or address found in your profile. Add them in Company Profile first." });
    }

    // Google Places Text Search
    const searchUrl = new URL("https://maps.googleapis.com/maps/api/place/findplacefromtext/json");
    searchUrl.searchParams.set("input", query);
    searchUrl.searchParams.set("inputtype", "textquery");
    searchUrl.searchParams.set("fields", "place_id,name,formatted_address");
    searchUrl.searchParams.set("key", MAPS_KEY);

    const placesRes = await fetch(searchUrl.toString());
    const placesData = await placesRes.json();

    if (placesData.status !== "OK" || !placesData.candidates?.length) {
      return res.status(404).json({
        error: "Business not found on Google Maps. Try updating your company name and address in Company Profile.",
        googleStatus: placesData.status,
      });
    }

    const place = placesData.candidates[0];
    const reviewUrl = `https://search.google.com/local/writereview?placeid=${place.place_id}`;

    // Auto-save to user profile
    await col().doc(req.uid).set({ googleReviewLink: reviewUrl }, { merge: true });

    res.json({
      placeId: place.place_id,
      businessName: place.name,
      address: place.formatted_address,
      reviewUrl,
    });
  } catch (err) { next(err); }
});

// POST /api/me/analyze-website — fetch a business website and use AI to extract profile info
router.post("/analyze-website", async (req, res, next) => {
  try {
    let { url } = req.body;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }
    // Ensure URL has a protocol
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;

    // Fetch the website
    let html = "";
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; SWFTBot/1.0)" },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      html = await response.text();
    } catch (fetchErr) {
      return res.status(422).json({ error: "Could not fetch website: " + fetchErr.message });
    }

    // Strip HTML tags and collapse whitespace — keep first 6000 chars for context
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 6000);

    if (!text.length) {
      return res.status(422).json({ error: "Could not extract text from website" });
    }

    const anthropic = new Anthropic();
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `You are extracting business profile information from a company website.

Website text:
${text}

Extract the following and return ONLY valid JSON (no markdown, no explanation):
{
  "about": "2-3 sentence description of the business (what they do, where they're based, how long they've been operating)",
  "services": "comma-separated list of services offered",
  "serviceArea": "city/region they serve",
  "hours": "business hours if mentioned",
  "company": "business name",
  "phone": "phone number if found",
  "address": "physical address if found"
}

If a field cannot be determined from the text, use an empty string "".`
      }],
    });

    let extracted = {};
    try {
      const raw = message.content[0]?.text?.trim() || "{}";
      extracted = JSON.parse(raw.replace(/^```json?\s*/i, "").replace(/```\s*$/i, ""));
    } catch (_) {
      return res.status(500).json({ error: "AI returned unexpected format. Try again." });
    }

    res.json({ success: true, data: extracted });
  } catch (err) { next(err); }
});

// GET /api/me/available-numbers — search available phone numbers (for number picker)
// Query params: country, region (province/state code), areaCode, city
router.get("/available-numbers", async (req, res, next) => {
  try {
    const { country, region, areaCode, city } = req.query;
    const countryCode = (country || req.headers["cf-ipcountry"] || "US").toUpperCase();
    const regionCode = region || normalizeRegion(
      req.headers["cf-ipregion"] || req.headers["x-vercel-ip-region"] || "",
      countryCode
    );
    const resolvedAreaCode = areaCode || (city ? cityToAreaCode(city) : null) ||
      (req.headers["cf-ipcity"] ? cityToAreaCode(req.headers["cf-ipcity"]) : null);

    const numbers = await searchAvailableNumbers({
      countryCode,
      region: regionCode,
      areaCode: resolvedAreaCode,
      city,
      limit: 12,
    });
    res.json({ numbers, countryCode, region: regionCode, areaCode: resolvedAreaCode });
  } catch (err) { next(err); }
});

// POST /api/me/select-number — order a specific number the user chose from the picker
// Body: { phoneNumber: "+14035551234" }
//   OR: { autoAssign: true, countryCode: "CA", region: "AB", areaCode: "403" }
router.post("/select-number", async (req, res, next) => {
  try {
    const { phoneNumber, autoAssign, countryCode: reqCountry, region: reqRegion, areaCode: reqAreaCode } = req.body;
    if (!phoneNumber && !autoAssign) return res.status(400).json({ error: "phoneNumber or autoAssign required" });

    const doc = await col().doc(req.uid).get();
    const userData = doc.exists ? doc.data() : {};
    const webhookUrl = `${process.env.APP_URL || "https://goswft.com"}/api/webhooks/telnyx/sms`;

    // Reuse existing messaging profile, or create one if none
    let messagingProfileId = userData.telnyxMessagingProfileId;
    if (!messagingProfileId) {
      const friendlyName = `SWFT - ${userData.email || req.user.email || req.uid}`;
      try {
        messagingProfileId = await getOrCreateMessagingProfile(friendlyName, webhookUrl);
      } catch (profileErr) {
        console.error("[user] getOrCreateMessagingProfile failed:", profileErr.message);
        return res.status(503).json({
          error: "Telnyx messaging is not yet enabled on this account. Please contact SWFT support.",
        });
      }
    }

    let realNumber, phoneSid;

    if (autoAssign) {
      // Auto-assign: buy the best available number for the given geo params.
      // Used for countries like CA where Telnyx doesn't pre-list specific numbers.
      const countryCode = (reqCountry || "CA").toUpperCase();
      console.log(`[user] Auto-assigning number for ${userData.email || req.uid} — country:${countryCode} region:${reqRegion || "?"} areaCode:${reqAreaCode || "?"}`);
      ({ phoneNumber: realNumber, phoneSid } = await buyPhoneNumber(
        messagingProfileId, webhookUrl,
        { countryCode, region: reqRegion, areaCode: reqAreaCode }
      ));
    } else {
      // Release old number if the user already has one
      if (userData.telnyxPhoneSid && userData.telnyxPhoneNumber !== phoneNumber) {
        try { await releasePhoneNumber(userData.telnyxPhoneSid); } catch (_) { /* non-fatal */ }
      }
      ({ phoneSid } = await orderPhoneNumber(phoneNumber, messagingProfileId));
      realNumber = phoneNumber;
    }

    await col().doc(req.uid).set({
      telnyxPhoneNumber: realNumber,
      telnyxPhoneSid: phoneSid,
      telnyxMessagingProfileId: messagingProfileId,
    }, { merge: true });

    console.log(`[user] Number changed for ${userData.email || req.uid}: ${realNumber}`);
    res.json({ success: true, phoneNumber: realNumber, messagingProfileId });
  } catch (err) { next(err); }
});

// POST /api/me/check-trial — manually trigger trial expiry check
router.post("/check-trial", async (req, res, next) => {
  try {
    const doc = await col().doc(req.uid).get();
    if (!doc.exists) return res.status(404).json({ error: "User not found" });
    const data = await checkTrialExpired(doc.id, doc.data());
    res.json({ id: doc.id, accountStatus: data.accountStatus });
  } catch (err) { next(err); }
});

// GET /api/me/status — called immediately after login to gate dashboard access.
// Returns 200 for payable/active accounts, 402 for expired/canceled.
// The frontend uses this to decide whether to proceed to the dashboard or
// sign the user out and redirect them to the billing/payment page.
router.get("/status", async (req, res, next) => {
  try {
    // Admin accounts always get full access — never blocked by trial/subscription checks
    if (ADMIN_EMAILS.includes(req.user?.email)) {
      return res.json({ accountStatus: "active", allowed: true });
    }

    const doc = await col().doc(req.uid).get();

    // Brand-new user — profile created on first GET /api/me; treat as trialing
    if (!doc.exists) {
      return res.json({ accountStatus: "trialing", allowed: true });
    }

    const data = await checkTrialExpired(doc.id, doc.data());
    // If accountStatus was never written (pre-subscription-fields user), treat as trialing
    const accountStatus = data.accountStatus || "trialing";
    const allowed = accountStatus === "active" || accountStatus === "trialing";

    if (!allowed) {
      return res.status(402).json({
        error: "Payment required.",
        message: "Your trial has ended. Please upgrade to continue.",
        accountStatus,
        redirect: "/swft-billing",
      });
    }

    return res.json({ accountStatus, allowed: true });
  } catch (err) { next(err); }
});

// DELETE /api/me/delete-account — permanently delete all user data
router.delete("/delete-account", async (req, res, next) => {
  try {
    const uid = req.uid;

    // Release Telnyx phone number and messaging profile if provisioned
    try {
      const userDoc = await col().doc(uid).get();
      const userData = userDoc.exists ? userDoc.data() : {};
      if (userData.telnyxMessagingProfileId) {
        await closeMessagingProfile(userData.telnyxMessagingProfileId, userData.telnyxPhoneSid);
        console.log(`[user] Released Telnyx profile ${userData.telnyxMessagingProfileId}`);
      }
    } catch (err) {
      console.error("[user] Failed to release Telnyx resources:", err.message);
    }

    const collections = ["customers", "jobs", "quotes", "invoices", "schedule"];

    // Delete all documents in each collection for this user
    for (const colName of collections) {
      const snap = await db.collection(colName).where("userId", "==", uid).get();
      const batch = db.batch();
      snap.docs.forEach(doc => batch.delete(doc.ref));
      if (snap.docs.length > 0) await batch.commit();
    }

    // Delete conversation history
    try {
      const convSnap = await db.collection("conversations").doc(uid).collection("messages").get();
      const convBatch = db.batch();
      convSnap.docs.forEach(doc => convBatch.delete(doc.ref));
      if (convSnap.docs.length > 0) await convBatch.commit();
      await db.collection("conversations").doc(uid).delete();
    } catch (e) { /* conversation may not exist */ }

    // Delete user profile
    await col().doc(uid).delete();

    // Delete Firebase Auth account
    try {
      const { authAdmin } = require("../firebase");
      await authAdmin.deleteUser(uid);
    } catch (e) { /* auth delete may fail if already deleted */ }

    res.json({ success: true, message: "Account and all data permanently deleted" });
  } catch (err) { next(err); }
});

module.exports = router;
