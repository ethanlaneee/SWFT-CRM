const router = require("express").Router();
const { db } = require("../firebase");
const { DEFAULT_PLAN, getPlan } = require("../plans");
const { getUsage } = require("../usage");
const Anthropic = require("@anthropic-ai/sdk");

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

      return res.json({ id: req.uid, ...profile });
    }
    let data = await checkTrialExpired(doc.id, doc.data());

    // Self-heal `users.email` to match the Firebase Auth login email. There's
    // no UI to deliberately diverge them (Settings only edits `companyEmail`),
    // so any drift is staleness from older sign-up code paths. Keeping these
    // in sync ensures the team page and other surfaces show the right email.
    if (req.user?.email && data.email !== req.user.email) {
      await col().doc(req.uid).set({ email: req.user.email }, { merge: true });
      data = { ...data, email: req.user.email };
    }

    // Return effective permissions so the frontend can gate nav/pages correctly.
    // For non-owner roles, check orgRoles for custom overrides, then fall back to built-in defaults.
    const role = data.role || "owner";
    let permissions; // undefined = owner (frontend treats missing as unrestricted)
    if (role !== "owner") {
      const orgId = data.orgId || req.uid;
      const BUILT_IN_PERMS = {
        admin: ["dashboard.view","customers.view","customers.add","customers.edit","customers.delete","jobs.view","jobs.viewAll","jobs.add","jobs.edit","jobs.delete","quotes.view","quotes.add","quotes.edit","quotes.delete","invoices.view","invoices.add","invoices.edit","invoices.delete","schedule.view","schedule.add","schedule.edit","schedule.delete","messages.view","messages.send","ai.use","broadcasts.view","broadcasts.send","automations.view","automations.manage","tracker.view","tracker.viewAll","team.manage","integrations.manage","settings.manage"],
        office: ["dashboard.view","customers.view","customers.add","customers.edit","customers.delete","jobs.view","jobs.viewAll","jobs.add","jobs.edit","jobs.delete","quotes.view","quotes.add","quotes.edit","quotes.delete","invoices.view","invoices.add","invoices.edit","invoices.delete","schedule.view","schedule.add","schedule.edit","schedule.delete","messages.view","messages.send","ai.use","broadcasts.view","broadcasts.send","automations.view","tracker.view"],
        technician: ["dashboard.view","jobs.view","jobs.edit","schedule.view","messages.view","messages.send","ai.use","tracker.view"],
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

    // Team members inherit the org owner's plan
    let effectivePlan = data.plan || DEFAULT_PLAN;
    if (data.orgId && data.orgId !== doc.id) {
      try {
        const ownerDoc = await db.collection("users").doc(data.orgId).get();
        if (ownerDoc.exists) effectivePlan = ownerDoc.data().plan || DEFAULT_PLAN;
      } catch (_) {}
    }

    res.json({ id: doc.id, ...data, plan: effectivePlan, ...(permissions !== undefined ? { permissions } : {}) });
  } catch (err) { next(err); }
});

// PUT /api/me
router.put("/", async (req, res, next) => {
  try {
    const updates = {};
    const allowedFields = [
      // Profile
      "name", "firstName", "lastName", "company", "phone",
      // Company
      "address", "country", "website", "companyEmail",
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
      "plan", "isSubscribed", "stripeCustomerId", "accountStatus",
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

// GET /api/me/maps-key — returns the shared Google Maps browser key for authenticated pages
router.get("/maps-key", (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(503).json({ error: "Maps not configured" });
  res.json({ key });
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
      ai:   { used: usage.aiMessageCount, limit: plan.aiMessageLimit === Infinity ? "unlimited" : plan.aiMessageLimit },
    });
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
      max_tokens: 1200,
      messages: [{
        role: "user",
        content: `You are extracting business profile information from a company website so a CRM can auto-fill its settings.

Website text:
${text}

Extract the following and return ONLY valid JSON (no markdown, no explanation):
{
  "about": "2-3 sentence description of the business (what they do, where they're based, how long they've been operating)",
  "services": "comma-separated list of services offered (short phrases — e.g. 'Driveway Pouring, Stamped Concrete, Patios')",
  "serviceArea": "city/region they serve",
  "hours": "business hours if mentioned",
  "company": "business name",
  "phone": "phone number if found",
  "address": "physical address if found",
  "email": "general contact email if found",
  "pricing": "pricing notes if found — any prices, rate cards, minimums, or 'Free estimates' language. Keep it under 400 chars.",
  "paymentMethods": "comma-separated list of payment methods accepted (e.g. 'Cash, Check, Credit Card, Financing') if found",
  "bookingLink": "a booking or scheduling URL if one is linked on the site",
  "faqs": "up to 5 concise Q: ... A: ... pairs from any FAQ section, separated by blank lines. Empty string if none."
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
// Returns 200 for active/trialing accounts, 402 for expired/canceled owners.
// Team members always pass — their access is governed by the org owner's plan.
router.get("/status", async (req, res, next) => {
  try {
    // Admin accounts always get full access
    if (ADMIN_EMAILS.includes(req.user?.email)) {
      return res.json({ accountStatus: "active", allowed: true });
    }

    const doc = await col().doc(req.uid).get();

    // Brand-new user — profile created on first GET /api/me; treat as trialing
    if (!doc.exists) {
      return res.json({ accountStatus: "trialing", allowed: true });
    }

    const data = doc.data();

    // Team members belong to an org — they always get through.
    // Their subscription access is enforced server-side by checkAccess, not here.
    if (data.orgId && data.orgId !== req.uid) {
      return res.json({ accountStatus: "team", allowed: true });
    }

    // Owner accounts: only block if explicitly expired or canceled
    const checkedData = await checkTrialExpired(doc.id, data);
    const accountStatus = checkedData.accountStatus || "trialing";
    const blocked = accountStatus === "expired" || accountStatus === "canceled";

    if (blocked) {
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

// DELETE /api/me/delete-account — permanently delete all user data.
// Requires the caller to have re-authenticated within the last 5 minutes
// — even with a stolen ID token, an attacker can't nuke an account
// without first knowing the user's password (or MFA factor).
const { requireRecentAuth } = require("../middleware/requireRecentAuth");
router.delete("/delete-account", requireRecentAuth(), async (req, res, next) => {
  try {
    const uid = req.uid;

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
