/**
 * AI-powered invoice payment-promise detection.
 *
 * Before sending an invoice follow-up, this utility reads the message history
 * with the customer and asks Claude whether the customer has already paid or
 * promised a specific payment time (e.g. "I'll send it Friday", "paid via
 * Zelle this morning").  This prevents nagging people who already committed
 * to or made the payment.
 *
 * Used by:
 *   - automations.js → scheduledMsgResolved()
 *
 * Behavior is controlled from aiSettings.invoiceFollowup (model, skipIfPromised).
 */

const Anthropic = require("@anthropic-ai/sdk");
const { db } = require("../firebase");

const anthropic = new Anthropic();
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Analyze the conversation following an invoice send and classify the outcome.
 *
 * Returns one of: "PAID" | "PROMISED" | "PENDING" | "UNKNOWN"
 *
 * @param {string} orgId
 * @param {string} customerId
 * @param {string} invoiceId
 * @param {object} invoice   Firestore invoice doc data
 * @param {{ model?: string }} [opts]
 * @returns {Promise<"PAID"|"PROMISED"|"PENDING"|"UNKNOWN">}
 */
async function detectInvoicePaymentPromise(orgId, customerId, invoiceId, invoice, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;

  try {
    const sentAt = invoice.sentAt || invoice.createdAt || 0;

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
        const speaker = m.direction === "inbound" || m.status === "received" ? "Customer" : "Business";
        return `[${speaker}]: ${m.body || ""}`;
      })
      .join("\n");

    const total = invoice.total ? `$${Number(invoice.total).toLocaleString()}` : "the invoice amount";

    const aiResp = await anthropic.messages.create({
      model,
      max_tokens: 10,
      system:
        "You analyze customer service conversations about invoices. " +
        "Respond with exactly one word: PAID, PROMISED, or PENDING. " +
        "PAID = customer confirmed they already paid. " +
        "PROMISED = customer committed to a specific time or method to pay soon. " +
        "PENDING = neither; no clear commitment yet.",
      messages: [
        {
          role: "user",
          content:
            `An invoice for ${total} was sent to this customer. ` +
            `Below is the conversation since.\n\n` +
            `${transcript}\n\n` +
            `Has the customer already paid, or promised a specific time to pay?`,
        },
      ],
    });

    const raw = (aiResp.content[0]?.text || "").trim().toUpperCase();
    const verdict = raw === "PAID" || raw === "PROMISED" || raw === "PENDING" ? raw : "PENDING";
    console.log(`[invoiceConversationCheck] invoice=${invoiceId} customer=${customerId} verdict=${verdict}`);
    return verdict;
  } catch (err) {
    console.error("[invoiceConversationCheck] Error:", err.message);
    return "UNKNOWN";
  }
}

module.exports = { detectInvoicePaymentPromise };
