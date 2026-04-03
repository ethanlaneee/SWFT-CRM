const router = require("express").Router();
const { db } = require("../firebase");
const postmark = require("postmark");
const { sendSms } = require("../twilio");

const emailClient = new postmark.ServerClient(
  process.env.POSTMARK_API_TOKEN || "32a85e4b-55e5-45e2-950e-6c120b001007"
);

/**
 * Generate HTML email body for a quote or invoice attachment.
 */
function generateDocumentHtml(doc, docType, user) {
  const companyName = user.company || user.name || "SWFT";
  const title = docType === "quote" ? "Quote" : "Invoice";
  const items = doc.items || [];

  const itemRows = items
    .map(
      (item) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;color:#333;">${item.desc || item.description || ""}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;color:#555;text-align:center;">${item.qty || 1}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;color:#555;text-align:right;">$${Number(item.rate || 0).toFixed(2)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;color:#333;text-align:right;font-weight:600;">$${Number(item.total || 0).toFixed(2)}</td>
    </tr>`
    )
    .join("");

  const total = doc.total || 0;
  const dateLabel = docType === "quote" ? "Expires" : "Due Date";
  const dateValue =
    docType === "quote"
      ? doc.expiresAt
        ? new Date(doc.expiresAt).toLocaleDateString()
        : "—"
      : doc.dueDate
      ? new Date(doc.dueDate).toLocaleDateString()
      : "—";

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
    <div style="background:#0a0a0a;padding:24px 32px;">
      <h1 style="margin:0;color:#c8f135;font-size:24px;letter-spacing:2px;">${companyName}</h1>
      <p style="margin:4px 0 0;color:#999;font-size:12px;letter-spacing:1px;">${title}</p>
    </div>
    <div style="padding:28px 32px;">
      <table style="width:100%;margin-bottom:16px;">
        <tr>
          <td style="font-size:13px;color:#888;">Customer</td>
          <td style="font-size:13px;color:#888;text-align:right;">${dateLabel}</td>
        </tr>
        <tr>
          <td style="font-size:16px;color:#222;font-weight:600;padding-top:4px;">${doc.customerName || "—"}</td>
          <td style="font-size:14px;color:#222;text-align:right;padding-top:4px;">${dateValue}</td>
        </tr>
      </table>
      ${doc.address ? `<p style="font-size:13px;color:#666;margin:0 0 20px;">Address: ${doc.address}</p>` : ""}
      ${doc.service ? `<p style="font-size:13px;color:#666;margin:0 0 20px;">Service: ${doc.service}</p>` : ""}
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        <thead>
          <tr style="background:#f9f9f9;">
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;">Description</th>
            <th style="padding:10px 12px;text-align:center;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;">Qty</th>
            <th style="padding:10px 12px;text-align:right;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;">Rate</th>
            <th style="padding:10px 12px;text-align:right;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;">Total</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>
      <div style="text-align:right;padding:16px 0;border-top:2px solid #0a0a0a;">
        <span style="font-size:13px;color:#888;margin-right:16px;">Total</span>
        <span style="font-size:22px;font-weight:700;color:#0a0a0a;">$${Number(total).toFixed(2)}</span>
      </div>
      ${doc.notes ? `<div style="margin-top:16px;padding:14px;background:#f9f9f9;border-radius:6px;font-size:13px;color:#555;line-height:1.5;">${doc.notes}</div>` : ""}
    </div>
    <div style="padding:16px 32px;background:#f9f9f9;text-align:center;">
      <p style="margin:0;font-size:11px;color:#aaa;">Sent via SWFT</p>
    </div>
  </div>
</body>
</html>`;
}

// POST /api/messages/send — send email or SMS
router.post("/send", async (req, res, next) => {
  try {
    const { to, subject, body, customerId, customerName, type, quoteId, invoiceId } = req.body;
    const msgType = type || "email";

    // Get user profile
    const userDoc = await db.collection("users").doc(req.uid).get();
    const user = userDoc.exists ? userDoc.data() : {};

    if (msgType === "sms") {
      // ── SMS via Twilio ──
      if (!to) return res.status(400).json({ error: "Phone number is required" });
      if (!body) return res.status(400).json({ error: "Message body is required" });

      if (!user.twilioSubAccountSid || !user.twilioPhoneNumber) {
        return res.status(400).json({
          error: "SMS not configured. Please set up your Twilio account first.",
          code: "TWILIO_NOT_CONFIGURED",
        });
      }

      const result = await sendSms(
        user.twilioSubAccountSid,
        user.twilioAuthToken,
        user.twilioPhoneNumber,
        to,
        body
      );

      const msgRecord = {
        userId: req.uid,
        to,
        body: body || "",
        customerId: customerId || "",
        customerName: customerName || "",
        type: "sms",
        status: "sent",
        twilioMessageSid: result.sid,
        sentAt: Date.now(),
      };
      const docRef = await db.collection("messages").add(msgRecord);

      return res.json({ success: true, id: docRef.id, messageSid: result.sid });
    }

    // ── Email via Postmark ──
    if (!to || !subject) {
      return res.status(400).json({ error: "Recipient email and subject are required" });
    }

    const fromEmail = user.email || "noreply@swft-crm.com";
    const fromName = user.company || user.name || "SWFT";

    // Build email body — if a quote or invoice is attached, generate HTML
    let htmlBody = body || "<p>No content</p>";
    let attachedDocType = "";
    let attachedDocId = "";

    if (quoteId) {
      const quoteDoc = await db.collection("quotes").doc(quoteId).get();
      if (quoteDoc.exists && quoteDoc.data().userId === req.uid) {
        const quoteData = { id: quoteDoc.id, ...quoteDoc.data() };
        const docHtml = generateDocumentHtml(quoteData, "quote", user);
        htmlBody = (body ? `<div style="margin-bottom:24px;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;">${body}</div>` : "") + docHtml;
        attachedDocType = "quote";
        attachedDocId = quoteId;
      }
    } else if (invoiceId) {
      const invDoc = await db.collection("invoices").doc(invoiceId).get();
      if (invDoc.exists && invDoc.data().userId === req.uid) {
        const invData = { id: invDoc.id, ...invDoc.data() };
        const docHtml = generateDocumentHtml(invData, "invoice", user);
        htmlBody = (body ? `<div style="margin-bottom:24px;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;">${body}</div>` : "") + docHtml;
        attachedDocType = "invoice";
        attachedDocId = invoiceId;
      }
    }

    const result = await emailClient.sendEmail({
      From: `${fromName} <${fromEmail}>`,
      To: to,
      Subject: subject,
      HtmlBody: htmlBody,
      TextBody: body ? body.replace(/<[^>]*>/g, "") : "No content",
      MessageStream: "outbound",
    });

    const msgRecord = {
      userId: req.uid,
      to,
      subject,
      body: body || "",
      customerId: customerId || "",
      customerName: customerName || "",
      type: "email",
      status: "sent",
      postmarkId: result.MessageID,
      sentAt: Date.now(),
    };

    if (attachedDocType) {
      msgRecord.attachedDocType = attachedDocType;
      msgRecord.attachedDocId = attachedDocId;
    }

    const docRef = await db.collection("messages").add(msgRecord);

    // Update quote/invoice status to "sent" if attached
    if (attachedDocType === "quote" && attachedDocId) {
      await db.collection("quotes").doc(attachedDocId).update({ status: "sent", sentAt: Date.now() });
    } else if (attachedDocType === "invoice" && attachedDocId) {
      await db.collection("invoices").doc(attachedDocId).update({ status: "sent", sentAt: Date.now() });
    }

    res.json({ success: true, id: docRef.id, messageId: result.MessageID });
  } catch (err) {
    console.error("Message send error:", err);
    res.status(500).json({ error: err.message || "Failed to send message" });
  }
});

// GET /api/messages — list sent messages
router.get("/", async (req, res, next) => {
  try {
    const snap = await db.collection("messages").where("userId", "==", req.uid).get();
    let results = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    results.sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));
    res.json(results);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/messages/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await db.collection("messages").doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Message not found" });
    }
    await db.collection("messages").doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
