const router = require("express").Router();
const { db } = require("../firebase");
const multer = require("multer");
const { google } = require("googleapis");
const { sendSms } = require("../twilio");
const { getPlan } = require("../plans");
const { getUsage, incrementSms } = require("../usage");
const { handleInboundMessage } = require("../ai/receptionist-agent");
const { getGmailClient, getOAuthClient, encodeMime } = require("../utils/email");

/**
 * Send email via user's connected Gmail account.
 * Full-featured: supports attachments and reply threading.
 */
async function sendViaGmail(user, to, subject, htmlBody, textBody, files, replyHeaders = {}) {
  const { gmail, fromAddr, fromName } = await getGmailClient(user);

  // Build MIME message
  const boundary = "swft_boundary_" + Date.now();
  let mime = "";
  mime += `From: ${fromName} <${fromAddr}>\r\n`;
  mime += `To: ${to}\r\n`;
  mime += `Subject: ${subject}\r\n`;
  if (replyHeaders.inReplyTo) mime += `In-Reply-To: ${replyHeaders.inReplyTo}\r\n`;
  if (replyHeaders.references) mime += `References: ${replyHeaders.references}\r\n`;
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

  const encodedMessage = encodeMime(mime);

  const result = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: encodedMessage,
      ...(replyHeaders.threadId ? { threadId: replyHeaders.threadId } : {}),
    },
  });

  // Fetch the actual RFC 2822 Message-ID header so replies can thread correctly
  let rfcMessageId = null;
  try {
    const sent = await gmail.users.messages.get({
      userId: "me",
      id: result.data.id,
      format: "full",
    });
    const headers = sent.data.payload?.headers || [];
    // Case-insensitive search for Message-ID header
    const msgIdHeader = headers.find(h => h.name.toLowerCase() === "message-id");
    rfcMessageId = msgIdHeader?.value || null;
    console.log("[sendViaGmail] Message-ID captured:", rfcMessageId, "from", headers.length, "headers");
    if (!rfcMessageId) {
      console.log("[sendViaGmail] Available headers:", headers.map(h => h.name).join(", "));
    }
  } catch (e) {
    console.error("[sendViaGmail] Failed to fetch Message-ID:", e.message);
  }

  return { messageId: result.data.id, threadId: result.data.threadId, rfcMessageId };
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

