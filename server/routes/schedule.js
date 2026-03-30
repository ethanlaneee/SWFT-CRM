const router = require("express").Router();
const { db } = require("../firebase");

const col = () => db.collection("schedule");

// List schedule entries
router.get("/", async (req, res, next) => {
  try {
    const snap = await col().where("userId", "==", req.uid).orderBy("date", "asc").get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) { next(err); }
});

// Create schedule entry
router.post("/", async (req, res, next) => {
  try {
    const data = {
      userId: req.uid,
      jobId: req.body.jobId || null,
      title: req.body.title || "",
      date: req.body.date || null,
      startTime: req.body.startTime || null,
      endTime: req.body.endTime || null,
      location: req.body.location || "",
      notes: req.body.notes || "",
      createdAt: Date.now(),
    };
    const ref = await col().add(data);
    res.status(201).json({ id: ref.id, ...data });
  } catch (err) { next(err); }
});

// Update schedule entry
router.put("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Schedule entry not found" });
    }
    const updates = {};
    for (const key of ["jobId", "title", "date", "startTime", "endTime", "location", "notes"]) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updatedAt = Date.now();
    await col().doc(req.params.id).update(updates);
    res.json({ id: req.params.id, ...doc.data(), ...updates });
  } catch (err) { next(err); }
});

// Delete schedule entry
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Schedule entry not found" });
    }
    await col().doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
