/**
 * SWFT — Customer Memory
 *
 * After each AI auto-reply, runs a lightweight Claude Haiku call to extract
 * key facts about the customer from the conversation (preferences, timing,
 * job details, etc.).  Facts are stored in Firestore and injected into the
 * system prompt on future conversations with that customer.
 *
 * Storage:  customerMemory/{orgId}_{customerId}
 *   { facts: string[], updatedAt: number }
 *
 * Fails silently — memory is best-effort and must never block a reply.
 */

const Anthropic = require("@anthropic-ai/sdk");
const { db } = require("../firebase");

const anthropic = new Anthropic();
const MAX_FACTS = 20; // cap stored per customer

/**
 * Retrieve stored memory facts for a customer.
 * Returns an empty array if none exist.
 */
async function getCustomerMemory(orgId, customerId) {
  if (!orgId || !customerId) return [];
  try {
    const doc = await db.collection("customerMemory").doc(`${orgId}_${customerId}`).get();
    if (!doc.exists) return [];
    return doc.data().facts || [];
  } catch {
    return [];
  }
}

/**
 * After an AI reply, asynchronously extract new facts from the conversation
 * and merge them into the customer's memory store.
 *
 * @param {string} orgId
 * @param {string} customerId
 * @param {Array<{role,content}>} history  - Claude message history (user/assistant pairs)
 */
async function extractAndSaveMemory(orgId, customerId, history) {
  if (!orgId || !customerId || !history.length) return;
  try {
    const transcript = history
      .map(m => `[${m.role === "user" ? "Customer" : "AI"}]: ${m.content}`)
      .join("\n");

    const aiResp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system:
        "You extract concise facts about a customer from a business conversation. " +
        "Output ONLY a JSON array of short fact strings (max 5 new facts). " +
        "Focus on: preferences, scheduling needs, job details, budget hints, past issues, communication style. " +
        "Example: [\"Prefers afternoon appointments\",\"Has a dog — alert crew\",\"Asked about senior discount\"] " +
        "If there are no useful facts, return an empty array [].",
      messages: [{ role: "user", content: `Extract customer facts from this conversation:\n\n${transcript}` }],
    });

    const raw = (aiResp.content[0]?.text || "").trim();
    let newFacts = [];
    try {
      // Extract JSON array even if the model wraps it in markdown
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) newFacts = JSON.parse(match[0]);
    } catch { return; }

    if (!Array.isArray(newFacts) || !newFacts.length) return;

    // Merge with existing, deduplicate, cap at MAX_FACTS
    const existing = await getCustomerMemory(orgId, customerId);
    const merged = [...existing];
    for (const fact of newFacts) {
      if (typeof fact === "string" && fact.trim() && !merged.includes(fact.trim())) {
        merged.push(fact.trim());
      }
    }
    const trimmed = merged.slice(-MAX_FACTS); // keep most recent

    await db.collection("customerMemory").doc(`${orgId}_${customerId}`).set({
      orgId,
      customerId,
      facts: trimmed,
      updatedAt: Date.now(),
    });

    console.log(`[memory] Saved ${newFacts.length} new fact(s) for customer ${customerId}`);
  } catch (err) {
    console.error("[memory] Extract error:", err.message);
  }
}

module.exports = { getCustomerMemory, extractAndSaveMemory };
