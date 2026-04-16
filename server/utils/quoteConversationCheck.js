/**
 * AI-powered quote acceptance detection.
 *
 * Before sending a follow-up automation for an unsigned quote, this utility
 * reads the actual message history with that customer and asks Claude whether
 * the customer already accepted the quote in conversation.  This prevents
 * sending "did you see our quote?" messages to someone who already said yes.
 *
 * Used by:
 *   - automations.js → scheduledMsgResolved()
 *
 * Behavior is controlled from aiSettings.quoteFollowup (model, auto-approve,
 * skipIfRejected) — see routes/aiSettings.js.
 */

const Anthropic = require("@anthropic-ai/sdk");
const { db } = require("../firebase");

const anthropic = new Anthropic();

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Analyze the conversation following a quote send and classify the outcome.
 *
 * Returns one of: "ACCEPTED" | "REJECTED" | "PENDING" | "UNKNOWN"
 * (UNKNOWN = no conversation yet or the AI call failed — caller should treat
 *  as not-yet-resolved so the follow-up still goes out.)
 *
 * Side effect: when the verdict is ACCEPTED and opts.autoApprove is true, the
 * quote doc is updated with status="approved".
 *
 * Callers that just want the legacy boolean answer ("should I skip the
 * follow-up?") can use the default opts — when autoApprove is true and
 * skipIfRejected is true, both ACCEPTED and REJECTED return early.
 *
 * @param {string} orgId
 * @param {string} customerId
 * @param {string} quoteId
 * @param {object} quote   Firestore quote doc data
 * @param {{ autoApprove?: boolean, model?: string, skipIfRejected?: boolean }} [opts]
 * @returns {Promise<"ACCEPTED"|"REJECTED"|"PENDING"|"UNKNOWN">}
 */
async function detectQuoteOutcome(orgId, customerId, quoteId, quote, opts = {}) {
  const autoApprove = opts.autoApprove !== false; // default true
  const model = opts.model || DEFAULT_MODEL;

  try {
    const sentAt = quote.sentAt || 0;

    const msgsSnap = await db
      .collection("messages")
      .where("orgId", "==", orgId)
      .where("customerId", "==", customerId)
      .get();

    if (msgsSnap.empty) return "UNKNOWN";

    const relevant = msgsSnap.docs
      .map(d => d.data())
      .filter(m => (m.sentAt || m.createdAt || 0) > sentAt && !m.broadcastId)
      .sort((a, b) => (a.sentAt || a.createdAt || 0) - (b.sentAt || b.createdAt || 0))
      .slice(-20);

    if (relevant.length === 0) return "UNKNOWN";

    const transcript = relevant
      .map(m => {
        const speaker = m.status === "received" ? "Customer" : "Business";
        return `[${speaker}]: ${m.body || ""}`;
      })
      .join("\n");

    const service = quote.service || "the requested work";
    const total   = quote.total ? `$${Number(quote.total).toLocaleString()}` : "";
    const desc    = [service, total].filter(Boolean).join(" for ");

    const aiResp = await anthropic.messages.create({
      model,
      max_tokens: 10,
      system:
        "You analyze customer service conversations. " +
        "Respond with exactly one word: ACCEPTED, REJECTED, or PENDING.",
      messages: [
        {
          role: "user",
          content:
            `A quote for "${desc}" was sent to this customer. ` +
            `Below is the conversation since the quote was sent.\n\n` +
            `${transcript}\n\n` +
            `Has the customer clearly accepted this quote?`,
        },
      ],
    });

    const raw = (aiResp.content[0]?.text || "").trim().toUpperCase();
    const verdict = raw === "ACCEPTED" || raw === "REJECTED" || raw === "PENDING" ? raw : "PENDING";
    console.log(`[quoteConversationCheck] quote=${quoteId} customer=${customerId} verdict=${verdict}`);

    if (verdict === "ACCEPTED" && autoApprove) {
      await db.collection("quotes").doc(quoteId).update({
        status: "approved",
        approvedAt: Date.now(),
        approvedVia: "ai_conversation_detection",
      }).catch(() => {});
      console.log(`[quoteConversationCheck] Auto-approved quote ${quoteId}`);
    }

    return verdict;
  } catch (err) {
    console.error("[quoteConversationCheck] Error:", err.message);
    return "UNKNOWN";
  }
}

/**
 * Legacy boolean wrapper — returns true if the follow-up should be skipped.
 * Kept so existing callers don't need to change.
 */
async function isQuoteAcceptedInConversation(orgId, customerId, quoteId, quote, opts = {}) {
  const verdict = await detectQuoteOutcome(orgId, customerId, quoteId, quote, opts);
  if (verdict === "ACCEPTED") return "ACCEPTED";
  if (verdict === "REJECTED" && opts.skipIfRejected) return "REJECTED";
  return verdict; // caller can inspect; falsy for PENDING/UNKNOWN handling
}

module.exports = { detectQuoteOutcome, isQuoteAcceptedInConversation };
