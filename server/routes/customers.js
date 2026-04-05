const router = require("express").Router();
const { db } = require("../firebase");
const { triggerAutomation } = require("./automations");

const col = () => db.collection("customers");

// List customers for the org
router.get("/", async (req, res, next) => {
  try {
    const snap = await col().where("orgId", "==", req.orgId).get();
    const customers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    customers.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(customers);
  } catch (err) { next(err); }
});

// Get single customer
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Customer not found" });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) { next(err); }
});

// Create customer
router.post("/", async (req, res, next) => {
  try {
    const data = {
      orgId: req.orgId,
      userId: req.uid, // keep for legacy compat
      name: req.body.name || "",
      email: req.body.email || "",
      phone: req.body.phone || "",
      address: req.body.address || "",
      notes: req.body.notes || "",
      tags: req.body.tags || [],
      createdAt: Date.now(),
    };
    const ref = await col().add(data);

    // Trigger automations for customer_created
    triggerAutomation(req.orgId, "customer_created", {
      id: ref.id,
      name: data.name,
      phone: data.phone,
      email: data.email,
    }).catch(console.error);

    res.status(201).json({ id: ref.id, ...data });
  } catch (err) { next(err); }
});

// Update customer
router.put("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Customer not found" });
    }
    const updates = {};
    for (const key of ["name", "email", "phone", "address", "notes", "tags"]) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updatedAt = Date.now();
    await col().doc(req.params.id).update(updates);
    const updated = await col().doc(req.params.id).get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (err) { next(err); }
});

// Delete customer — cascading delete
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Customer not found" });
    }
    const customerId = req.params.id;
    const [jobsSnap, quotesSnap, invoicesSnap] = await Promise.all([
      db.collection("jobs").where("orgId", "==", req.orgId).where("customerId", "==", customerId).get(),
      db.collection("quotes").where("orgId", "==", req.orgId).where("customerId", "==", customerId).get(),
      db.collection("invoices").where("orgId", "==", req.orgId).where("customerId", "==", customerId).get(),
    ]);
    const allDocs = [...jobsSnap.docs, ...quotesSnap.docs, ...invoicesSnap.docs];
    for (let i = 0; i < allDocs.length; i += 499) {
      const batch = db.batch();
      allDocs.slice(i, i + 499).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    await col().doc(customerId).delete();
    res.json({ success: true, deleted: { jobs: jobsSnap.size, quotes: quotesSnap.size, invoices: invoicesSnap.size } });
  } catch (err) { next(err); }
});

module.exports = router;
