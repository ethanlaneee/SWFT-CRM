/**
 * AI-powered quote acceptance detection.
 *
 * Before sending a follow-up automation for an unsigned quote, this utility
 * reads the actual message history with that customer and asks Claude whether
 * the customer already accepted the quote in conversation.  This prevents
 * sending "did you see our quote?" messages to someone who already said yes.
 *
 * Used by:
 *   - automations.js  → scheduledMsgResolved()
 *   - followup-agent.js → targetResolved()
 */

const Anthropic = require("@anthropic-ai/sdk");
const { db } = require("../firebase");

const anthropic = new Anthropic();

/**
 * Determine whether a customer has already accepted a quote by analyzing
 * the conversation messages that occurred after the quote was sent.
 *
 * Returns true  → customer accepted; caller should skip the follow-up
 * Returns false → no acceptance detected; follow-up should proceed
 *
 * Fails safe: if AI call errors, returns false so follow-ups still go out.
 *
 * @param {string} orgId
 * @param {string} customerId
 * @param {string} quoteId
 * @param {object} quote   Firestore quote doc data ({ sentAt, total, service, … })
 * @returns {Promise<boolean>}
 */
async function isQuoteAcceptedInConversation(orgId, customerId, quoteId, quote) {
  try {
    const sentAt = quote.sentAt || 0;

    // Pull all messages for this customer in this org
    const msgsSnap = await db
      .collection("messages")
      .where("orgId", "==", orgId)
      .where("customerId", "==", customerId)
      .get();

    if (msgsSnap.empty) return false;

    // Only consider messages AFTER the quote was sent.
    // Exclude broadcast blasts — those aren't conversations about this quote.
    const relevant = msgsSnap.docs
      .map(d => d.data())
      .filter(m => (m.sentAt || m.createdAt || 0) > sentAt && !m.broadcastId)
      .sort((a, b) => (a.sentAt || a.createdAt || 0) - (b.sentAt || b.createdAt || 0))
      .slice(-20); // cap at last 20 exchanges

    if (relevant.length === 0) return false;

    // Build a readable conversation transcript
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
      model: "claude-haiku-4-5-20251001",
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

    const verdict = (aiResp.content[0]?.text || "").trim().toUpperCase();
    console.log(
      `[quoteConversationCheck] quote=${quoteId} customer=${customerId} verdict=${verdict}`
    );

    if (verdict === "ACCEPTED") {
      // Auto-approve in Firestore so the quote shows as accepted in the UI
      // and future scans don't re-check the same quote.
      await db.collection("quotes").doc(quoteId).update({
        status: "approved",
        approvedAt: Date.now(),
        approvedVia: "ai_conversation_detection",
      });
      console.log(
        `[quoteConversationCheck] Auto-approved quote ${quoteId} — accepted in conversation`
      );
      return true;
    }

    return false;
  } catch (err) {
    console.error("[quoteConversationCheck] Error:", err.message);
    return false; // fail safe — let the follow-up proceed if AI is unavailable
  }
}

module.exports = { isQuoteAcceptedInConversation };
