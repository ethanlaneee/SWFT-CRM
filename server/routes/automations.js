const router = require("express").Router();
const crypto = require("crypto");
const { db } = require("../firebase");
const { sendSms } = require("../twilio");

const APP_URL = process.env.APP_URL || "https://goswft.com";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve template variables in a message string.
 */
function resolveTemplate(template, vars) {
  let msg = template || "";
  for (const [key, val] of Object.entries(vars)) {
    msg = msg.replace(new RegExp(`{{${key}}}`, "g"), val || "");
  }
  return msg;
}

/**
 * Send an email for an automated message.
 * Tries Gmail (nodemailer) if org user has gmailTokens, falls back to Postmark.
 */
async function sendAutomationEmail(orgUser, to, subject, body) {
  const fromName = orgUser.company || orgUser.name || "SWFT";
  const fromEmail = orgUser.email || "noreply@swft-crm.com";

  if (orgUser.gmailConnected && orgUser.gmailTokens) {
    const { google } = require("googleapis");
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || "https://goswft.com/api/auth/google/callback"
    );
    oauth2Client.setCredentials(orgUser.gmailTokens);
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const boundary = "swft_auto_" + Date.now();
    let mime = "";
    mime += `From: ${fromName} <${orgUser.gmailAddress || fromEmail}>\r\n`;
    mime += `To: ${to}\r\n`;
    mime += `Subject: ${subject}\r\n`;
    mime += `MIME-Version: 1.0\r\n`;
    mime += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`;
    mime += `--${boundary}\r\n`;
    mime += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
    mime += body + "\r\n\r\n";
    mime += `--${boundary}\r\n`;
    mime += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
    mime += `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;white-space:pre-wrap;">${body}</div>\r\n\r\n`;
    mime += `--${boundary}--`;

    const encoded = Buffer.from(mime)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await gmail.users.messages.send({ userId: "me", requestBody: { raw: encoded } });
    return;
  }

  // Gmail not connected — throw so message is marked failed, not sent
  throw new Error("Gmail not connected. Connect Gmail in Settings to send automation emails.");
}

// ── Exported worker functions ────────────────────────────────────────────────

/**
 * Evaluate conditions against event context.
 * Returns true if all conditions pass (AND logic).
 */
function evaluateConditions(conditions, context) {
  if (!conditions || !Array.isArray(conditions) || conditions.length === 0) return true;
  for (const c of conditions) {
    const actual = context[c.field];
    const expected = c.value;
    switch (c.operator) {
      case "gt":   if (!(Number(actual) > Number(expected))) return false; break;
      case "gte":  if (!(Number(actual) >= Number(expected))) return false; break;
      case "lt":   if (!(Number(actual) < Number(expected))) return false; break;
      case "lte":  if (!(Number(actual) <= Number(expected))) return false; break;
      case "eq":   if (String(actual).toLowerCase() !== String(expected).toLowerCase()) return false; break;
      case "neq":  if (String(actual).toLowerCase() === String(expected).toLowerCase()) return false; break;
      case "contains": if (!String(actual).toLowerCase().includes(String(expected).toLowerCase())) return false; break;
      default: break;
    }
  }
  return true;
}

/**
 * Called when a quote is sent or invoice is paid.
 * Creates scheduledMessages for every matching enabled automation rule.
 *
 * @param {string} orgId
 * @param {string} trigger  "quote_sent" | "invoice_sent" | "invoice_paid"
 * @param {{ id: string, name: string, phone: string, email: string, total?: number, service?: string, tags?: string[] }} customer
 */
