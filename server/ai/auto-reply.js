/**
 * SWFT — Auto-Reply Agent
 *
 * Every inbound SMS thread defaults to "auto" mode — Claude reads the
 * conversation history and business context, then sends a reply.
 * The owner can flip any thread to "manual" mode from the Messages view
 * to take over personally.
 *
 * Conversation mode stored at:
 *   conversationModes/{orgId}_{customerId}   — for known customers
 *   conversationModes/{orgId}_phone_{digits} — for unknown callers
 *
 * Mode values: "auto" (default) | "manual"
 */

const Anthropic = require("@anthropic-ai/sdk");
const { db } = require("../firebase");
const { sendSms, getUserTelnyxConfig } = require("../telnyx");

const anthropic = new Anthropic();

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Canonical Firestore key for a conversation.
 */
function convKey(orgId, customerId, fromPhone) {
  if (customerId) return `${orgId}_${customerId}`;
  return `${orgId}_phone_${(fromPhone || "").replace(/\D/g, "")}`;
}

/**
 * Get conversation mode. Defaults to "auto" when no record exists.
 */
async function getConversationMode(orgId, customerId, fromPhone) {
  const key = convKey(orgId, customerId, fromPhone);
  const doc = await db.collection("conversationModes").doc(key).get();
  if (!doc.exists) return "auto";
  return doc.data().mode || "auto";
}

/**
 * Set conversation mode ("auto" | "manual").
 */
async function setConversationMode(orgId, customerId, fromPhone, mode) {
  const key = convKey(orgId, customerId, fromPhone);
  await db.collection("conversationModes").doc(key).set({
    orgId,
    customerId: customerId || null,
    phone: fromPhone || null,
    mode,
    updatedAt: Date.now(),
  }, { merge: true });
}

/**
 * Fetch the last N messages for this conversation (oldest first).
 */
async function getRecentMessages(orgId, customerId, fromPhone, limit = 15) {
  let snap;
  if (customerId) {
    snap = await db.collection("messages")
      .where("orgId", "==", orgId)
      .where("customerId", "==", customerId)
      .get();
  } else {
    const digits = (fromPhone || "").replace(/\D/g, "");
    snap = await db.collection("messages")
      .where("orgId", "==", orgId)
      .where("from", "==", fromPhone)
      .get();
    if (snap.empty && digits) {
      snap = await db.collection("messages")
        .where("orgId", "==", orgId)
        .where("from", "==", digits)
        .get();
    }
  }
  if (snap.empty) return [];
  return snap.docs
    .map(d => d.data())
    .sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0))
    .slice(-limit);
}

/**
 * Build a short context block about the customer's open quotes/invoices.
 */
async function getCustomerContext(orgId, customerId) {
  if (!customerId) return "";
  const lines = [];

  const quotesSnap = await db.collection("quotes")
    .where("orgId", "==", orgId)
    .where("customerId", "==", customerId)
    .where("status", "in", ["draft", "sent"])
    .get();
  if (!quotesSnap.empty) {
    const ql = quotesSnap.docs.map(d => {
      const q = d.data();
      const svc = q.service || "service";
      const amt = q.total ? `$${Number(q.total).toLocaleString()}` : "";
      return `- Quote for "${svc}"${amt ? ` — ${amt}` : ""} (${q.status})`;
    });
    lines.push("Open quotes:\n" + ql.join("\n"));
  }

  const invSnap = await db.collection("invoices")
    .where("orgId", "==", orgId)
    .where("customerId", "==", customerId)
    .where("status", "in", ["open", "sent"])
    .get();
  if (!invSnap.empty) {
    const il = invSnap.docs.map(d => {
      const inv = d.data();
      const amt = inv.total ? `$${Number(inv.total).toLocaleString()}` : "";
      return `- Invoice${amt ? ` ${amt}` : ""} (${inv.status})`;
    });
    lines.push("Open invoices:\n" + il.join("\n"));
  }

  return lines.join("\n\n");
}

/**
 * Build the Claude system prompt from org owner profile.
 */
function buildSystemPrompt(orgUser, customerContext) {
  const bizName  = orgUser.company || orgUser.name || "this business";
  const ownerFN  = (orgUser.name || "").split(" ")[0] || "the owner";
  let prompt = `You are the AI assistant for ${bizName}. You handle inbound customer text messages on behalf of the business owner.\n\n`;
  if (orgUser.bizAbout)    prompt += `About the business: ${orgUser.bizAbout}\n\n`;
  if (orgUser.bizServices) prompt += `Services: ${orgUser.bizServices}\n\n`;
  if (orgUser.bizArea)     prompt += `Service area: ${orgUser.bizArea}\n\n`;
  if (orgUser.bizHours)    prompt += `Hours: ${orgUser.bizHours}\n\n`;
  if (customerContext)     prompt += `${customerContext}\n\n`;
  prompt +=
    `Rules:\n` +
    `- Keep replies SHORT — 1 to 3 sentences, SMS-style\n` +
    `- Be warm and professional\n` +
    `- Reference the customer's open quotes or invoices if relevant\n` +
    `- If they want to schedule or need a human decision, let them know ${ownerFN} will follow up shortly\n` +
    `- Never invent pricing, never commit to dates or guarantees\n` +
    `- If you genuinely cannot help, say so and offer to have ${ownerFN} reach out`;
  return prompt;
}

