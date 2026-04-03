const router = require("express").Router();
const { db } = require("../firebase");

const col = () => db.collection("invoices");

// List invoices
router.get("/", async (req, res, next) => {
  try {
    const snap = await col().where("userId", "==", req.uid).get();
    let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (req.query.status) results = results.filter(r => r.status === req.query.status);
    results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(results);
  } catch (err) { next(err); }
});

// Get single invoice
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) { next(err); }
});

// Create invoice
router.post("/", async (req, res, next) => {
  try {
    const data = {
      userId: req.uid,
      customerId: req.body.customerId || "",
      customerName: req.body.customerName || "",
      quoteId: req.body.quoteId || null,
      items: req.body.items || [],
      total: req.body.total || 0,
      notes: req.body.notes || "",
      status: req.body.status || "open",
      dueDate: req.body.dueDate || null,
      address: req.body.address || "",
      service: req.body.service || "",
      sqft: req.body.sqft || "",
      finish: req.body.finish || "",
      scheduledDate: req.body.scheduledDate || null,
      createdAt: Date.now(),
    };
    const ref = await col().add(data);
    res.status(201).json({ id: ref.id, ...data });
  } catch (err) { next(err); }
});

// Update invoice
router.put("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    const updates = {};
    for (const key of ["customerId", "customerName", "quoteId", "items", "total", "notes", "status", "dueDate", "address", "service", "sqft", "finish", "scheduledDate"]) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updatedAt = Date.now();
    await col().doc(req.params.id).update(updates);
    res.json({ id: req.params.id, ...doc.data(), ...updates });
  } catch (err) { next(err); }
});

// Pay invoice
router.post("/:id/pay", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    await col().doc(req.params.id).update({
      status: "paid",
      paidAt: Date.now(),
      paymentMethod: req.body.paymentMethod || "other",
    });
    res.json({ success: true, status: "paid" });
  } catch (err) { next(err); }
});

// Delete invoice
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    await col().doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
