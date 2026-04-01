const router = require("express").Router();
const { db } = require("../firebase");

const col = () => db.collection("users");

// GET /api/me
router.get("/", async (req, res, next) => {
  try {
    const doc = await col().doc(req.uid).get();
    if (!doc.exists) {
      // Auto-create user profile from auth token
      const profile = {
        name: req.user.name || "",
        email: req.user.email || "",
        company: "",
        createdAt: Date.now(),
      };
      await col().doc(req.uid).set(profile);
      return res.json({ id: req.uid, ...profile });
    }
    res.json({ id: doc.id, ...doc.data() });
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
      "companyLogo"
    ];
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updatedAt = Date.now();
    await col().doc(req.uid).set(updates, { merge: true });
    const doc = await col().doc(req.uid).get();
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) { next(err); }
});

// DELETE /api/me/delete-account — permanently delete all user data
router.delete("/delete-account", async (req, res, next) => {
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
