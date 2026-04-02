const router = require("express").Router();
const { db } = require("../firebase");

const col = () => db.collection("jobs");

// List jobs
router.get("/", async (req, res, next) => {
  try {
    const snap = await col().where("userId", "==", req.uid).get();
    let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (req.query.status) results = results.filter(r => r.status === req.query.status);
    results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(results);
  } catch (err) { next(err); }
});

// Get single job
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) { next(err); }
});

// Create job
router.post("/", async (req, res, next) => {
  try {
    const data = {
      userId: req.uid,
      customerId: req.body.customerId || "",
      customerName: req.body.customerName || "",
      quoteId: req.body.quoteId || null,
      title: req.body.title || "",
      description: req.body.description || "",
      service: req.body.service || "",
      status: req.body.status || "scheduled",
      scheduledDate: req.body.scheduledDate || null,
      cost: req.body.cost || 0,
      address: req.body.address || "",
      sqft: req.body.sqft || "",
      duration: req.body.duration || "",
      finish: req.body.finish || "",
      crew: req.body.crew || "Unassigned",
      createdAt: Date.now(),
    };
    const ref = await col().add(data);
    res.status(201).json({ id: ref.id, ...data });
  } catch (err) { next(err); }
});

// Update job
router.put("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Job not found" });
    }
    const updates = {};
    for (const key of ["customerId", "customerName", "quoteId", "title", "description", "service", "status", "scheduledDate", "cost", "address", "sqft", "duration", "finish", "crew"]) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updatedAt = Date.now();
    await col().doc(req.params.id).update(updates);
    const updated = await col().doc(req.params.id).get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (err) { next(err); }
});

// Complete job
router.post("/:id/complete", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Job not found" });
    }
    await col().doc(req.params.id).update({ status: "complete", completedAt: Date.now() });
    const updated = await col().doc(req.params.id).get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (err) { next(err); }
});

// Delete job
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Job not found" });
    }
    await col().doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
