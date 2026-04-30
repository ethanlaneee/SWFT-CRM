const router = require("express").Router();
const { db } = require("../firebase");
const { triggerAutomation } = require("./automations");
const { encryptFields, decryptFields, PII_FIELDS } = require("../utils/fieldCrypto");

const col = () => db.collection("customers");
const CUSTOMER_PII = PII_FIELDS.customers;

// Decrypt PII on every read so callers see plaintext. No-op when
// ENCRYPT_KEY isn't configured — protects existing records during the
// rollout window.
function readCustomer(doc, orgId) {
  const data = { id: doc.id, ...doc.data() };
  return decryptFields(data, CUSTOMER_PII, orgId);
}

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
    const customers = snap.docs.map(d => readCustomer(d, req.orgId));
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
    res.json(readCustomer(doc, req.orgId));
  } catch (err) { next(err); }
});

// Create customer
router.post("/", async (req, res, next) => {
  try {
    // Capture plaintext values for the automation trigger before encryption,
    // since downstream automations need to read e.g. the customer email to
    // send welcome messages. The data written to Firestore is encrypted.
    const plaintext = {
      name: req.body.name || "",
      email: req.body.email || "",
      phone: req.body.phone || "",
      address: req.body.address || "",
      notes: req.body.notes || "",
      tags: req.body.tags || [],
    };
    const data = {
      orgId: req.orgId,
      userId: req.uid, // keep for legacy compat
      ...plaintext,
      createdAt: Date.now(),
    };
    encryptFields(data, CUSTOMER_PII, req.orgId);
    const ref = await col().add(data);

    // Trigger automations for customer_created — uses plaintext, not the
    // encrypted record, since automations need to actually read the values.
    triggerAutomation(req.orgId, "customer_created", {
      id: ref.id,
      name: plaintext.name,
      phone: plaintext.phone,
      email: plaintext.email,
      tags: plaintext.tags || [],
    }).catch(console.error);

    // Return plaintext to the caller — encryption is a storage concern,
    // not a presentation one.
    res.status(201).json({ id: ref.id, ...data, ...plaintext });
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
    encryptFields(updates, CUSTOMER_PII, req.orgId);
    await col().doc(req.params.id).update(updates);
    const updated = await col().doc(req.params.id).get();
    res.json(readCustomer(updated, req.orgId));
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
