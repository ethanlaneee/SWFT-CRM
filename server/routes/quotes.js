const router = require("express").Router();
const multer = require("multer");
const { db } = require("../firebase");
const { triggerAutomation } = require("./automations");
const { sendViaGmail } = require("./messages");
const { normalizeItems } = require("../utils/normalizeItems");

const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const col = () => db.collection("quotes");

// List
router.get("/", async (req, res, next) => {
  try {
    const snap = await col().where("orgId", "==", req.orgId).get();
    let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (req.query.status) results = results.filter(r => r.status === req.query.status);
    results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(results);
  } catch (err) { next(err); }
});

// Get
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) return res.status(404).json({ error: "Quote not found" });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) { next(err); }
});

// Create
router.post("/", async (req, res, next) => {
  try {
    const data = {
      orgId: req.orgId, userId: req.uid,
      customerId: req.body.customerId || "",
      customerName: req.body.customerName || "",
      items: normalizeItems(req.body.items),
      total: req.body.total || 0,
      notes: req.body.notes || "",
      status: req.body.status || "draft",
      address: req.body.address || "",
      service: req.body.service || "",
      sqft: req.body.sqft || "",
      finish: req.body.finish || "",
      scheduledDate: req.body.scheduledDate || null,
      sentAt: req.body.sentAt || null,
      expiresAt: req.body.expiresAt || null,
      createdAt: Date.now(),
    };
    const ref = await col().add(data);
    res.status(201).json({ id: ref.id, ...data });
  } catch (err) { next(err); }
});

// Update
router.put("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) return res.status(404).json({ error: "Quote not found" });
    const updates = {};
    for (const key of ["customerId", "customerName", "items", "total", "notes", "status", "address", "service", "sqft", "finish", "scheduledDate", "sentAt", "expiresAt"]) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.items) updates.items = normalizeItems(updates.items);
    updates.updatedAt = Date.now();
    await col().doc(req.params.id).update(updates);
    res.json({ id: req.params.id, ...doc.data(), ...updates });
  } catch (err) { next(err); }
});

// Send (mark as sent)
router.post("/:id/send", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) return res.status(404).json({ error: "Quote not found" });
    await col().doc(req.params.id).update({ status: "sent", sentAt: Date.now() });
    const q = doc.data();
    if (q.customerId) {
      const custDoc = await db.collection("customers").doc(q.customerId).get();
      const cust = custDoc.exists ? custDoc.data() : {};
      triggerAutomation(req.orgId, "quote_sent", { id: q.customerId, quoteId: req.params.id, name: cust.name || q.customerName || "", phone: cust.phone || "", email: cust.email || "", total: q.total || 0, service: q.service || "", address: cust.address || q.address || "" }).catch(console.error);
    }
    res.json({ success: true, status: "sent" });
  } catch (err) { next(err); }
});

// Approve
router.post("/:id/approve", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) return res.status(404).json({ error: "Quote not found" });
    await col().doc(req.params.id).update({ status: "approved", approvedAt: Date.now() });
    res.json({ success: true, status: "approved" });
  } catch (err) { next(err); }
});

// Email quote with client-generated PDF attached
router.post("/:id/email", pdfUpload.single("pdf"), async (req, res, next) => {
  try {
    const quoteDoc = await col().doc(req.params.id).get();
    if (!quoteDoc.exists || quoteDoc.data().orgId !== req.orgId) return res.status(404).json({ error: "Quote not found" });
    const quoteData = { id: quoteDoc.id, ...quoteDoc.data() };
    if (!quoteData.customerId) return res.status(400).json({ error: "No customer linked to this quote" });

    const custDoc = await db.collection("customers").doc(quoteData.customerId).get();
    if (!custDoc.exists) return res.status(404).json({ error: "Customer not found" });
    const cust = custDoc.data();
    if (!cust.email) return res.status(400).json({ error: "Customer has no email address." });

    const userDoc = await db.collection("users").doc(req.uid).get();
    const user = userDoc.exists ? userDoc.data() : {};
    if (!user.gmailConnected || !user.gmailTokens) return res.status(400).json({ error: "Gmail not connected." });

    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: "PDF file is required." });
    }

    const custNameClean = (quoteData.customerName || "Customer").replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-");
    const pdfFile = { buffer: req.file.buffer, mimetype: "application/pdf", originalname: `Quote-${custNameClean}.pdf` };

    const fromName = user.company || user.name || "SWFT";
    const subject = `Quote from ${fromName}`;
    const bodyText = req.body.message || `Hi ${cust.name || ""},\n\nPlease find your quote attached.\n\nBest,\n${fromName}`;
    const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;white-space:pre-wrap;">${bodyText}</div>`;

    user._uid = req.uid;
    const sendResult = await sendViaGmail(user, cust.email, subject, htmlBody, bodyText, [pdfFile]);

    await db.collection("messages").add({
      userId: req.uid, orgId: req.orgId, to: cust.email, subject, body: bodyText,
      customerId: quoteData.customerId, customerName: quoteData.customerName || cust.name || "",
      type: "email", status: "sent", sentVia: "gmail",
      gmailMessageId: sendResult.messageId, gmailThreadId: sendResult.threadId, rfcMessageId: sendResult.rfcMessageId || null,
      attachedDocType: "quote", attachedDocId: req.params.id,
      attachments: [pdfFile.originalname], sentAt: Date.now(),
    });

    await col().doc(req.params.id).update({ status: "sent", sentAt: Date.now() });

    if (quoteData.customerId) {
      triggerAutomation(req.orgId, "quote_sent", { id: quoteData.customerId, quoteId: req.params.id, name: cust.name || quoteData.customerName || "", phone: cust.phone || "", email: cust.email || "", total: quoteData.total || 0, service: quoteData.service || "", address: cust.address || quoteData.address || "" }, {
        gmailThreadId: sendResult.threadId,
        gmailMessageId: sendResult.messageId,
        rfcMessageId: sendResult.rfcMessageId,
        originalSubject: subject,
      }).catch(console.error);
    }

    res.json({ success: true, messageId: sendResult.messageId });
  } catch (err) { console.error("[quote email]", err); next(err); }
});

// Delete
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) return res.status(404).json({ error: "Quote not found" });
    await col().doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
