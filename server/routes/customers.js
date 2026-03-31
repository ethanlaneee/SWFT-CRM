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

// Update customer
router.put("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Customer not found" });
    }
    const updates = {};
    for (const key of ["name", "email", "phone", "address", "notes", "tags"]) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updatedAt = Date.now();
    await col().doc(req.params.id).update(updates);
    res.json({ id: req.params.id, ...doc.data(), ...updates });
  } catch (err) { next(err); }
});

// Delete customer (cascading: also deletes their jobs, quotes, invoices)
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const customerId = req.params.id;
    const customerName = doc.data().name || "";

    // Delete all jobs for this customer
    const jobsSnap = await db.collection("jobs").where("userId", "==", req.uid).get();
    const jobDeletes = [];
    jobsSnap.docs.forEach(d => {
      if (d.data().customerId === customerId || d.data().customerName === customerName) {
        jobDeletes.push(db.collection("jobs").doc(d.id).delete());
      }
    });

    // Delete all quotes for this customer
    const quotesSnap = await db.collection("quotes").where("userId", "==", req.uid).get();
    const quoteDeletes = [];
    quotesSnap.docs.forEach(d => {
      if (d.data().customerId === customerId || d.data().customerName === customerName) {
        quoteDeletes.push(db.collection("quotes").doc(d.id).delete());
      }
    });

    // Delete all invoices for this customer
    const invoicesSnap = await db.collection("invoices").where("userId", "==", req.uid).get();
    const invoiceDeletes = [];
    invoicesSnap.docs.forEach(d => {
      if (d.data().customerId === customerId || d.data().customerName === customerName) {
        invoiceDeletes.push(db.collection("invoices").doc(d.id).delete());
      }
    });

    // Execute all deletes
    await Promise.all([...jobDeletes, ...quoteDeletes, ...invoiceDeletes]);

    // Delete the customer
    await col().doc(customerId).delete();

    res.json({ success: true, deleted: { jobs: jobDeletes.length, quotes: quoteDeletes.length, invoices: invoiceDeletes.length } });
  } catch (err) { next(err); }
});

module.exports = router;
