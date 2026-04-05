const router = require("express").Router();
const { db } = require("../firebase");
const multer = require("multer");
const { google } = require("googleapis");
const { sendSms } = require("../twilio");
const { getPlan } = require("../plans");
const { getUsage, incrementSms } = require("../usage");
const PDFDocument = require("pdfkit");

/**
 * Send email via user's connected Gmail account.
 */
async function sendViaGmail(user, to, subject, htmlBody, textBody, files) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || "https://goswft.com/api/auth/google/callback"
  );
  oauth2Client.setCredentials(user.gmailTokens);

  // Refresh token if expired
  const tokenInfo = await oauth2Client.getAccessToken();
  if (tokenInfo.token !== user.gmailTokens.access_token) {
    await db.collection("users").doc(user._uid).set({
      gmailTokens: { ...user.gmailTokens, access_token: tokenInfo.token },
    }, { merge: true });
  }

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const fromAddr = user.gmailAddress || user.email;
  const fromName = user.company || user.name || "SWFT";

  // Build MIME message
  const boundary = "swft_boundary_" + Date.now();
  let mime = "";
  mime += `From: ${fromName} <${fromAddr}>\r\n`;
  mime += `To: ${to}\r\n`;
  mime += `Subject: ${subject}\r\n`;
  mime += `MIME-Version: 1.0\r\n`;

  const hasAttachments = files && files.length > 0;

  if (hasAttachments) {
    mime += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
    mime += `--${boundary}\r\n`;
    mime += `Content-Type: multipart/alternative; boundary="${boundary}_alt"\r\n\r\n`;

    // Plain text part
    mime += `--${boundary}_alt\r\n`;
    mime += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
    mime += (textBody || "") + "\r\n\r\n";

    // HTML part
    mime += `--${boundary}_alt\r\n`;
    mime += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
    mime += (htmlBody || "") + "\r\n\r\n";
    mime += `--${boundary}_alt--\r\n\r\n`;

    // File attachments
    for (const file of files) {
      mime += `--${boundary}\r\n`;
      mime += `Content-Type: ${file.mimetype}; name="${file.originalname}"\r\n`;
      mime += `Content-Disposition: attachment; filename="${file.originalname}"\r\n`;
      mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
      mime += file.buffer.toString("base64") + "\r\n\r\n";
    }
    mime += `--${boundary}--`;
  } else {
    mime += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`;

    mime += `--${boundary}\r\n`;
    mime += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
    mime += (textBody || "") + "\r\n\r\n";

    mime += `--${boundary}\r\n`;
    mime += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
    mime += (htmlBody || "") + "\r\n\r\n";

    mime += `--${boundary}--`;
  }

  const encodedMessage = Buffer.from(mime)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const result = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encodedMessage },
  });

  return { messageId: result.data.id, threadId: result.data.threadId };
}

// Multer — store files in memory (max 10MB per file)
const ALLOWED_MIMES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "application/pdf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain", "text/csv",
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("File type not allowed"), false);
    }
  },
});

/**
 * Generate a PDF buffer for a quote or invoice.
 * Matches the frontend preview style: clean white layout, #8ab800 green accent.
 */
function generateDocumentPdf(doc, docType, user) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "LETTER", margin: 50 });
    const chunks = [];
    pdf.on("data", (chunk) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    const companyName = user.company || user.name || "SWFT";
    const tagline = user.phone
      ? `${user.phone}     ${user.address || ""}`
      : "simple. smart. swft.";
    const title = docType === "quote" ? "QUOTE" : "INVOICE";
    const items = doc.items || [];
    const GREEN = "#8ab800";

    // ── Company header ──
    let y = 50;
    pdf.fontSize(28).fill("#111111").text(companyName, 50, y, { continued: true });
    pdf.fill(GREEN).text(".", { continued: false });
    y += 36;
    pdf.fontSize(9).fill("#999999").text(tagline, 50, y);
    y += 24;

    // ── Document type with green underline ──
    pdf.fontSize(18).fill("#111111").text(title, 50, y);
    y += 26;
    pdf.moveTo(50, y).lineTo(560, y).strokeColor(GREEN).lineWidth(2).stroke();
    y += 16;

    // ── Info fields ──
    const fields = [
      { label: "Customer", value: doc.customerName || "—" },
      { label: "Service", value: doc.service || "—" },
      { label: "Address", value: doc.address || "—" },
    ];
    if (docType === "quote" && doc.scheduledDate) {
      fields.push({ label: "Scheduled", value: new Date(doc.scheduledDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) });
    }
    if (docType === "quote" && doc.expiresAt) {
      fields.push({ label: "Expires", value: new Date(doc.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) });
    }
    if (docType === "invoice" && doc.dueDate) {
      fields.push({ label: "Due Date", value: new Date(doc.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) });
    }

    for (const f of fields) {
      if (f.value === "—" && f.label !== "Customer") continue;
      pdf.fontSize(11).fill("#666666").text(f.label, 50, y);
      pdf.fontSize(12).fill("#111111").text(f.value, 200, y, { width: 360, align: "right" });
      y += 22;
    }
    y += 12;

    // ── Line Items header ──
    pdf.fontSize(9).fill("#999999").text("LINE ITEMS", 50, y);
    y += 16;
    const colX = { desc: 50, qty: 310, rate: 400, total: 490 };
    // Column headers
    pdf.fontSize(9).fill("#999999");
    pdf.text("DESCRIPTION", colX.desc, y);
    pdf.text("QTY", colX.qty, y, { width: 70, align: "center" });
    pdf.text("RATE", colX.rate, y, { width: 70, align: "right" });
    pdf.text("TOTAL", colX.total, y, { width: 70, align: "right" });
    y += 14;
    pdf.moveTo(50, y).lineTo(560, y).strokeColor("#e0e0e0").lineWidth(1).stroke();
    y += 8;

    // ── Line item rows ──
    for (const item of items) {
      const qty = Number(item.qty) || 1;
      const rate = Number(item.rate) || (Number(item.total) / qty) || 0;
      const total = Number(item.total) || (qty * rate) || 0;

      pdf.fontSize(12).fill("#111111");
      pdf.text(item.desc || item.description || "", colX.desc, y, { width: 250 });
      pdf.fill("#333333");
      pdf.text(String(qty), colX.qty, y, { width: 70, align: "center" });
      pdf.text("$" + rate.toFixed(2), colX.rate, y, { width: 70, align: "right" });
      pdf.fontSize(12).fill("#111111");
      pdf.text("$" + total.toFixed(2), colX.total, y, { width: 70, align: "right" });

      y += 26;
      pdf.moveTo(50, y).lineTo(560, y).strokeColor("#f0f0f0").lineWidth(0.5).stroke();
      y += 8;
    }

    // ── Totals ──
    y += 8;
    const grandTotal = Number(doc.total) || 0;
    pdf.fontSize(12).fill("#333333").text("Subtotal", 400, y, { width: 90, align: "right" });
    pdf.text("$" + grandTotal.toFixed(2), 490, y, { width: 70, align: "right" });
    y += 24;
    pdf.moveTo(400, y).lineTo(560, y).strokeColor("#111111").lineWidth(2).stroke();
    y += 10;
    pdf.fontSize(18).fill("#111111").text("Total", 400, y, { width: 80, align: "right" });
    pdf.text("$" + grandTotal.toFixed(2), 480, y, { width: 80, align: "right" });
    y += 36;

    // ── Notes ──
    if (doc.notes) {
      pdf.fontSize(9).fill("#999999").text("NOTES", 50, y);
      y += 14;
      pdf.fontSize(11).fill("#555555").text(doc.notes, 50, y, { width: 510 });
    }

    pdf.end();
  });
}

/**
 * Generate HTML email body for a quote or invoice attachment.
 */
function generateDocumentHtml(doc, docType, user) {
  const companyName = user.company || user.name || "SWFT";
  const title = docType === "quote" ? "Quote" : "Invoice";
  const items = doc.items || [];

  const itemRows = items
    .map(
      (item) => {
        const qty = Number(item.qty) || 1;
        const rate = Number(item.rate) || (Number(item.total) / qty) || 0;
        const total = Number(item.total) || (qty * rate) || 0;
        return `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;color:#333;">${item.desc || item.description || ""}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;color:#555;text-align:center;">${qty}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;color:#555;text-align:right;">$${rate.toFixed(2)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;color:#333;text-align:right;font-weight:600;">$${total.toFixed(2)}</td>
    </tr>`;
      }
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

// POST /api/messages/send — send email (with file attachments) or SMS
router.post("/send", upload.array("files", 10), async (req, res, next) => {
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

      // Enforce SMS cap based on user's plan
      const plan = getPlan(user.plan);
      if (plan.smsLimit !== Infinity) {
        const usage = await getUsage(req.uid);
        if (usage.smsCount >= plan.smsLimit) {
          return res.status(429).json({
            error: `SMS limit reached (${plan.smsLimit}/month on the ${plan.name} plan). Upgrade your plan for more SMS.`,
          });
        }
      }

      const result = await sendSms(to, body);

      await incrementSms(req.uid);

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

    // ── Email ──
    if (!to || !subject) {
      return res.status(400).json({ error: "Recipient email and subject are required" });
    }

    const fromEmail = user.email || "noreply@swft-crm.com";
    const fromName = user.company || user.name || "SWFT";

    // Build email body
    let htmlBody = body ? `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;white-space:pre-wrap;">${body}</div>` : "";
    let attachedDocType = "";
    let attachedDocId = "";

    // Build PDF file attachments for quotes/invoices
    const pdfFiles = [];

    if (quoteId) {
      const quoteDoc = await db.collection("quotes").doc(quoteId).get();
      if (quoteDoc.exists && quoteDoc.data().userId === req.uid) {
        const quoteData = { id: quoteDoc.id, ...quoteDoc.data() };
        if (quoteData.status === "sent") {
          return res.status(400).json({ error: "This quote has already been sent. Duplicate sends are not allowed." });
        }
        const pdfBuffer = await generateDocumentPdf(quoteData, "quote", user);
        const custName = (quoteData.customerName || "Customer").replace(/[^a-zA-Z0-9]/g, "-");
        pdfFiles.push({
          buffer: pdfBuffer,
          mimetype: "application/pdf",
          originalname: `Quote-${custName}.pdf`,
        });
        attachedDocType = "quote";
        attachedDocId = quoteId;
      }
    } else if (invoiceId) {
      const invDoc = await db.collection("invoices").doc(invoiceId).get();
      if (invDoc.exists && invDoc.data().userId === req.uid) {
        const invData = { id: invDoc.id, ...invDoc.data() };
        if (invData.status === "sent") {
          return res.status(400).json({ error: "This invoice has already been sent. Duplicate sends are not allowed." });
        }
        const pdfBuffer = await generateDocumentPdf(invData, "invoice", user);
        const custName = (invData.customerName || "Customer").replace(/[^a-zA-Z0-9]/g, "-");
        pdfFiles.push({
          buffer: pdfBuffer,
          mimetype: "application/pdf",
          originalname: `Invoice-${custName}.pdf`,
        });
        attachedDocType = "invoice";
        attachedDocId = invoiceId;
      }
    }

    if (!htmlBody) htmlBody = "<p>No content</p>";
    const textBody = body ? body.replace(/<[^>]*>/g, "") : "No content";

    // Merge uploaded files + generated PDF attachments
    const allFiles = [...(req.files || []), ...pdfFiles];
    const attachmentNames = allFiles.map(f => f.originalname);

    if (!user.gmailConnected || !user.gmailTokens) {
      return res.status(400).json({ error: "Gmail not connected. Connect your Gmail account in Settings to send emails." });
    }

    user._uid = req.uid;
    const sendResult = await sendViaGmail(user, to, subject, htmlBody, textBody, allFiles);

    const msgRecord = {
      userId: req.uid,
      to,
      subject,
      body: body || "",
      customerId: customerId || "",
      customerName: customerName || "",
      type: "email",
      status: "sent",
      sentVia: "gmail",
      gmailMessageId: sendResult.messageId,
      gmailThreadId: sendResult.threadId,
      sentAt: Date.now(),
    };
    if (attachedDocType) {
      msgRecord.attachedDocType = attachedDocType;
      msgRecord.attachedDocId = attachedDocId;
    }
    if (attachmentNames.length) {
      msgRecord.attachments = attachmentNames;
    }

    const docRef = await db.collection("messages").add(msgRecord);

    // Update quote/invoice status to "sent" if attached
    if (attachedDocType === "quote" && attachedDocId) {
      await db.collection("quotes").doc(attachedDocId).update({ status: "sent", sentAt: Date.now() });
    } else if (attachedDocType === "invoice" && attachedDocId) {
      await db.collection("invoices").doc(attachedDocId).update({ status: "sent", sentAt: Date.now() });
    }

    res.json({ success: true, id: docRef.id, sentVia: "gmail" });
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

// POST /api/messages/sync-gmail — pull recent inbound emails from Gmail
router.post("/sync-gmail", async (req, res, next) => {
  try {
    const userDoc = await db.collection("users").doc(req.uid).get();
    const user = userDoc.exists ? userDoc.data() : {};

    if (!user.gmailConnected || !user.gmailTokens) {
      return res.json({ synced: 0, message: "Gmail not connected" });
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || "https://goswft.com/api/auth/google/callback"
    );
    oauth2Client.setCredentials(user.gmailTokens);

    // Refresh token if needed
    const tokenInfo = await oauth2Client.getAccessToken();
    if (tokenInfo.token !== user.gmailTokens.access_token) {
      await db.collection("users").doc(req.uid).set({
        gmailTokens: { ...user.gmailTokens, access_token: tokenInfo.token },
      }, { merge: true });
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Get customer emails for matching
    const custSnap = await db.collection("customers").where("userId", "==", req.uid).get();
    const customersByEmail = {};
    custSnap.docs.forEach(d => {
      const data = d.data();
      if (data.email) customersByEmail[data.email.toLowerCase()] = { id: d.id, name: data.name || "" };
    });

    if (Object.keys(customersByEmail).length === 0) {
      return res.json({ synced: 0, message: "No customers with emails" });
    }

    // Get existing Gmail message IDs to avoid duplicates
    const existingSnap = await db.collection("messages")
      .where("userId", "==", req.uid)
      .where("direction", "==", "inbound")
      .where("sentVia", "==", "gmail")
      .get();
    const existingGmailIds = new Set(existingSnap.docs.map(d => d.data().gmailMessageId).filter(Boolean));

    // Search Gmail for recent messages from customers (last 3 days)
    const query = Object.keys(customersByEmail).map(e => `from:${e}`).join(" OR ");
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: `${query} newer_than:3d`,
      maxResults: 50,
    });

    if (!listRes.data.messages || !listRes.data.messages.length) {
      return res.json({ synced: 0 });
    }

    let synced = 0;
    for (const msg of listRes.data.messages) {
      if (existingGmailIds.has(msg.id)) continue;

      const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" });
      const headers = full.data.payload.headers || [];
      const fromHeader = headers.find(h => h.name.toLowerCase() === "from");
      const subjectHeader = headers.find(h => h.name.toLowerCase() === "subject");

      // Extract email from "Name <email>" format
      const fromRaw = fromHeader ? fromHeader.value : "";
      const emailMatch = fromRaw.match(/<(.+?)>/) || [null, fromRaw];
      const fromEmail = (emailMatch[1] || "").toLowerCase().trim();

      const cust = customersByEmail[fromEmail];
      if (!cust) continue; // Not from a known customer

      // Extract body
      let bodyText = "";
      const parts = full.data.payload.parts || [];
      if (parts.length) {
        const textPart = parts.find(p => p.mimeType === "text/plain");
        if (textPart && textPart.body && textPart.body.data) {
          bodyText = Buffer.from(textPart.body.data, "base64url").toString("utf8");
        }
      } else if (full.data.payload.body && full.data.payload.body.data) {
        bodyText = Buffer.from(full.data.payload.body.data, "base64url").toString("utf8");
      }

      // Get date
      const dateHeader = headers.find(h => h.name.toLowerCase() === "date");
      const sentAt = dateHeader ? new Date(dateHeader.value).getTime() : Date.now();

      await db.collection("messages").add({
        userId: req.uid,
        customerId: cust.id,
        customerName: cust.name,
        from: fromEmail,
        to: "inbound",
        subject: subjectHeader ? subjectHeader.value : "",
        body: bodyText.substring(0, 5000),
        type: "email",
        direction: "inbound",
        status: "received",
        sentVia: "gmail",
        gmailMessageId: msg.id,
        gmailThreadId: msg.threadId,
        sentAt,
      });
      synced++;
    }

    res.json({ synced });
  } catch (err) {
    console.error("Gmail sync error:", err);
    res.status(500).json({ error: err.message || "Gmail sync failed" });
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

/**
 * Twilio incoming SMS webhook handler (no auth — called by Twilio directly).
 */
async function twilioIncomingHandler(req, res) {
  try {
    const twilio = require("twilio");
    const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
    if (twilioAuthToken) {
      const signature = req.headers['x-twilio-signature'] || '';
      const url = `${process.env.APP_URL || 'https://goswft.com'}/api/webhooks/twilio/sms`;
      if (!twilio.validateRequest(twilioAuthToken, signature, url, req.body)) {
        return res.status(403).type("text/xml").send("<Response></Response>");
      }
    }

    const from = req.body.From;
    const body = req.body.Body;
    const msgSid = req.body.MessageSid;

    if (!from || !body) {
      return res.type("text/xml").send("<Response></Response>");
    }

    const digits = from.replace(/\D/g, "");
    const custSnap = await db.collection("customers").get();
    let matched = null;
    for (const doc of custSnap.docs) {
      const data = doc.data();
      const custDigits = (data.phone || "").replace(/\D/g, "");
      if (custDigits && (custDigits === digits || custDigits === digits.slice(1) || "1" + custDigits === digits)) {
        matched = { customerId: doc.id, customerName: data.name || "", userId: data.userId };
        break;
      }
    }

    if (!matched) {
      console.log("Incoming SMS from unknown number (not matched to customer)");
      return res.type("text/xml").send("<Response></Response>");
    }

    await db.collection("messages").add({
      userId: matched.userId,
      customerId: matched.customerId,
      customerName: matched.customerName,
      from: from,
      to: "inbound",
      body: body,
      type: "sms",
      direction: "inbound",
      status: "received",
      twilioMessageSid: msgSid || "",
      sentAt: Date.now(),
    });

    res.type("text/xml").send("<Response></Response>");
  } catch (err) {
    console.error("Twilio incoming webhook error:", err);
    res.type("text/xml").send("<Response></Response>");
  }
}

module.exports = { router, twilioIncomingHandler };
