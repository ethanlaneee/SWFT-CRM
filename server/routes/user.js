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
    for (const key of ["name", "email", "company", "phone"]) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updatedAt = Date.now();
    await col().doc(req.uid).set(updates, { merge: true });
    const doc = await col().doc(req.uid).get();
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) { next(err); }
});

module.exports = router;
