const router = require("express").Router();
const multer = require("multer");
const { db } = require("../firebase");
const { triggerAutomation } = require("./automations");
const { sendViaGmail } = require("./messages");
const { normalizeItems } = require("../utils/normalizeItems");
const { getStripe, ensureStripeCustomer } = require("../utils/stripe");

const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const col = () => db.collection("invoices");

// Stripe recurring interval mapping. We keep our cadence labels friendly
// ("weekly", "monthly", etc.) and convert at the edge when calling Stripe.
const CADENCE_TO_STRIPE = {
  weekly:    { interval: "week",  interval_count: 1 },
  biweekly:  { interval: "week",  interval_count: 2 },
  monthly:   { interval: "month", interval_count: 1 },
  quarterly: { interval: "month", interval_count: 3 },
  yearly:    { interval: "year",  interval_count: 1 },
};

function addCadence(ts, cadence) {
  const d = new Date(ts);
  switch (cadence) {
    case "weekly":    d.setDate(d.getDate() + 7);  break;
    case "biweekly":  d.setDate(d.getDate() + 14); break;
    case "monthly":   d.setMonth(d.getMonth() + 1); break;
    case "quarterly": d.setMonth(d.getMonth() + 3); break;
    case "yearly":    d.setFullYear(d.getFullYear() + 1); break;
    default: return ts;
  }
  return d.getTime();
}

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
    // Assign next sequential invoice number for this org
    const existing = await col().where("orgId", "==", req.orgId).select("invoiceNum").get();
    let maxNum = 0;
    existing.docs.forEach(d => {
      const n = parseInt(d.data().invoiceNum || 0, 10);
      if (n > maxNum) maxNum = n;
    });
    const invoiceNum = maxNum + 1;

    const data = {
      orgId: req.orgId,
      userId: req.uid,
      invoiceNum,
      customerId: req.body.customerId || "",
      customerName: req.body.customerName || "",
      quoteId: req.body.quoteId || null,
      items: normalizeItems(req.body.items),
      subtotal: req.body.subtotal ?? null,
      taxRate: req.body.taxRate ?? null,
      tax: req.body.tax ?? null,
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

    // Recurring setup — validate up front so we don't save a half-configured doc
    const recurring = req.body.recurring;
    if (recurring && recurring.enabled) {
      if (!CADENCE_TO_STRIPE[recurring.cadence]) {
        return res.status(400).json({ error: "Invalid cadence. Use weekly, biweekly, monthly, quarterly, or yearly." });
      }
      if (!data.customerId) {
        return res.status(400).json({ error: "Recurring invoices require a linked customer." });
      }
      if (!data.total || data.total < 0.5) {
        return res.status(400).json({ error: "Recurring invoice total must be at least $0.50." });
      }
      data.isRecurring = true;
      data.recurring = {
        cadence: recurring.cadence,
        startDate: recurring.startDate || Date.now(),
        endDate: recurring.endDate || null,
        cycleCount: recurring.cycleCount || null,
        completedCycles: 0,
        nextDueDate: recurring.startDate || Date.now(),
        status: "active",
      };
    }

    const ref = await col().add(data);

    // Kick off the Stripe Subscription on the owner's connected account. Done
    // after the Firestore write so we can stamp the Subscription ID back onto
    // the doc and so a Stripe failure doesn't orphan the record.
    if (data.isRecurring) {
      try {
        const ownerDoc = await db.collection("users").doc(req.orgId).get();
        const ownerStripe = ownerDoc.exists ? ownerDoc.data()?.integrations?.stripe : null;
        const connectedAccountId = ownerStripe?.accountId;
        if (!connectedAccountId) {
          await col().doc(ref.id).update({
            "recurring.status": "error",
            "recurring.error": "Stripe account not connected. Connect Stripe in Settings to enable recurring invoices.",
            updatedAt: Date.now(),
          });
          return res.status(201).json({ id: ref.id, ...data, recurringWarning: "Stripe not connected — subscription not created." });
        }

        const stripeCustomerId = await ensureStripeCustomer({
          db, customerId: data.customerId, orgId: req.orgId, connectedAccountId,
        });

        const stripe = getStripe();
        const stripeOpts = { stripeAccount: connectedAccountId };
        const cadenceCfg = CADENCE_TO_STRIPE[recurring.cadence];

        const price = await stripe.prices.create({
          currency: "usd",
          unit_amount: Math.round(data.total * 100),
          recurring: cadenceCfg,
          product_data: {
            name: `${data.service || "Service"} — ${data.customerName || "Customer"}`,
          },
        }, stripeOpts);

        const subParams = {
          customer: stripeCustomerId,
          items: [{ price: price.id }],
          collection_method: "send_invoice",
          days_until_due: 7,
          metadata: {
            swftInvoiceId: ref.id,
            orgId: req.orgId,
            swftCustomerId: data.customerId,
          },
        };
        // If the user picked a future start date, let Stripe hold off first
        // charge until then.
        if (data.recurring.startDate && data.recurring.startDate > Date.now() + 60_000) {
          subParams.billing_cycle_anchor = Math.floor(data.recurring.startDate / 1000);
          subParams.proration_behavior = "none";
        }
        // Cap the subscription either by end date or by number of cycles.
        if (data.recurring.endDate) {
          subParams.cancel_at = Math.floor(data.recurring.endDate / 1000);
        }

        const subscription = await stripe.subscriptions.create(subParams, stripeOpts);

        await col().doc(ref.id).update({
          stripeSubscriptionId: subscription.id,
          stripePriceId: price.id,
          stripeConnectAccountId: connectedAccountId,
          "recurring.status": "active",
          updatedAt: Date.now(),
        });
        data.stripeSubscriptionId = subscription.id;
        data.stripePriceId = price.id;
        data.stripeConnectAccountId = connectedAccountId;
      } catch (e) {
        console.error("[invoices] Recurring subscription create failed:", e);
        await col().doc(ref.id).update({
          "recurring.status": "error",
          "recurring.error": e.message || "Failed to create Stripe subscription",
          updatedAt: Date.now(),
        }).catch(() => {});
        return res.status(201).json({
          id: ref.id, ...data,
          recurringWarning: `Invoice saved, but Stripe subscription failed: ${e.message}`,
        });
      }
    }

    res.status(201).json({ id: ref.id, ...data });
  } catch (err) { next(err); }
});

