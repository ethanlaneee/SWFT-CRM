const router = require("express").Router();
const { db } = require("../firebase");
const { triggerAutomation } = require("./automations");

const col = () => db.collection("customers");

// Collections that hold records tied to a customer via customerId.
// When a customer is deleted, every record in these collections with a
// matching customerId is deleted too.
const CASCADE_COLLECTIONS = [
  "quotes",
  "invoices",
  "jobs",
  "messages",
  "schedule",
  "scheduledMessages",
  "photos",
];

// Delete every record in CASCADE_COLLECTIONS with customerId in `customerIds`,
// scoped to this org. Uses Firestore batched writes (500/batch limit).
async function cascadeDeleteForCustomers(customerIds, orgId) {
  if (!customerIds.length) return { total: 0, perCollection: {} };
  const perCollection = {};
  let total = 0;

  for (const collectionName of CASCADE_COLLECTIONS) {
    const refs = [];
    // Firestore 'in' supports up to 30 values per query — chunk for safety.
    for (let i = 0; i < customerIds.length; i += 30) {
      const chunk = customerIds.slice(i, i + 30);
      const snap = await db.collection(collectionName)
        .where("orgId", "==", orgId)
        .where("customerId", "in", chunk)
        .get();
      snap.docs.forEach(d => refs.push(d.ref));
    }
    for (let i = 0; i < refs.length; i += 499) {
      const batch = db.batch();
      refs.slice(i, i + 499).forEach(ref => batch.delete(ref));
      await batch.commit();
    }
    perCollection[collectionName] = refs.length;
    total += refs.length;
  }
  return { total, perCollection };
}

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

    // Notify org about new customer
    db.collection("notifications").add({
      orgId: req.orgId, userId: req.orgId,
      type: "info",
      title: `New Customer Added${data.name ? ": " + data.name : ""}`,
      body: [data.phone, data.email].filter(Boolean).join(" · ") || "A new customer was added",
      read: false, createdAt: Date.now(),
    }).catch(() => {});

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

    // Cascade-delete related records FIRST, then the customers themselves.
    const deletedIds = deletable.map(ref => ref.id);
    const cascade = await cascadeDeleteForCustomers(deletedIds, req.orgId);

    // Commit customer deletions in batches of 499 (Firestore batch limit = 500)
    for (let i = 0; i < deletable.length; i += 499) {
      const batch = db.batch();
      deletable.slice(i, i + 499).forEach(ref => batch.delete(ref));
      await batch.commit();
    }
    res.json({
      success: true,
      deleted: deletable.length,
      skipped: skipped.length,
      cascadeDeleted: cascade.total,
      cascadeByCollection: cascade.perCollection,
    });
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
    const cascade = await cascadeDeleteForCustomers([req.params.id], req.orgId);
    await col().doc(req.params.id).delete();
    console.log("[customers.delete] success:", req.params.id, "cascade:", cascade.total);
    res.json({ success: true, cascadeDeleted: cascade.total, cascadeByCollection: cascade.perCollection });
  } catch (err) {
    console.error("[customers.delete] error:", err);
    next(err);
  }
});

module.exports = router;