// ── Core: generate AI reply text ─────────────────────────────────────────────

/**
 * Check mode and generate an AI reply for any inbound message channel.
 * Returns the reply string, or null if the thread is in manual mode or
 * the AI has nothing to say.
 *
 * @param {string} orgId
 * @param {object} ownerData
 * @param {string|null} customerId
 * @param {string} fromIdentifier  - phone number (SMS) or sender ID (Meta)
 * @param {string} body
 * @param {{ customerName }|null} matched
 * @returns {Promise<string|null>}
 */
async function generateAutoReply(orgId, ownerData, customerId, fromIdentifier, body, matched) {
  const mode = await getConversationMode(orgId, customerId, fromIdentifier);
  if (mode === "manual") {
    console.log(`[auto-reply] Thread ${customerId || fromIdentifier} is manual — skipping`);
    return null;
  }

  const [recentMessages, customerContext] = await Promise.all([
    getRecentMessages(orgId, customerId, fromIdentifier),
    getCustomerContext(orgId, customerId),
  ]);

  const history = recentMessages
    .filter(m => m.body)
    .map(m => ({
      role: m.direction === "inbound" ? "user" : "assistant",
      content: m.body,
    }));

  const last = history[history.length - 1];
  if (!last || last.role !== "user" || last.content !== body) {
    history.push({ role: "user", content: body });
  }

  const aiResp = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 200,
    system: buildSystemPrompt(ownerData, customerContext),
    messages: history,
  });

  return aiResp.content[0]?.text?.trim() || null;
}

// ── SMS (Telnyx) ──────────────────────────────────────────────────────────────

/**
 * Called for every inbound SMS after the message is saved to Firestore.
 */
async function handleInbound(orgId, ownerUid, ownerData, from, body, matched) {
  try {
    const customerId = matched?.customerId || null;
    const replyText = await generateAutoReply(orgId, ownerData, customerId, from, body, matched);
    if (!replyText) return;

    await sendSms(from, replyText, getUserTelnyxConfig(ownerData));

    await db.collection("messages").add({
      userId: ownerUid,
      orgId,
      to: from,
      body: replyText,
      customerId: customerId || "",
      customerName: matched?.customerName || from,
      type: "sms",
      status: "sent",
      sentVia: "telnyx",
      direction: "outbound",
      isAutoReply: true,
      sentAt: Date.now(),
    });

    console.log(`[auto-reply] SMS reply sent to ${from} (org ${orgId})`);
  } catch (err) {
    console.error("[auto-reply] SMS error:", err.message);
  }
}

// ── Meta (Facebook / Instagram) ───────────────────────────────────────────────

/**
 * Called for every inbound Meta message after it is saved to Firestore.
 *
 * @param {string} orgId
 * @param {string} ownerUid
 * @param {object} ownerData        - User doc (facebookPageAccessToken, instagramUserId, …)
 * @param {string} senderId         - Meta sender ID
 * @param {string} body             - Message text
 * @param {string} channel          - "instagram" | "facebook"
 * @param {{ customerId, customerName }|null} matched
 * @param {Function} metaSendFn     - async (text) => void  — channel-specific send
 */
async function handleInboundMeta(orgId, ownerUid, ownerData, senderId, body, channel, matched, metaSendFn) {
  try {
    const customerId = matched?.customerId || null;
    const replyText = await generateAutoReply(orgId, ownerData, customerId, senderId, body, matched);
    if (!replyText) return;

    await metaSendFn(replyText);

    await db.collection("messages").add({
      userId: ownerUid,
      orgId,
      to: senderId,
      body: replyText,
      customerId: customerId || "",
      customerName: matched?.customerName || senderId,
      type: channel,
      status: "sent",
      sentVia: channel,
      direction: "outbound",
      isAutoReply: true,
      sentAt: Date.now(),
    });

    console.log(`[auto-reply] ${channel} reply sent to ${senderId} (org ${orgId})`);
  } catch (err) {
    console.error(`[auto-reply] ${channel} error:`, err.message);
  }
}

module.exports = { handleInbound, handleInboundMeta, getConversationMode, setConversationMode, convKey };