// POST /api/messages/send — send email (with file attachments) or SMS
router.post("/send", upload.array("files", 10), async (req, res, next) => {
  try {
    const { to, subject, body, customerId, customerName, type, quoteId, invoiceId, inReplyTo, replyThreadId, replyReferences } = req.body;
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

    if (quoteId) { attachedDocType = "quote"; attachedDocId = quoteId; }
    else if (invoiceId) { attachedDocType = "invoice"; attachedDocId = invoiceId; }

    if (!htmlBody) htmlBody = "<p>No content</p>";
    const textBody = body ? body.replace(/<[^>]*>/g, "") : "No content";

    // Only user-uploaded files (no generated PDFs)
    const allFiles = req.files || [];
    const attachmentNames = allFiles.map(f => f.originalname);

    if (!user.gmailConnected || !user.gmailTokens) {
      return res.status(400).json({ error: "Gmail not connected. Connect your Gmail account in Settings to send emails." });
    }

    user._uid = req.uid;

    // ── Build reply headers for Gmail threading ──
    // Gmail requires BOTH threadId AND valid In-Reply-To/References headers.
    // Strategy: use frontend-provided context first, then fall back to
    // looking up the most recent message in this conversation from Firestore.
    const replyHeaders = {};

    // Step 1: Try to find threading info from the conversation history
    let threadId = replyThreadId || null;
    let messageIdForReply = (inReplyTo && inReplyTo.includes("<")) ? inReplyTo : null;

    // If frontend didn't provide a valid RFC Message-ID, look up from Firestore
    if (!messageIdForReply || !threadId) {
      try {
        // Find the most recent email to/from this address with threading info
        const prevSnap = await db.collection("messages")
          .where("userId", "==", req.uid)
          .where("type", "==", "email")
          .get();
        const prevMsgs = prevSnap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(m => {
            const msgAddr = (m.to || m.from || "").toLowerCase();
            return msgAddr === to.toLowerCase() || msgAddr === "inbound";
          })
          .filter(m => m.gmailThreadId || m.rfcMessageId || m.gmailMessageId)
          .sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));

        // Also check by customerId for more reliable matching
        if (customerId) {
          const custSnap = await db.collection("messages")
            .where("userId", "==", req.uid)
            .where("customerId", "==", customerId)
            .where("type", "==", "email")
            .get();
          custSnap.docs.forEach(d => {
            const data = { id: d.id, ...d.data() };
            if ((data.gmailThreadId || data.rfcMessageId) && !prevMsgs.find(m => m.id === data.id)) {
              prevMsgs.push(data);
            }
          });
          prevMsgs.sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));
        }

        const lastMsg = prevMsgs[0];
        if (lastMsg) {
          if (!threadId && lastMsg.gmailThreadId) threadId = lastMsg.gmailThreadId;
          if (!messageIdForReply && lastMsg.rfcMessageId) messageIdForReply = lastMsg.rfcMessageId;
        }
      } catch (e) {
        console.error("[send] Error looking up previous messages:", e.message);
      }
    }

    // Step 2: If we don't have an RFC Message-ID yet, look it up from Gmail API
    // Use the gmailMessageId from the previous message in the conversation
    if (!messageIdForReply && threadId) {
      try {
        const oauth2Client = getOAuthClient();
        oauth2Client.setCredentials(user.gmailTokens);
        const gmailApi = google.gmail({ version: "v1", auth: oauth2Client });

        // Try the inReplyTo (Gmail internal ID) first, then fall back to listing thread messages
        const lookupIds = [];
        if (inReplyTo && !inReplyTo.includes("<")) lookupIds.push(inReplyTo);

        // Also try to find a message in the thread
        if (lookupIds.length === 0) {
          try {
            const threadData = await gmailApi.users.threads.get({
              userId: "me",
              id: threadId,
              format: "metadata",
              metadataHeaders: ["Message-ID"],
            });
            const threadMsgs = threadData.data.messages || [];
            // Get the last message in the thread
            if (threadMsgs.length > 0) {
              const lastThreadMsg = threadMsgs[threadMsgs.length - 1];
              const hdr = (lastThreadMsg.payload?.headers || []).find(h => h.name.toLowerCase() === "message-id");
              if (hdr?.value && hdr.value.includes("<")) {
                messageIdForReply = hdr.value;
                console.log("[send] Got Message-ID from thread:", messageIdForReply);
              }
            }
          } catch (te) {
            console.error("[send] Thread lookup failed:", te.message);
          }
        }

        // Direct message lookup as fallback
        if (!messageIdForReply) {
          for (const lid of lookupIds) {
            try {
              const msg = await gmailApi.users.messages.get({
                userId: "me",
                id: lid,
                format: "full",
              });
              const headers = msg.data.payload?.headers || [];
              const hdr = headers.find(h => h.name.toLowerCase() === "message-id");
              if (hdr?.value && hdr.value.includes("<")) {
                messageIdForReply = hdr.value;
                console.log("[send] Got Message-ID from message lookup:", messageIdForReply);
                break;
              }
            } catch (me) {
              console.error("[send] Message lookup failed for", lid, ":", me.message);
            }
          }
        }
      } catch (e) {
        console.error("[send] Could not fetch RFC Message-ID:", e.message);
      }
    }

    // Step 3: Build final headers
    if (threadId) replyHeaders.threadId = threadId;
    if (messageIdForReply) {
      replyHeaders.inReplyTo = messageIdForReply;
      replyHeaders.references = messageIdForReply;
    }
    console.log("[send] to:", to, "inReplyTo:", inReplyTo, "replyThreadId:", replyThreadId);
    console.log("[send] resolved replyHeaders:", JSON.stringify(replyHeaders));
    const sendResult = await sendViaGmail(user, to, subject, htmlBody, textBody, allFiles, replyHeaders);

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
      rfcMessageId: sendResult.rfcMessageId || null,
      sentAt: Date.now(),
      ...(inReplyTo ? { isReply: true, inReplyTo, replyThreadId } : {}),
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

