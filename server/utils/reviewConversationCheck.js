/**
 * AI-powered "is this customer unhappy?" detection.
 *
 * Before sending a review request after job completion, this utility reads
 * the recent messages with the customer and asks Claude whether they sound
 * unhappy, frustrated, or have voiced a complaint.  We don't want to ask a
 * frustrated customer for a review — that's how you earn one-star reviews.
 *
 * Used by:
 *   - automations.js → scheduledMsgResolved()
 *
 * Behavior is controlled from aiSettings.reviewRequest (model, aiSkipIfUnhappy).
 */

const Anthropic = require("@anthropic-ai/sdk");
const { db } = require("../firebase");

const anthropic = new Anthropic();
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Analyze recent conversation and classify customer sentiment.
 *
 * Returns one of: "HAPPY" | "UNHAPPY" | "NEUTRAL" | "UNKNOWN"
 *
 * @param {string} orgId
 * @param {string} customerId
 * @param {{ model?: string }} [opts]
 * @returns {Promise<"HAPPY"|"UNHAPPY"|"NEUTRAL"|"UNKNOWN">}
 */
async function detectCustomerUnhappy(orgId, customerId, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;

  try {
    const msgsSnap = await db
      .collection("messages")
      .where("orgId", "==", orgId)
      .where("customerId", "==", customerId)
      .get();

    if (msgsSnap.empty) return "UNKNOWN";

    // Look at the last 30 messages — captures the end-of-job sentiment
    const relevant = msgsSnap.docs
      .map(d => d.data())
      .filter(m => !m.broadcastId && m.body)
      .sort((a, b) => (a.sentAt || a.createdAt || 0) - (b.sentAt || b.createdAt || 0))
      .slice(-30);

    if (relevant.length === 0) return "UNKNOWN";

    const transcript = relevant
      .map(m => {
        const speaker = m.direction === "inbound" || m.status === "received" ? "Customer" : "Business";
        return `[${speaker}]: ${m.body || ""}`;
      })
      .join("\n");

    const aiResp = await anthropic.messages.create({
      model,
      max_tokens: 10,
      system:
        "You analyze customer service conversations. Based on the customer's " +
        "most recent messages, classify their overall sentiment. " +
        "Respond with exactly one word: HAPPY, UNHAPPY, or NEUTRAL. " +
        "UNHAPPY = any complaint, frustration, unresolved issue, or negative tone. " +
        "HAPPY = clear satisfaction (thanks, praise, great service). " +
        "NEUTRAL = transactional, no sentiment signal.",
      messages: [
        {
          role: "user",
          content:
            `Below is the recent conversation with this customer. ` +
            `Consider only their messages (the [Customer] lines) for sentiment.\n\n` +
            `${transcript}\n\n` +
            `What is the customer's current sentiment?`,
        },
      ],
    });

    const raw = (aiResp.content[0]?.text || "").trim().toUpperCase();
    const verdict = raw === "HAPPY" || raw === "UNHAPPY" || raw === "NEUTRAL" ? raw : "NEUTRAL";
    console.log(`[reviewConversationCheck] customer=${customerId} verdict=${verdict}`);
    return verdict;
  } catch (err) {
    console.error("[reviewConversationCheck] Error:", err.message);
    return "UNKNOWN";
  }
}

module.exports = { detectCustomerUnhappy };