async function triggerAutomation(orgId, trigger, customer) {
  try {
    const snap = await db
      .collection("automations")
      .where("orgId", "==", orgId)
      .where("trigger", "==", trigger)
      .where("enabled", "==", true)
      .get();

    if (snap.empty) return;

    // Fetch org owner user doc for company name
    const usersSnap = await db
      .collection("users")
      .where("orgId", "==", orgId)
      .where("role", "==", "owner")
      .limit(1)
      .get();

    // Fallback: try fetching the user doc where uid == orgId (solo user pattern)
    let orgUser = {};
    if (!usersSnap.empty) {
      orgUser = usersSnap.docs[0].data();
    } else {
      const ownerDoc = await db.collection("users").doc(orgId).get();
      if (ownerDoc.exists) orgUser = ownerDoc.data();
    }

    const companyName = orgUser.company || orgUser.name || "";
    const now = Date.now();
    const batch = db.batch();

    for (const autoDoc of snap.docs) {
      const rule = autoDoc.data();

      // Evaluate conditions — skip this rule if conditions don't match
      if (rule.conditions && rule.conditions.length > 0) {
        const ctx = {
          total: customer.total || 0,
          amount: customer.total || 0,
          service: customer.service || "",
          name: customer.name || "",
          email: customer.email || "",
          tags: (customer.tags || []).join(","),
        };
        if (!evaluateConditions(rule.conditions, ctx)) {
          console.log(`[automation] Skipping "${rule.name}" — conditions not met`);
          continue;
        }
      }

      // Calculate sendAt: delayDays from now, at the configured time (default 9:00 AM)
      const sendAtTime = rule.sendAtTime || "09:00";
      const [hours, minutes] = sendAtTime.split(":").map(Number);
      const targetDate = new Date(now + (rule.delayDays ?? 3) * 86400000);
      targetDate.setHours(hours, minutes, 0, 0);
      // If the computed time is already in the past (e.g. 0 delay, past 9am), send next day at that time
      const sendAt = targetDate.getTime() <= now ? targetDate.getTime() + 86400000 : targetDate.getTime();

      let surveyToken = null;
      let resolvedMessage = rule.messageTemplate || "";

      const vars = {
        customer_name: customer.name || "",
        company_name: companyName,
        link: "",
        survey_link: "",
      };

      if (rule.isSurvey) {
        surveyToken = crypto.randomBytes(16).toString("hex");
        const surveyLink = `${APP_URL}/swft-survey?t=${surveyToken}`;
        vars.link = surveyLink;
        vars.survey_link = surveyLink;
      }

      resolvedMessage = resolveTemplate(resolvedMessage, vars);

      // Resolve subject template too
      const resolvedSubject = rule.emailSubject
        ? resolveTemplate(rule.emailSubject, vars)
        : "";

      const msgData = {
        orgId,
        automationId: autoDoc.id,
        automationName: rule.name || "",
        trigger,
        customerId: customer.id || "",
        customerName: customer.name || "",
        phone: customer.phone || "",
        email: customer.email || "",
        message: resolvedMessage,
        subject: resolvedSubject,
        messageType: rule.messageType || "sms",
        sendAt,
        status: "pending",
        sentAt: null,
        error: null,
        isSurvey: rule.isSurvey || false,
        surveyToken,
        surveyRating: null,
        surveyCompletedAt: null,
        followUpSent: false,
        createdAt: now,
      };

      const newRef = db.collection("scheduledMessages").doc();
      batch.set(newRef, msgData);
    }

    await batch.commit();
  } catch (err) {
    console.error("triggerAutomation error:", err);
  }
}

/**
 * Background worker — runs every 30 seconds.
 * Picks up pending + retryable messages whose sendAt has passed.
 * Retries failed messages up to 3 times with exponential backoff.
 */
