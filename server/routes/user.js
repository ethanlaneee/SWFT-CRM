const router = require("express").Router();
const { db } = require("../firebase");
const { createSubAccount, buyPhoneNumber, closeSubAccount } = require("../twilio");

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
        trialStartDate: now,
        trialEndDate: now + 14 * 24 * 60 * 60 * 1000, // 14 days from now
        isSubscribed: false,
        stripeCustomerId: "",
        accountStatus: "trialing",
      };
      await col().doc(req.uid).set(profile);

      // Create Twilio sub-account + buy phone number (non-blocking)
      try {
        const friendlyName = profile.company || profile.name || `SWFT-${req.uid}`;
        const subAccount = await createSubAccount(friendlyName);
        const phoneNumber = await buyPhoneNumber(subAccount.sid, subAccount.authToken, profile.phone);
        const twilioFields = {
          twilioSubAccountSid: subAccount.sid,
          twilioAuthToken: subAccount.authToken,
          twilioPhoneNumber: phoneNumber,
        };
        await col().doc(req.uid).set(twilioFields, { merge: true });
        Object.assign(profile, twilioFields);
      } catch (twilioErr) {
        console.error("Twilio sub-account creation failed:", twilioErr.message);
      }

      return res.json({ id: req.uid, ...profile });
    }
    const data = await checkTrialExpired(doc.id, doc.data());
    res.json({ id: doc.id, ...data });
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
      "address", "website",
      // Defaults
      "taxRate", "paymentTerms", "serviceTypes", "crewNames",
      // Preferences
      "weatherUnit",
      // Gmail
      "gmailAddress", "gmailAppPassword",
      // Logo
      "companyLogo",
      // Subscription
      "isSubscribed", "stripeCustomerId", "accountStatus"
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

// POST /api/me/setup-twilio — provision Twilio for existing users
router.post("/setup-twilio", async (req, res, next) => {
  try {
    const doc = await col().doc(req.uid).get();
    if (!doc.exists) return res.status(404).json({ error: "User not found" });

    const data = doc.data();
    if (data.twilioSubAccountSid) {
      return res.json({
        success: true,
        message: "Twilio already configured",
        twilioPhoneNumber: data.twilioPhoneNumber,
      });
    }

    const friendlyName = data.company || data.name || `SWFT-${req.uid}`;
    const subAccount = await createSubAccount(friendlyName);
    const phoneNumber = await buyPhoneNumber(subAccount.sid, subAccount.authToken, data.phone);

    await col().doc(req.uid).set({
      twilioSubAccountSid: subAccount.sid,
      twilioAuthToken: subAccount.authToken,
      twilioPhoneNumber: phoneNumber,
    }, { merge: true });

    res.json({ success: true, twilioPhoneNumber: phoneNumber });
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
        redirect: "/swft-billing.html",
      });
    }

    return res.json({ accountStatus, allowed: true });
  } catch (err) { next(err); }
});

// DELETE /api/me/delete-account — permanently delete all user data
router.delete("/delete-account", async (req, res, next) => {
  try {
    const uid = req.uid;

    // Close Twilio sub-account if it exists
    try {
      const userDoc = await col().doc(uid).get();
      if (userDoc.exists && userDoc.data().twilioSubAccountSid) {
        await closeSubAccount(userDoc.data().twilioSubAccountSid);
      }
    } catch (e) { console.error("Twilio sub-account close failed:", e.message); }

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
