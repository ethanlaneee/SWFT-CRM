const router = require("express").Router();
const { db } = require("../firebase");
const { triggerAutomation } = require("./automations");
const { sendViaGmail, generateDocumentPdf } = require("./messages");

const col = () => db.collection("quotes");

// List quotes
router.get("/", async (req, res, next) => {
  try {
    const snap = await col().where("orgId", "==", req.orgId).get();
    let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (req.query.status) results = results.filter(r => r.status === req.query.status);
    results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(results);
  } catch (err) { next(err); }
});

// Get single quote
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Quote not found" });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) { next(err); }
});

// Normalize line items to {desc, qty, rate, total} regardless of input format
function normalizeItems(items) {
  function num(v) { if (v === undefined || v === null || v === "") return null; const n = Number(v); return isNaN(n) ? null : n; }
  return (items || []).map(i => {
    if (typeof i === "string") return { desc: i, qty: 1, rate: 0, total: 0 };
    const desc = i.desc || i.description || i.name || i.label || i.service || "";
    const qty = Math.max(1, parseInt(i.qty || i.quantity, 10) || 1);
    const nRate = num(i.rate), nAmount = num(i.amount), nTotal = num(i.total), nPrice = num(i.price);
    const total = (nTotal != null && nTotal > 0) ? nTotal : (nAmount != null && nAmount > 0) ? nAmount : (nPrice != null && nPrice > 0) ? nPrice : (nRate != null && nRate > 0) ? nRate * qty : 0;
    const rate = (nRate != null && nRate > 0) ? nRate : (nAmount != null && nAmount > 0) ? nAmount : (nPrice != null && nPrice > 0) ? nPrice : (total > 0) ? total / qty : 0;
    return { desc, qty, rate, total };
  });
}

// Create quote
router.post("/", async (req, res, next) => {
  try {
    const data = {
      orgId: req.orgId,
      userId: req.uid,
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

// Update quote
router.put("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Quote not found" });
    }
    const updates = {};
    for (const key of ["customerId", "customerName", "items", "total", "notes", "status", "address", "service", "sqft", "finish", "scheduledDate", "sentAt", "expiresAt"]) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    // Always normalize items to {desc, qty, rate, total}
    if (updates.items) updates.items = normalizeItems(updates.items);
    updates.updatedAt = Date.now();
    await col().doc(req.params.id).update(updates);
    res.json({ id: req.params.id, ...doc.data(), ...updates });
  } catch (err) { next(err); }
});

// Send quote
router.post("/:id/send", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Quote not found" });
    }
    await col().doc(req.params.id).update({ status: "sent", sentAt: Date.now() });

    // Trigger automations for quote_sent
    const quoteData = doc.data();
    if (quoteData.customerId) {
      try {
        const custDoc = await db.collection("customers").doc(quoteData.customerId).get();
        const cust = custDoc.exists ? custDoc.data() : {};
        triggerAutomation(req.orgId, "quote_sent", {
          id: quoteData.customerId,
          name: cust.name || quoteData.customerName || "",
          phone: cust.phone || "",
          email: cust.email || "",
          total: quoteData.total || 0,
          service: quoteData.service || "",
        }).catch(console.error);
      } catch (autoErr) {
        console.error("quote_sent automation lookup error:", autoErr);
      }
    }

    res.json({ success: true, status: "sent" });
  } catch (err) { next(err); }
});

// Approve quote
router.post("/:id/approve", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Quote not found" });
    }
    await col().doc(req.params.id).update({ status: "approved", approvedAt: Date.now() });
    res.json({ success: true, status: "approved" });
  } catch (err) { next(err); }
});

// Email quote — generate PDF and send via Gmail, add to message thread
router.post("/:id/email", async (req, res, next) => {
  try {
    const quoteDoc = await col().doc(req.params.id).get();
    if (!quoteDoc.exists || quoteDoc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Quote not found" });
    }
    const quoteData = { id: quoteDoc.id, ...quoteDoc.data() };

    // Get customer email
    if (!quoteData.customerId) {
      return res.status(400).json({ error: "No customer linked to this quote" });
    }
    const custDoc = await db.collection("customers").doc(quoteData.customerId).get();
    if (!custDoc.exists) {
      return res.status(404).json({ error: "Customer not found" });
    }
    const cust = custDoc.data();
    if (!cust.email) {
      return res.status(400).json({ error: "Customer has no email address. Add an email in their profile first." });
    }

    // Get user profile for Gmail + PDF branding
    const userDoc = await db.collection("users").doc(req.uid).get();
    const user = userDoc.exists ? userDoc.data() : {};
    if (!user.gmailConnected || !user.gmailTokens) {
      return res.status(400).json({ error: "Gmail not connected. Connect Gmail in Settings first." });
    }

    // Log the items for debugging
    console.log("[quote email] Items:", JSON.stringify(quoteData.items));

    // Generate PDF
    const pdfBuffer = await generateDocumentPdf(quoteData, "quote", user);
    const custName = (quoteData.customerName || "Customer").replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-");
    const pdfFile = {
      buffer: pdfBuffer,
      mimetype: "application/pdf",
      originalname: `Quote-${custName}.pdf`,
    };

    // Build email
    const fromName = user.company || user.name || "SWFT";
    const subject = `Quote from ${fromName}`;
    const bodyText = req.body.message || `Hi ${cust.name || ""},\n\nPlease find your quote attached.\n\nBest,\n${fromName}`;
    const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;white-space:pre-wrap;">${bodyText}</div>`;

    // Send
    user._uid = req.uid;
    const sendResult = await sendViaGmail(user, cust.email, subject, htmlBody, bodyText, [pdfFile]);

    // Save message record so it shows in messaging thread
    const msgRecord = {
      userId: req.uid,
      orgId: req.orgId,
      to: cust.email,
      subject,
      body: bodyText,
      customerId: quoteData.customerId,
      customerName: quoteData.customerName || cust.name || "",
      type: "email",
      status: "sent",
      sentVia: "gmail",
      gmailMessageId: sendResult.messageId,
      gmailThreadId: sendResult.threadId,
      attachedDocType: "quote",
      attachedDocId: req.params.id,
      attachments: [pdfFile.originalname],
      sentAt: Date.now(),
    };
    await db.collection("messages").add(msgRecord);

    // Update quote status to sent
    await col().doc(req.params.id).update({ status: "sent", sentAt: Date.now() });

    // Trigger automations
    if (quoteData.customerId) {
      triggerAutomation(req.orgId, "quote_sent", {
        id: quoteData.customerId,
        name: cust.name || quoteData.customerName || "",
        phone: cust.phone || "",
        email: cust.email || "",
        total: quoteData.total || 0,
        service: quoteData.service || "",
      }).catch(console.error);
    }

    res.json({ success: true, messageId: sendResult.messageId });
  } catch (err) {
    console.error("[quote email] Error:", err);
    next(err);
  }
});

// Delete quote
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Quote not found" });
    }
    await col().doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