async function processScheduledMessages() {
  const now = Date.now();

  // Pick up pending messages ready to send
  const pendingSnap = await db
    .collection("scheduledMessages")
    .where("status", "==", "pending")
    .where("sendAt", "<=", now)
    .limit(20)
    .get();

  // Pick up failed messages eligible for retry (retryCount < 3, retryAfter <= now)
  const retrySnap = await db
    .collection("scheduledMessages")
    .where("status", "==", "retrying")
    .where("retryAfter", "<=", now)
    .limit(10)
    .get();

  const allDocs = [...pendingSnap.docs, ...retrySnap.docs];
  if (!allDocs.length) return;

  console.log(`[automation worker] Processing ${allDocs.length} messages`);

  for (const msgDoc of allDocs) {
    const msg = msgDoc.data();
    const ref = msgDoc.ref;
    const retryCount = msg.retryCount || 0;

    try {
      // Fetch org user for email sending
      const usersSnap = await db
        .collection("users")
        .where("orgId", "==", msg.orgId)
        .where("role", "==", "owner")
        .limit(1)
        .get();

      let orgUser = {};
      let ownerUid = msg.userId || msg.orgId;
      if (!usersSnap.empty) {
        orgUser = usersSnap.docs[0].data();
        ownerUid = usersSnap.docs[0].id;
      } else {
        const ownerDoc = await db.collection("users").doc(msg.orgId).get();
        if (ownerDoc.exists) orgUser = ownerDoc.data();
      }

      if (msg.messageType === "tag_customer") {
        // Add tags to the customer document
        if (!msg.customerId) throw new Error("No customer ID for tagging");
        const tags = (msg.message || "").split(",").map(t => t.trim()).filter(Boolean);
        if (tags.length === 0) throw new Error("No tags specified");
        const custDoc = await db.collection("customers").doc(msg.customerId).get();
        if (custDoc.exists) {
          const existing = custDoc.data().tags || [];
          const merged = [...new Set([...existing, ...tags])];
          await db.collection("customers").doc(msg.customerId).update({ tags: merged });
        }
      } else if (msg.messageType === "sms") {
        if (!msg.phone) throw new Error("No phone number for SMS");
        await sendSms(msg.phone, msg.message);
      } else if (msg.messageType === "notification") {
        // Internal notification — create in notifications collection
        await db.collection("notifications").add({
          orgId: msg.orgId,
          userId: ownerUid,
          type: "automation",
          title: msg.subject || "Automation Alert",
          message: msg.message,
          customerId: msg.customerId || "",
          customerName: msg.customerName || "",
          automationId: msg.automationId || "",
          read: false,
          createdAt: Date.now(),
        });
      } else if (msg.messageType === "email") {
        if (!msg.email) throw new Error("No email address for email");
        const companyName = orgUser.company || orgUser.name || "SWFT";
        const emailSubject = msg.subject || `Message from ${companyName}`;
        await sendAutomationEmail(
          orgUser,
          msg.email,
          emailSubject,
          msg.message
        );
      } else {
        throw new Error(`Unknown message type: ${msg.messageType}`);
      }

      // ── Success ──
      await ref.update({ status: "sent", sentAt: Date.now(), error: null });
      console.log(`[automation worker] Sent ${msgDoc.id} (${msg.messageType}) to ${msg.phone || msg.email}`);

      // Create a record in the messages collection so it shows in the chat thread
      // Only for sms/email — notifications and tags aren't messages
      if (msg.messageType === "sms" || msg.messageType === "email") {
        const msgRecord = {
          userId: ownerUid,
          orgId: msg.orgId,
          to: msg.messageType === "sms" ? msg.phone : msg.email,
          body: msg.message,
          customerId: msg.customerId || "",
          customerName: msg.customerName || "",
          type: msg.messageType,
          status: "sent",
          sentVia: msg.messageType === "sms" ? "twilio" : "gmail",
          sentAt: Date.now(),
          scheduledMessageId: msgDoc.id,
          isAutomation: !!msg.automationId,
        };
        if (msg.messageType === "email") {
          const companyName = orgUser.company || orgUser.name || "SWFT";
          msgRecord.subject = msg.subject || `Message from ${companyName}`;
        }
        await db.collection("messages").add(msgRecord);
      }

    } catch (err) {
      console.error(`[automation worker] Failed ${msgDoc.id} (attempt ${retryCount + 1}):`, err.message);

      if (retryCount < 2) {
        // Retry with exponential backoff: 1min, 5min, then fail
        const backoffMs = retryCount === 0 ? 60000 : 300000;
        await ref.update({
          status: "retrying",
          retryCount: retryCount + 1,
          retryAfter: Date.now() + backoffMs,
          error: err.message || "Unknown error",
          lastAttempt: Date.now(),
        }).catch(() => {});
      } else {
        // Final failure after 3 attempts
        await ref.update({
          status: "failed",
          retryCount: retryCount + 1,
          error: err.message || "Unknown error",
          lastAttempt: Date.now(),
        }).catch(() => {});
      }
    }
  }
}

// ── CRUD Routes ──────────────────────────────────────────────────────────────

