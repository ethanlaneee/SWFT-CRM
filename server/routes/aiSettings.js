/**
 * SWFT — AI Settings
 *
 * Central config for every AI-driven behavior in the CRM.  One doc per org:
 *   aiSettings/{orgId}
 *
 * Surfaced in the Automations page so owners can see and tune exactly what
 * Claude does on their behalf.
 *
 * Consumed by:
 *   - server/routes/automations.js       → quote follow-up scheduling
 *   - server/utils/quoteConversationCheck.js → AI acceptance detection
 *   - server/ai/auto-reply.js            → inbound SMS / Meta auto-reply
 *   - server/ai/customer-memory.js       → fact extraction after replies
 */

const router = require("express").Router();
const { db } = require("../firebase");

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_QUOTE_FOLLOWUP_SMS =
  "Hi {customerFirstName}, this is {yourFirstName} from {companyName}. " +
  "Just following up on the quote we sent over — let us know if you have any " +
  "questions or would like to move forward. Happy to help!";

const DEFAULT_QUOTE_FOLLOWUP_EMAIL =
  "Hi {customerFirstName},\n\n" +
  "Just circling back on the quote we sent over. Let me know if you have any " +
  "questions, or if you'd like to go ahead and get this scheduled.\n\n" +
  "Happy to jump on a quick call if that's easier.\n\n" +
  "Thanks,\n{yourName}\n{companyName}";

const DEFAULT_AUTO_REPLY_INSTRUCTIONS =
  "Keep replies short and friendly — 1 to 3 sentences, SMS-style. " +
  "Never quote prices beyond what's provided in business info. " +
  "If the customer wants to schedule or needs a firm answer, let them know the owner will follow up.";

const DEFAULT_INVOICE_FOLLOWUP_SMS =
  "Hi {customerFirstName}, this is {yourFirstName} from {companyName}. " +
  "Just a friendly reminder that your invoice for {total} is still open — " +
  "let me know if you have any questions or need the payment link resent.";

const DEFAULT_INVOICE_FOLLOWUP_EMAIL =
  "Hi {customerFirstName},\n\n" +
  "Just a friendly reminder that your invoice for {total} is still open. " +
  "Let me know if you have any questions — happy to resend the payment link or set up a payment plan if that's easier.\n\n" +
  "Thanks,\n{yourName}\n{companyName}";

const DEFAULT_REVIEW_REQUEST_SMS =
  "Hi {customerFirstName}, thanks again for choosing {companyName}! " +
  "If you have a minute, we'd love a quick review — it really helps small businesses like ours: {reviewLink}";

const DEFAULT_REVIEW_REQUEST_EMAIL =
  "Hi {customerFirstName},\n\n" +
  "Thanks again for choosing {companyName} — it was a pleasure working with you.\n\n" +
  "If you have a minute, we'd love a quick review. Word-of-mouth means everything to a business like ours: {reviewLink}\n\n" +
  "Thanks,\n{yourName}\n{companyName}";

const DEFAULTS = Object.freeze({
  quoteFollowup: {
    enabled: true,
    delayDays: 3,
    delayHours: 0,
    sendAtTime: "09:00",
    channel: "sms",                           // sms | email
    smsTemplate: DEFAULT_QUOTE_FOLLOWUP_SMS,
    emailSubject: "Following up on your quote",
    emailTemplate: DEFAULT_QUOTE_FOLLOWUP_EMAIL,
    aiSkipIfAccepted: true,                   // run AI check before sending
    aiAutoApproveQuote: true,                 // mark quote approved when AI detects acceptance
    aiSkipIfRejected: true,                   // skip if AI detects rejection too
    aiModel: "claude-haiku-4-5-20251001",
  },
  invoiceFollowup: {
    enabled: true,
    delayDays: 7,
    delayHours: 0,
    sendAtTime: "09:00",
    channel: "sms",
    smsTemplate: DEFAULT_INVOICE_FOLLOWUP_SMS,
    emailSubject: "Friendly reminder: open invoice",
    emailTemplate: DEFAULT_INVOICE_FOLLOWUP_EMAIL,
    aiSkipIfPaid: true,                       // CRM already says paid → skip
    aiSkipIfPromised: true,                   // AI detects "I'll pay Friday" → skip
    aiModel: "claude-haiku-4-5-20251001",
  },
  reviewRequest: {
    enabled: true,
    delayDays: 1,
    delayHours: 0,
    sendAtTime: "10:00",
    channel: "sms",
    reviewLink: "",                           // Google / Yelp review URL
    smsTemplate: DEFAULT_REVIEW_REQUEST_SMS,
    emailSubject: "Thanks from {companyName}",
    emailTemplate: DEFAULT_REVIEW_REQUEST_EMAIL,
    aiSkipIfUnhappy: true,                    // skip if AI detects complaint in recent convo
    aiModel: "claude-haiku-4-5-20251001",
  },
  autoReply: {
    enabled: true,
    channels: { sms: true, instagram: true, facebook: true },
    model: "claude-sonnet-4-20250514",
    maxTokens: 200,
    customInstructions: DEFAULT_AUTO_REPLY_INSTRUCTIONS,
    contextMessageCount: 15,                  // how many prior messages to include
  },
  customerMemory: {
    enabled: true,
    model: "claude-haiku-4-5-20251001",
    maxFacts: 20,
  },
  updatedAt: null,
});

/**
 * Deep-merge stored settings over DEFAULTS so the caller always gets a fully
 * populated object even for fields that were never saved.
 */