// Cancel a recurring invoice's Stripe Subscription. Leaves the parent
// Firestore doc in place (so the owner keeps the history) but flips the
// recurring.status to "cancelled" and stops future auto-generated invoices.
router.post("/:id/cancel-recurring", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    const inv = doc.data();
    if (!inv.isRecurring) {
      return res.status(400).json({ error: "Invoice is not recurring." });
    }

    if (inv.stripeSubscriptionId && inv.stripeConnectAccountId) {
      try {
        const stripe = getStripe();
        await stripe.subscriptions.cancel(inv.stripeSubscriptionId, {
          stripeAccount: inv.stripeConnectAccountId,
        });
      } catch (e) {
        // If Stripe already cancelled it, keep going so our doc reflects reality.
        console.warn("[invoices] Stripe cancel failed (non-fatal):", e.message);
      }
    }

    await col().doc(req.params.id).update({
      "recurring.status": "cancelled",
      "recurring.cancelledAt": Date.now(),
      updatedAt: Date.now(),
    });
    res.json({ success: true });
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
    for (const key of ["customerId", "customerName", "quoteId", "items", "subtotal", "taxRate", "tax", "total", "notes", "status", "dueDate", "address", "service", "sqft", "finish", "scheduledDate"]) {
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
          invoiceId: req.params.id,
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
          invoiceId: req.params.id,
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

    // Embed a "Pay Now" button only if the owner has Stripe Connect set up.
    // The button links to our public pay-redirect route, which creates a
    // fresh Checkout Session attached to the pre-existing Stripe Customer
    // at click-time. Permanent link, customer always rolls up correctly in
    // the owner's Stripe dashboard.
    const ownerStripe = user.integrations?.stripe;
    const connectedAccountId = ownerStripe?.accountId;
    const APP_URL = process.env.APP_URL || "https://goswft.com";
    const payLinkUrl = connectedAccountId && (invData.total || 0) >= 0.5
      ? `${APP_URL}/api/pay/invoice/${req.params.id}`
      : null;

    const fromName = user.company || user.name || "SWFT";
    const subject = `Invoice from ${fromName}`;
    const bodyText = req.body.message
      || `Hi ${cust.name || ""},\n\nPlease find your invoice attached.${payLinkUrl ? `\n\nPay online: ${payLinkUrl}` : ""}\n\nBest,\n${fromName}`;

    const payButtonHtml = payLinkUrl
      ? `<div style="margin:20px 0;"><a href="${payLinkUrl}" style="display:inline-block;background:#635bff;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 32px;border-radius:8px;letter-spacing:0.3px;">Pay $${(invData.total || 0).toFixed(2)}</a><div style="font-size:11px;color:#888;margin-top:6px;">Secure checkout powered by Stripe</div></div>`
      : "";
    const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;white-space:pre-wrap;">${bodyText}</div>${payButtonHtml}`;

    user._uid = req.uid;
    const sendResult = await sendViaGmail(user, cust.email, subject, htmlBody, bodyText, [pdfFile]);

    await db.collection("messages").add({
      userId: req.uid, orgId: req.orgId, to: cust.email, subject, body: bodyText,
      customerId: invData.customerId, customerName: invData.customerName || cust.name || "",
      type: "email", status: "sent", sentVia: "gmail",
      gmailMessageId: sendResult.messageId, gmailThreadId: sendResult.threadId, rfcMessageId: sendResult.rfcMessageId || null,
      attachedDocType: "invoice", attachedDocId: req.params.id,
      attachments: [pdfFile.originalname], sentAt: Date.now(),
    });

    await col().doc(req.params.id).update({ status: "sent", sentAt: Date.now() });

    if (invData.customerId) {
      triggerAutomation(req.orgId, "invoice_sent", {
        id: invData.customerId,
        invoiceId: req.params.id,
        name: cust.name || invData.customerName || "",
        phone: cust.phone || "",
        email: cust.email || "",
        total: invData.total || 0,
        service: invData.service || "",
      }, {
        gmailThreadId: sendResult.threadId,
        gmailMessageId: sendResult.messageId,
        rfcMessageId: sendResult.rfcMessageId,
        originalSubject: subject,
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