// GET /api/automations — list all automation rules for org
router.get("/", async (req, res, next) => {
  try {
    console.log("[automations] GET list — uid:", req.uid, "orgId:", req.orgId);
    // Query by orgId first, fall back to userId for backward compat
    let snap = await db
      .collection("automations")
      .where("orgId", "==", req.orgId)
      .get();
    // If nothing found by orgId and orgId !== uid, also check userId
    if (snap.empty && req.orgId !== req.uid) {
      snap = await db
        .collection("automations")
        .where("orgId", "==", req.uid)
        .get();
    }
    // Also check for automations stored with userId field (legacy)
    if (snap.empty) {
      snap = await db
        .collection("automations")
        .where("userId", "==", req.uid)
        .get();
    }
    const results = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    console.log("[automations] Found", results.length, "rules");
    res.json({ automations: results });
  } catch (err) {
    console.error("[automations] GET error:", err.message);
    next(err);
  }
});

// GET /api/automations/pending — list last 50 pending/recent scheduled messages
router.get("/pending", async (req, res, next) => {
  try {
    const snap = await db
      .collection("scheduledMessages")
      .where("orgId", "==", req.orgId)
      .get();
    let results = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    results = results.slice(0, 50);
    res.json({ messages: results });
  } catch (err) {
    // If scheduledMessages collection doesn't exist yet, return empty
    console.error("[automations] pending error:", err.message);
    res.json({ messages: [] });
  }
});

// POST /api/automations — create automation rule
router.post("/", async (req, res, next) => {
  try {
    const {
      name,
      trigger,
      delayDays,
      messageType,
      messageTemplate,
      enabled,
      isSurvey,
      surveyThreshold,
      followUpTemplate,
      followUpType,
    } = req.body;

    if (!name || !trigger || !messageTemplate) {
      return res.status(400).json({ error: "name, trigger, and messageTemplate are required" });
    }

    const now = Date.now();
    console.log("[automations] POST create — uid:", req.uid, "orgId:", req.orgId, "name:", name);
    const data = {
      orgId: req.orgId,
      userId: req.uid,
      name: name || "",
      trigger: trigger || "quote_sent",
      delayDays: Number(delayDays) ?? 3,
      sendAtTime: req.body.sendAtTime || "09:00",
      messageType: messageType || "sms",
      emailSubject: req.body.emailSubject || "",
      messageTemplate: messageTemplate || "",
      enabled: enabled !== undefined ? Boolean(enabled) : true,
      conditions: Array.isArray(req.body.conditions) ? req.body.conditions : [],
      isSurvey: Boolean(isSurvey),
      surveyThreshold: Number(surveyThreshold) || 8,
      followUpTemplate: followUpTemplate || "",
      followUpType: followUpType || "sms",
      createdAt: now,
      updatedAt: now,
    };

    const ref = await db.collection("automations").add(data);
    res.status(201).json({ id: ref.id, ...data });
  } catch (err) {
    next(err);
  }
});

// PUT /api/automations/:id — update automation rule
router.put("/:id", async (req, res, next) => {
  try {
    const doc = await db.collection("automations").doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Automation not found" });
    }

    const updates = {};
    const allowed = [
      "name", "trigger", "delayDays", "sendAtTime", "messageType", "emailSubject", "messageTemplate",
      "enabled", "conditions", "isSurvey", "surveyThreshold", "followUpTemplate", "followUpType",
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updatedAt = Date.now();

    await db.collection("automations").doc(req.params.id).update(updates);
    res.json({ id: req.params.id, ...doc.data(), ...updates });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/automations/:id — delete automation rule
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await db.collection("automations").doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Automation not found" });
    }
    await db.collection("automations").doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/automations/pending/:id — delete a scheduled message
router.delete("/pending/:id", async (req, res, next) => {
  try {
    const doc = await db.collection("scheduledMessages").doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Scheduled message not found" });
    }
    await db.collection("scheduledMessages").doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/automations/pending/:id/retry — retry a failed scheduled message
router.post("/pending/:id/retry", async (req, res, next) => {
  try {
    const doc = await db.collection("scheduledMessages").doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Scheduled message not found" });
    }
    await db.collection("scheduledMessages").doc(req.params.id).update({
      status: "pending",
      sendAt: Date.now(), // Send immediately on next worker cycle
      retryCount: 0,
      error: null,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, triggerAutomation, processScheduledMessages };
