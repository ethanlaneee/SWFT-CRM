// ════════════════════════════════════════════════
// Data Import — CSV import for customers and jobs
// Supports Jobber, ServiceTitan, Housecall Pro exports
// ════════════════════════════════════════════════

const router = require("express").Router();
const { db } = require("../firebase");

// POST /api/import/customers — bulk import customers from parsed CSV rows
// Body: { rows: [{ name, email, phone, address, notes }] }
router.post("/customers", async (req, res, next) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No rows provided" });
    }
    if (rows.length > 500) {
      return res.status(400).json({ error: "Max 500 customers per import" });
    }

    const now = Date.now();
    const col = db.collection("customers");
    let imported = 0, skipped = 0;
    const errors = [];

    // Process in batches of 500 (Firestore limit)
    const BATCH_SIZE = 400;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = rows.slice(i, i + BATCH_SIZE);
      for (const row of chunk) {
        const name = (row.name || "").trim();
        if (!name) { skipped++; continue; }
        const ref = col.doc();
        batch.set(ref, {
          orgId: req.orgId,
          userId: req.uid,
          name,
          email: (row.email || "").trim().toLowerCase(),
          phone: (row.phone || "").trim(),
          address: (row.address || "").trim(),
          notes: (row.notes || "").trim(),
          tags: row.tags ? row.tags.split(",").map(t => t.trim()).filter(Boolean) : [],
          importedFrom: row.source || "csv",
          createdAt: now,
        });
        imported++;
      }
      await batch.commit();
    }

    res.json({ imported, skipped, errors });
  } catch (err) { next(err); }
});

// POST /api/import/jobs — bulk import jobs
// Body: { rows: [{ title, customerName, status, scheduledDate, address, service, description, cost }] }
router.post("/jobs", async (req, res, next) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No rows provided" });
    }
    if (rows.length > 500) {
      return res.status(400).json({ error: "Max 500 jobs per import" });
    }

    const now = Date.now();
    const jobCol = db.collection("jobs");
    const custCol = db.collection("customers");

    // Build customer name → id cache for this org
    const custSnap = await custCol.where("orgId", "==", req.orgId).get();
    const custMap = {};
    custSnap.docs.forEach(d => {
      custMap[(d.data().name || "").toLowerCase()] = d.id;
    });

    let imported = 0, skipped = 0;
    const BATCH_SIZE = 400;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = rows.slice(i, i + BATCH_SIZE);
      for (const row of chunk) {
        const title = (row.title || row.name || "").trim();
        if (!title) { skipped++; continue; }

        const customerName = (row.customerName || row.client || "").trim();
        const customerId = custMap[customerName.toLowerCase()] || null;

        const ref = jobCol.doc();
        batch.set(ref, {
          orgId: req.orgId,
          userId: req.uid,
          title,
          customerName,
          customerId,
          status: normalizeStatus(row.status) || "scheduled",
          service: (row.service || row.workType || "").trim(),
          description: (row.description || row.notes || "").trim(),
          address: (row.address || "").trim(),
          cost: parseFloat(row.cost || row.total || 0) || 0,
          scheduledDate: row.scheduledDate ? row.scheduledDate.trim() : null,
          crew: (row.crew || row.assignedTo || "Unassigned").trim(),
          importedFrom: row.source || "csv",
          createdAt: now,
        });
        imported++;
      }
      await batch.commit();
    }

    res.json({ imported, skipped });
  } catch (err) { next(err); }
});

function normalizeStatus(s) {
  if (!s) return "scheduled";
  s = s.toLowerCase();
  if (s.includes("complete") || s.includes("done") || s.includes("finish")) return "complete";
  if (s.includes("progress") || s.includes("active") || s.includes("started")) return "active";
  if (s.includes("cancel")) return "cancelled";
  return "scheduled";
}

module.exports = router;
