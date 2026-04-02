const router = require("express").Router();
const { db } = require("../firebase");

const col = () => db.collection("customers");

// List customers for the current user
router.get("/", async (req, res, next) => {
  try {
    const snap = await col().where("userId", "==", req.uid).get();
    const customers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    customers.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(customers);
  } catch (err) { next(err); }
});

// Get single customer
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Customer not found" });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) { next(err); }
});

// Create customer
router.post("/", async (req, res, next) => {
  try {
    const data = {
      userId: req.uid,
      name: req.body.name || "",
      email: req.body.email || "",
      phone: req.body.phone || "",
      address: req.body.address || "",
      notes: req.body.notes || "",
      tags: req.body.tags || [],
      createdAt: Date.now(),
    };
    const ref = await col().add(data);
    res.status(201).json({ id: ref.id, ...data });
  } catch (err) { next(err); }
});

// Update customer — re-fetch after write so response reflects actual saved state
router.put("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Customer not found" });
    }
    const updates = {};
    for (const key of ["name", "email", "phone", "address", "notes", "tags", "since"]) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updatedAt = Date.now();
    await col().doc(req.params.id).update(updates);
    const updated = await col().doc(req.params.id).get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (err) { next(err); }
});

// Delete customer — cascading delete of jobs, quotes, invoices using Firestore batches
// Matches strictly by customerId (not name) to avoid hitting other customers' data
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const customerId = req.params.id;

    // Fetch all related collections in parallel
    const [jobsSnap, quotesSnap, invoicesSnap] = await Promise.all([
      db.collection("jobs").where("userId", "==", req.uid).where("customerId", "==", customerId).get(),
      db.collection("quotes").where("userId", "==", req.uid).where("customerId", "==", customerId).get(),
      db.collection("invoices").where("userId", "==", req.uid).where("customerId", "==", customerId).get(),
    ]);

    // Firestore batch supports up to 500 ops — chunk if needed
    const allDocs = [...jobsSnap.docs, ...quotesSnap.docs, ...invoicesSnap.docs];
    const chunkSize = 499;
    for (let i = 0; i < allDocs.length; i += chunkSize) {
      const batch = db.batch();
      allDocs.slice(i, i + chunkSize).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }

    await col().doc(customerId).delete();

    res.json({ success: true, deleted: { jobs: jobsSnap.size, quotes: quotesSnap.size, invoices: invoicesSnap.size } });
  } catch (err) { next(err); }
});

module.exports = router;
