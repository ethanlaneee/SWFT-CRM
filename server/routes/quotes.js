const router = require("express").Router();
const multer = require("multer");
const { db } = require("../firebase");
const { triggerAutomation } = require("./automations");
const { sendViaGmail } = require("./messages");
const { normalizeItems } = require("../utils/normalizeItems");
const { getStripe, ensureStripeCustomer } = require("../utils/stripe");

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
    // Assign next sequential quote number for this org
    const existing = await col().where("orgId", "==", req.orgId).select("quoteNum").get();
    let maxNum = 0;
    existing.docs.forEach(d => {
      const n = parseInt(d.data().quoteNum || 0, 10);
      if (n > maxNum) maxNum = n;
    });
    const quoteNum = maxNum + 1;

    const data = {
      orgId: req.orgId, userId: req.uid,
      quoteNum,
      customerId: req.body.customerId || "",
      customerName: req.body.customerName || "",
      items: normalizeItems(req.body.items),
      subtotal: req.body.subtotal ?? null,
      taxRate: req.body.taxRate ?? null,
      tax: req.body.tax ?? null,
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
    for (const key of ["customerId", "customerName", "items", "subtotal", "taxRate", "tax", "total", "notes", "status", "address", "service", "sqft", "finish", "scheduledDate", "sentAt", "expiresAt"]) {
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

    // Auto-create a Stripe pay link (if owner has Stripe Connect) so the
    // customer can pay the quote with one tap from the email.
    let payLinkUrl = quoteData.paymentLinkUrl || null;
    const ownerStripe = user.integrations?.stripe;
    const connectedAccountId = ownerStripe?.accountId;
    try {
      if (connectedAccountId && (!payLinkUrl || quoteData.stripeConnectAccountId !== connectedAccountId)) {
        const stripe = getStripe();
        const amountCents = Math.round((quoteData.total || 0) * 100);
        if (amountCents >= 50) {
          const stripeOpts = { stripeAccount: connectedAccountId };
          if (quoteData.customerId) {
            try {
              await ensureStripeCustomer({
                db, customerId: quoteData.customerId, orgId: req.orgId, connectedAccountId,
              });
            } catch (e) {
              console.warn("[quotes/email] ensureStripeCustomer failed:", e.message);
            }
          }
          const price = await stripe.prices.create({
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: `Quote — ${quoteData.customerName || "Customer"}${quoteData.service ? ` (${quoteData.service})` : ""}`,
            },
          }, stripeOpts);
          const paymentLink = await stripe.paymentLinks.create({
            line_items: [{ price: price.id, quantity: 1 }],
            metadata: {
              quoteId: req.params.id,
              orgId: req.orgId,
              customerId: quoteData.customerId || "",
            },
            after_completion: {
              type: "hosted_confirmation",
              hosted_confirmation: { custom_message: "Payment received. Thank you!" },
            },
          }, stripeOpts);
          payLinkUrl = paymentLink.url;
          await col().doc(req.params.id).update({
            paymentLinkUrl: payLinkUrl,
            stripePaymentLinkId: paymentLink.id,
            stripeConnectAccountId: connectedAccountId,
            updatedAt: Date.now(),
          });
        }
      }
    } catch (e) {
      console.warn("[quotes] Could not auto-create Stripe pay link:", e.message);
      // Fall through — still send the email, just without the button
    }

    const fromName = user.company || user.name || "SWFT";
    const subject = `Quote from ${fromName}`;
    const bodyText = req.body.message
      || `Hi ${cust.name || ""},\n\nPlease find your quote attached.${payLinkUrl ? `\n\nPay online: ${payLinkUrl}` : ""}\n\nBest,\n${fromName}`;
    const payButtonHtml = payLinkUrl
      ? `<div style="margin:20px 0;"><a href="${payLinkUrl}" style="display:inline-block;background:#635bff;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 32px;border-radius:8px;letter-spacing:0.3px;">Pay $${(quoteData.total || 0).toFixed(2)}</a><div style="font-size:11px;color:#888;margin-top:6px;">Secure checkout powered by Stripe</div></div>`
      : "";
    const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;white-space:pre-wrap;">${bodyText}</div>${payButtonHtml}`;

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