function withDefaults(stored) {
  const s = stored || {};
  return {
    quoteFollowup:   { ...DEFAULTS.quoteFollowup,   ...(s.quoteFollowup   || {}) },
    invoiceFollowup: { ...DEFAULTS.invoiceFollowup, ...(s.invoiceFollowup || {}) },
    reviewRequest:   { ...DEFAULTS.reviewRequest,   ...(s.reviewRequest   || {}) },
    autoReply: {
      ...DEFAULTS.autoReply,
      ...(s.autoReply || {}),
      channels: { ...DEFAULTS.autoReply.channels, ...((s.autoReply || {}).channels || {}) },
    },
    customerMemory: { ...DEFAULTS.customerMemory, ...(s.customerMemory || {}) },
    updatedAt: s.updatedAt || null,
  };
}

/**
 * Read AI settings for an org, merged with defaults. Always returns a complete
 * object — works for consumers on the server (worker, AI utils) as well as the
 * HTTP handler.
 */
async function getAiSettings(orgId) {
  try {
    const doc = await db.collection("aiSettings").doc(orgId).get();
    if (!doc.exists) return withDefaults(null);
    return withDefaults(doc.data());
  } catch (err) {
    console.error("[aiSettings] read error:", err.message);
    return withDefaults(null);
  }
}

// ── HTTP routes ──────────────────────────────────────────────────────────────

// GET /api/ai-settings — return the current config (with defaults applied)
router.get("/", async (req, res, next) => {
  try {
    const settings = await getAiSettings(req.orgId);
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

// PUT /api/ai-settings — replace one or more of the three sections
router.put("/", async (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = { updatedAt: Date.now() };

    if (body.quoteFollowup && typeof body.quoteFollowup === "object") {
      const q = body.quoteFollowup;
      updates.quoteFollowup = {
        enabled: Boolean(q.enabled),
        delayDays: Math.max(0, Math.min(365, Number(q.delayDays) || 0)),
        delayHours: Math.max(0, Math.min(23, Number(q.delayHours) || 0)),
        sendAtTime: String(q.sendAtTime || "09:00").slice(0, 5),
        channel: q.channel === "email" ? "email" : "sms",
        smsTemplate: String(q.smsTemplate || ""),
        emailSubject: String(q.emailSubject || ""),
        emailTemplate: String(q.emailTemplate || ""),
        aiSkipIfAccepted: Boolean(q.aiSkipIfAccepted),
        aiAutoApproveQuote: Boolean(q.aiAutoApproveQuote),
        aiSkipIfRejected: Boolean(q.aiSkipIfRejected),
        aiModel: String(q.aiModel || DEFAULTS.quoteFollowup.aiModel),
      };
    }

    if (body.invoiceFollowup && typeof body.invoiceFollowup === "object") {
      const q = body.invoiceFollowup;
      updates.invoiceFollowup = {
        enabled: Boolean(q.enabled),
        delayDays: Math.max(0, Math.min(365, Number(q.delayDays) || 0)),
        delayHours: Math.max(0, Math.min(23, Number(q.delayHours) || 0)),
        sendAtTime: String(q.sendAtTime || "09:00").slice(0, 5),
        channel: q.channel === "email" ? "email" : "sms",
        smsTemplate: String(q.smsTemplate || ""),
        emailSubject: String(q.emailSubject || ""),
        emailTemplate: String(q.emailTemplate || ""),
        aiSkipIfPaid: Boolean(q.aiSkipIfPaid),
        aiSkipIfPromised: Boolean(q.aiSkipIfPromised),
        aiModel: String(q.aiModel || DEFAULTS.invoiceFollowup.aiModel),
      };
    }

    if (body.reviewRequest && typeof body.reviewRequest === "object") {
      const q = body.reviewRequest;
      updates.reviewRequest = {
        enabled: Boolean(q.enabled),
        delayDays: Math.max(0, Math.min(365, Number(q.delayDays) || 0)),
        delayHours: Math.max(0, Math.min(23, Number(q.delayHours) || 0)),
        sendAtTime: String(q.sendAtTime || "10:00").slice(0, 5),
        channel: q.channel === "email" ? "email" : "sms",
        reviewLink: String(q.reviewLink || "").slice(0, 500),
        smsTemplate: String(q.smsTemplate || ""),
        emailSubject: String(q.emailSubject || ""),
        emailTemplate: String(q.emailTemplate || ""),
        aiSkipIfUnhappy: Boolean(q.aiSkipIfUnhappy),
        aiModel: String(q.aiModel || DEFAULTS.reviewRequest.aiModel),
      };
    }

    if (body.autoReply && typeof body.autoReply === "object") {
      const a = body.autoReply;
      updates.autoReply = {
        enabled: Boolean(a.enabled),
        channels: {
          sms: Boolean(a.channels?.sms),
          instagram: Boolean(a.channels?.instagram),
          facebook: Boolean(a.channels?.facebook),
        },
        model: String(a.model || DEFAULTS.autoReply.model),
        maxTokens: Math.max(50, Math.min(1000, Number(a.maxTokens) || 200)),
        customInstructions: String(a.customInstructions || ""),
        contextMessageCount: Math.max(3, Math.min(50, Number(a.contextMessageCount) || 15)),
      };
    }

    if (body.customerMemory && typeof body.customerMemory === "object") {
      const m = body.customerMemory;
      updates.customerMemory = {
        enabled: Boolean(m.enabled),
        model: String(m.model || DEFAULTS.customerMemory.model),
        maxFacts: Math.max(5, Math.min(100, Number(m.maxFacts) || 20)),
      };
    }

    await db.collection("aiSettings").doc(req.orgId).set(updates, { merge: true });
    const fresh = await getAiSettings(req.orgId);
    res.json(fresh);
  } catch (err) {
    next(err);
  }
});

module.exports = { router, getAiSettings, DEFAULTS };