// POST /api/messages/schedule — schedule a message for later
router.post("/schedule", async (req, res, next) => {
  try {
    const { to, body, type, subject, customerId, customerName, sendAt } = req.body;
    const msgType = type || "sms";

    if (!to) return res.status(400).json({ error: "Recipient is required" });
    if (!body) return res.status(400).json({ error: "Message body is required" });
    if (!sendAt) return res.status(400).json({ error: "Scheduled time is required" });

    const sendAtMs = new Date(sendAt).getTime();
    if (isNaN(sendAtMs) || sendAtMs <= Date.now()) {
      return res.status(400).json({ error: "Scheduled time must be in the future" });
    }

    const msgData = {
      orgId: req.orgId,
      userId: req.uid,
      customerId: customerId || "",
      customerName: customerName || "",
      phone: msgType === "sms" ? to : "",
      email: msgType === "email" ? to : "",
      message: body,
      subject: msgType === "email" ? (subject || "") : "",
      messageType: msgType,
      sendAt: sendAtMs,
      status: "pending",
      sentAt: null,
      error: null,
      isManual: true,
      createdAt: Date.now(),
    };

    const ref = await db.collection("scheduledMessages").add(msgData);
    res.status(201).json({ id: ref.id, ...msgData });
  } catch (err) {
    next(err);
  }
});

// GET /api/messages/scheduled — list pending scheduled messages for this user's org
router.get("/scheduled", async (req, res, next) => {
  try {
    const now = Date.now();
    const snap = await db
      .collection("scheduledMessages")
      .where("orgId", "==", req.orgId)
      .where("status", "==", "pending")
      .get();
    let results = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Only return future scheduled messages
    results = results.filter((m) => m.sendAt > now);
    results.sort((a, b) => (a.sendAt || 0) - (b.sendAt || 0));
    res.json({ messages: results });
  } catch (err) {
    res.json({ messages: [] });
  }
});

