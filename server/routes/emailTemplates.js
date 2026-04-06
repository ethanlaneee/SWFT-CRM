const router = require("express").Router();
const { db } = require("../firebase");

const col = (orgId) => db.collection("orgs").doc(orgId).collection("emailTemplates");

// GET /api/email-templates
router.get("/", async (req, res, next) => {
  try {
    const snap = await col(req.orgId).orderBy("createdAt", "desc").get();
    const templates = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(templates);
  } catch (err) { next(err); }
});

// POST /api/email-templates
router.post("/", async (req, res, next) => {
  try {
    const { name, category, subject, body } = req.body;
    if (!name || !subject || !body) {
      return res.status(400).json({ error: "Name, subject, and body are required" });
    }
    const data = {
      name,
      category: category || "general",
      subject,
      body,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const ref = await col(req.orgId).add(data);
    res.status(201).json({ id: ref.id, ...data });
  } catch (err) { next(err); }
});

// PUT /api/email-templates/:id
router.put("/:id", async (req, res, next) => {
  try {
    const { name, category, subject, body } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (category !== undefined) updates.category = category;
    if (subject !== undefined) updates.subject = subject;
    if (body !== undefined) updates.body = body;
    updates.updatedAt = Date.now();
    await col(req.orgId).doc(req.params.id).update(updates);
    res.json({ id: req.params.id, ...updates });
  } catch (err) { next(err); }
});

// DELETE /api/email-templates/:id
router.delete("/:id", async (req, res, next) => {
  try {
    await col(req.orgId).doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
