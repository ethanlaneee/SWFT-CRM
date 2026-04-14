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
      tags: data.tags || [],
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

// Bulk delete customers — single request, batched writes
router.post("/bulk-delete", async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(x => typeof x === "string" && x) : [];
    if (!ids.length) return res.status(400).json({ error: "No ids provided" });

    // Fetch all docs in parallel, keep only ones the user owns
    const snaps = await Promise.all(ids.map(id => col().doc(id).get()));
    const deletable = [];
    const skipped = [];
    snaps.forEach((snap, idx) => {
      if (!snap.exists) { skipped.push(ids[idx]); return; }
      const data = snap.data();
      const owns = data.orgId === req.orgId || data.userId === req.uid || data.orgId === req.uid;
      if (!owns) { skipped.push(ids[idx]); return; }
      deletable.push(snap.ref);
    });

    // Commit in batches of 499 (Firestore batch limit = 500)
    for (let i = 0; i < deletable.length; i += 499) {
      const batch = db.batch();
      deletable.slice(i, i + 499).forEach(ref => batch.delete(ref));
      await batch.commit();
    }
    res.json({ success: true, deleted: deletable.length, skipped: skipped.length });
  } catch (err) {
    console.error("[customers.bulk-delete] error:", err);
    next(err);
  }
});

// Delete customer
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists) {
      console.warn("[customers.delete] doc not found:", req.params.id);
      return res.status(404).json({ error: "Customer not found" });
    }
    const data = doc.data();
    // Allow delete if orgId matches OR legacy userId matches (pre-orgId customers)
    const owns = data.orgId === req.orgId || data.userId === req.uid || data.orgId === req.uid;
    if (!owns) {
      console.warn("[customers.delete] permission denied:", {
        docOrgId: data.orgId, docUserId: data.userId, reqOrgId: req.orgId, reqUid: req.uid,
      });
      return res.status(403).json({ error: "Not authorized to delete this customer" });
    }
    await col().doc(req.params.id).delete();
    console.log("[customers.delete] success:", req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error("[customers.delete] error:", err);
    next(err);
  }
});

module.exports = router;
