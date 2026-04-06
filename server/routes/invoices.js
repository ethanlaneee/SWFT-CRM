const router = require("express").Router();
const multer = require("multer");
const { db } = require("../firebase");
const { triggerAutomation } = require("./automations");
const { sendViaGmail } = require("./messages");
const { normalizeItems } = require("../utils/normalizeItems");

const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const col = () => db.collection("invoices");

// List invoices
router.get("/", async (req, res, next) => {
  try {
    const snap = await col().where("orgId", "==", req.orgId).get();
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
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) { next(err); }
});

// Create invoice
router.post("/", async (req, res, next) => {
  try {
    const data = {
      orgId: req.orgId,
      userId: req.uid,
      customerId: req.body.customerId || "",
      customerName: req.body.customerName || "",
      quoteId: req.body.quoteId || null,
      items: normalizeItems(req.body.items),
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
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    const updates = {};
    for (const key of ["customerId", "customerName", "quoteId", "items", "total", "notes", "status", "dueDate", "address", "service", "sqft", "finish", "scheduledDate"]) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.items) updates.items = normalizeItems(updates.items);
    updates.updatedAt = Date.now();
    await col().doc(req.params.id).update(updates);
    res.json({ id: req.params.id, ...doc.data(), ...updates });
  } catch (err) { next(err); }
});

// Mark invoice as sent (without emailing) and trigger automation
router.post("/:id/send", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    await col().doc(req.params.id).update({ status: "sent", sentAt: Date.now() });

    const invoiceData = doc.data();
    if (invoiceData.customerId) {
      try {
        const custDoc = await db.collection("customers").doc(invoiceData.customerId).get();
        const cust = custDoc.exists ? custDoc.data() : {};
        triggerAutomation(req.orgId, "invoice_sent", {
          id: invoiceData.customerId,
          name: cust.name || invoiceData.customerName || "",
          phone: cust.phone || "",
          email: cust.email || "",
          total: invoiceData.total || 0,
          service: invoiceData.service || "",
        }).catch(console.error);
      } catch (autoErr) {
        console.error("invoice_sent automation error:", autoErr);
      }
    }
    res.json({ success: true, status: "sent" });
  } catch (err) { next(err); }
});

// Pay invoice
router.post("/:id/pay", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    await col().doc(req.params.id).update({
      status: "paid",
      paidAt: Date.now(),
      paymentMethod: req.body.paymentMethod || "other",
    });

    // Trigger automations for invoice_paid
    const invoiceData = doc.data();
    if (invoiceData.customerId) {
      try {
        const custDoc = await db.collection("customers").doc(invoiceData.customerId).get();
        const cust = custDoc.exists ? custDoc.data() : {};
        triggerAutomation(req.orgId, "invoice_paid", {
          id: invoiceData.customerId,
          name: cust.name || invoiceData.customerName || "",
          phone: cust.phone || "",
          email: cust.email || "",
          total: invoiceData.total || 0,
          service: invoiceData.service || "",
        }).catch(console.error);
      } catch (autoErr) {
        console.error("invoice_paid automation lookup error:", autoErr);
      }
    }

    res.json({ success: true, status: "paid" });
  } catch (err) { next(err); }
});

// Email invoice with client-generated PDF attached
router.post("/:id/email", pdfUpload.single("pdf"), async (req, res, next) => {
  try {
    const invDoc = await col().doc(req.params.id).get();
    if (!invDoc.exists || invDoc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    const invData = { id: invDoc.id, ...invDoc.data() };

    if (!invData.customerId) {
      return res.status(400).json({ error: "No customer linked to this invoice" });
    }
    const custDoc = await db.collection("customers").doc(invData.customerId).get();
    if (!custDoc.exists) return res.status(404).json({ error: "Customer not found" });
    const cust = custDoc.data();
    if (!cust.email) {
      return res.status(400).json({ error: "Customer has no email address. Add an email in their profile first." });
    }

    const userDoc = await db.collection("users").doc(req.uid).get();
    const user = userDoc.exists ? userDoc.data() : {};
    if (!user.gmailConnected || !user.gmailTokens) {
      return res.status(400).json({ error: "Gmail not connected. Connect Gmail in Settings first." });
    }

    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: "PDF file is required." });
    }

    const custNameClean = (invData.customerName || "Customer").replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-");
    const pdfFile = { buffer: req.file.buffer, mimetype: "application/pdf", originalname: `Invoice-${custNameClean}.pdf` };

    const fromName = user.company || user.name || "SWFT";
    const subject = `Invoice from ${fromName}`;
    const bodyText = req.body.message || `Hi ${cust.name || ""},\n\nPlease find your invoice attached.\n\nBest,\n${fromName}`;
    const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;white-space:pre-wrap;">${bodyText}</div>`;

    user._uid = req.uid;
    const sendResult = await sendViaGmail(user, cust.email, subject, htmlBody, bodyText, [pdfFile]);

    await db.collection("messages").add({
      userId: req.uid, orgId: req.orgId, to: cust.email, subject, body: bodyText,
      customerId: invData.customerId, customerName: invData.customerName || cust.name || "",
      type: "email", status: "sent", sentVia: "gmail",
      gmailMessageId: sendResult.messageId, gmailThreadId: sendResult.threadId,
      attachedDocType: "invoice", attachedDocId: req.params.id,
      attachments: [pdfFile.originalname], sentAt: Date.now(),
    });

    await col().doc(req.params.id).update({ status: "sent", sentAt: Date.now() });

    if (invData.customerId) {
      triggerAutomation(req.orgId, "invoice_sent", {
        id: invData.customerId,
        name: cust.name || invData.customerName || "",
        phone: cust.phone || "",
        email: cust.email || "",
        total: invData.total || 0,
        service: invData.service || "",
      }).catch(console.error);
    }

    res.json({ success: true, messageId: sendResult.messageId });
  } catch (err) {
    console.error("[invoice email] Error:", err);
    next(err);
  }
});

// Delete invoice
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    await col().doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