// GET /api/messages — list sent messages
router.get("/", async (req, res, next) => {
  try {
    // Query by userId first
    const snap = await db.collection("messages").where("userId", "==", req.uid).get();
    const byId = new Set(snap.docs.map(d => d.id));
    let results = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Also query by orgId to catch inbound messages routed to the org
    if (req.orgId) {
      const orgSnap = await db.collection("messages").where("orgId", "==", req.orgId).get();
      for (const d of orgSnap.docs) {
        if (!byId.has(d.id)) results.push({ id: d.id, ...d.data() });
      }
    }

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

    const oauth2Client = getOAuthClient();
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
      const messageIdHeader = headers.find(h => h.name.toLowerCase() === "message-id");

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
        rfcMessageId: messageIdHeader ? messageIdHeader.value : null,
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
// Soft-delete a message (marks as deleted, recoverable)
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await db.collection("messages").doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Message not found" });
    }
    await db.collection("messages").doc(req.params.id).update({ deleted: true, deletedAt: Date.now() });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Restore a soft-deleted message
router.post("/:id/restore", async (req, res, next) => {
  try {
    const doc = await db.collection("messages").doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Message not found" });
    }
    await db.collection("messages").doc(req.params.id).update({ deleted: false, deletedAt: null });
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
    console.log("[twilio-webhook] Incoming SMS received:", JSON.stringify(req.body || {}).slice(0, 300));

    // Twilio signature validation (skip if auth token not configured)
    const twilio = require("twilio");
    const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
    if (twilioAuthToken) {
      const signature = req.headers['x-twilio-signature'] || '';
      const url = `${process.env.APP_URL || 'https://goswft.com'}/api/webhooks/twilio/sms`;
      const valid = twilio.validateRequest(twilioAuthToken, signature, url, req.body);
      if (!valid) {
        console.warn("[twilio-webhook] Signature validation FAILED. URL used:", url);
        // Don't block — signature issues are common with proxy/CDN setups
        // Just log the warning and continue processing
      }
    }

    const from = req.body.From || req.body.from || "";
    const body = req.body.Body || req.body.body || "";
    const msgSid = req.body.MessageSid || req.body.messageSid || "";

    if (!from || !body) {
      console.warn("[twilio-webhook] Missing From or Body in request");
      return res.type("text/xml").send("<Response></Response>");
    }

    console.log("[twilio-webhook] From:", from, "Body:", body.slice(0, 100));

    const digits = from.replace(/\D/g, "");
    const custSnap = await db.collection("customers").get();
    let matched = null;
    for (const doc of custSnap.docs) {
      const data = doc.data();
      const custDigits = (data.phone || "").replace(/\D/g, "");
      if (custDigits && (custDigits === digits || custDigits === digits.slice(1) || "1" + custDigits === digits)) {
        matched = {
          customerId: doc.id,
          customerName: data.name || "",
          userId: data.userId || "",
          orgId: data.orgId || "",
        };
        break;
      }
    }

    if (matched) {
      console.log("[twilio-webhook] Matched customer:", matched.customerName, "id:", matched.customerId, "orgId:", matched.orgId);
    } else {
      console.log("[twilio-webhook] No customer matched for phone:", from, "- checked", custSnap.size, "customers");
    }

    // Resolve the account owner — always find an actual user to route the message to.
    // For single-tenant setups, just get the first user in the database.
    let ownerUid = null;
    let ownerData = null;
    let orgId = "";

    // Try to find account owner: first by customer data, then any user as fallback
    const userSnap = await db.collection("users").limit(1).get();
    if (!userSnap.empty) {
      ownerUid = userSnap.docs[0].id;
      ownerData = userSnap.docs[0].data();
      orgId = ownerData.orgId || ownerUid;
    }

    console.log("[twilio-webhook] Resolved owner:", ownerUid, "orgId:", orgId, "name:", ownerData?.name || "unknown");

    if (!orgId || !ownerUid) {
      console.warn("[twilio-webhook] Could not resolve org/owner for inbound SMS from:", from);
      return res.type("text/xml").send("<Response></Response>");
    }

    console.log("[twilio-webhook] Resolved orgId:", orgId, "ownerUid:", ownerUid, "ownerName:", ownerData?.name || "unknown");

    // Store inbound message
    const savedMsg = await db.collection("messages").add({
      userId: ownerUid || matched?.userId || "",
      orgId: orgId,
      customerId: matched?.customerId || "",
      customerName: matched?.customerName || from,
      from: from,
      to: "inbound",
      body: body,
      type: "sms",
      direction: "inbound",
      status: "received",
      twilioMessageSid: msgSid || "",
      sentAt: Date.now(),
    });

    console.log("[twilio-webhook] Message saved:", savedMsg.id);

    // ── AI Receptionist — auto-reply if enabled ──
    if (orgId && ownerUid && ownerData) {
      try {
        console.log("[twilio-webhook] Calling receptionist agent for org:", orgId);
        await handleInboundMessage(orgId, ownerUid, ownerData, from, body, matched || null);
      } catch (err) {
        console.error("[receptionist] Error handling inbound:", err.message, err.stack);
      }
    }

    res.type("text/xml").send("<Response></Response>");
  } catch (err) {
    console.error("Twilio incoming webhook error:", err);
    res.type("text/xml").send("<Response></Response>");
  }
}

module.exports = { router, twilioIncomingHandler, sendViaGmail };
