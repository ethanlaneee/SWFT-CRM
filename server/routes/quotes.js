const router = require("express").Router();
const { db } = require("../firebase");

const col = () => db.collection("quotes");

// List quotes
router.get("/", async (req, res, next) => {
  try {
    let query = col().where("userId", "==", req.uid);
    if (req.query.status) query = query.where("status", "==", req.query.status);
    const snap = await query.orderBy("createdAt", "desc").get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) { next(err); }
});

// Get single quote
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Quote not found" });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) { next(err); }
});

// Create quote
router.post("/", async (req, res, next) => {
  try {
    const data = {
      userId: req.uid,
      customerId: req.body.customerId || "",
      customerName: req.body.customerName || "",
      items: req.body.items || [],
      total: req.body.total || 0,
      notes: req.body.notes || "",
      status: "draft",
      createdAt: Date.now(),
    };
    const ref = await col().add(data);
    res.status(201).json({ id: ref.id, ...data });
  } catch (err) { next(err); }
});

// Update quote
router.put("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Quote not found" });
    }
    const updates = {};
    for (const key of ["customerId", "customerName", "items", "total", "notes", "status"]) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updatedAt = Date.now();
    await col().doc(req.params.id).update(updates);
    res.json({ id: req.params.id, ...doc.data(), ...updates });
  } catch (err) { next(err); }
});

// Send quote
router.post("/:id/send", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Quote not found" });
    }
    await col().doc(req.params.id).update({ status: "sent", sentAt: Date.now() });
    res.json({ success: true, status: "sent" });
  } catch (err) { next(err); }
});

// Approve quote
router.post("/:id/approve", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Quote not found" });
    }
    await col().doc(req.params.id).update({ status: "approved", approvedAt: Date.now() });
    res.json({ success: true, status: "approved" });
  } catch (err) { next(err); }
});

// Delete quote
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Quote not found" });
    }
    await col().doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
