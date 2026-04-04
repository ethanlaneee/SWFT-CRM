const router = require("express").Router();
const { db } = require("../firebase");

const col = () => db.collection("jobs");

// List jobs — technicians only see their assigned jobs
router.get("/", async (req, res, next) => {
  try {
    const snap = await col().where("orgId", "==", req.orgId).get();
    let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Technicians only see jobs explicitly assigned to them
    // If NO jobs have assignedTo set yet, they see all (graceful migration)
    if (req.userRole === "technician") {
      const anyAssigned = results.some(r => r.assignedTo);
      if (anyAssigned) {
        results = results.filter(r => r.assignedTo === req.uid);
      }
      // If no jobs have assignedTo set at all yet, show all (zero-config rollout)
    }

    if (req.query.status) results = results.filter(r => r.status === req.query.status);
    if (req.query.assignedTo) results = results.filter(r => r.assignedTo === req.query.assignedTo);
    results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(results);
  } catch (err) { next(err); }
});

// Get single job
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) { next(err); }
});

// Create job
router.post("/", async (req, res, next) => {
  try {
    const data = {
      orgId: req.orgId,
      userId: req.uid, // keep for legacy compat
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
      assignedTo: req.body.assignedTo || null, // team member UID
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
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Job not found" });
    }
    const updates = {};
    for (const key of ["customerId", "customerName", "quoteId", "title", "description", "service", "status", "scheduledDate", "cost", "address", "sqft", "duration", "finish", "crew", "assignedTo"]) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updatedAt = Date.now();
    await col().doc(req.params.id).update(updates);
    res.json({ id: req.params.id, ...doc.data(), ...updates });
  } catch (err) { next(err); }
});

// Complete job
router.post("/:id/complete", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Job not found" });
    }
    await col().doc(req.params.id).update({ status: "complete", completedAt: Date.now() });
    res.json({ success: true, status: "complete" });
  } catch (err) { next(err); }
});

// Delete job
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Job not found" });
    }
    await col().doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
