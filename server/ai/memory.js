const { db } = require("../firebase");
const Anthropic = require("@anthropic-ai/sdk");

// Maximum raw messages to keep before summarising the oldest ones.
// After summarisation we keep KEEP_RECENT raw messages + 1 summary block.
const SUMMARISE_AFTER = 20;
const KEEP_RECENT     = 6;

async function getConversationHistory(uid) {
  const snap = await db
    .collection("conversations")
    .doc(uid)
    .collection("messages")
    .orderBy("timestamp", "asc")
    .get();

  const docs = snap.docs;

  // Separate any existing summary from raw messages
  const summaryDoc = docs.find(d => d.data().isSummary);
  const rawDocs    = docs.filter(d => !d.data().isSummary);

  // Build the history array: optional summary block + raw messages
  const history = [];
  if (summaryDoc) {
    history.push({ role: summaryDoc.data().role, content: summaryDoc.data().content });
  }
  rawDocs.forEach(d => history.push({ role: d.data().role, content: d.data().content }));

  return history;
}

// Summarise old messages and replace them with a single compact block.
// Called after saving a new message when the raw count exceeds SUMMARISE_AFTER.
async function maybeSummarise(uid) {
  const snap = await db
    .collection("conversations")
    .doc(uid)
    .collection("messages")
    .orderBy("timestamp", "asc")
    .get();

  const docs     = snap.docs;
  const rawDocs  = docs.filter(d => !d.data().isSummary);

  if (rawDocs.length < SUMMARISE_AFTER) return;

  // Split: oldest messages to summarise, recent messages to keep verbatim
  const toSummarise = rawDocs.slice(0, rawDocs.length - KEEP_RECENT);
  const toKeep      = rawDocs.slice(rawDocs.length - KEEP_RECENT);

  // Build a text transcript of the messages being compressed
  const transcript = toSummarise.map(d => {
    const role    = d.data().role === "user" ? "User" : "Assistant";
    const content = d.data().content;
    const text    = Array.isArray(content)
      ? content.filter(b => b.type === "text").map(b => b.text).join(" ")
      : String(content);
    return `${role}: ${text.slice(0, 600)}`;
  }).join("\n");

  // Ask Claude Haiku to produce a compact summary (cheap + fast)
  let summaryText = "";
  try {
    const client   = new Anthropic();
    const response = await client.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{
        role:    "user",
        content: `Summarise this CRM assistant conversation in 3–6 bullet points. Be concise. Capture what the user asked, what actions were taken, and any key details (names, amounts, dates). Do not include pleasantries.\n\n${transcript}`,
      }],
    });
    summaryText = response.content[0]?.text || "";
  } catch (err) {
    console.error("[memory] Summarisation failed:", err.message);
    return; // Skip this round — will retry next message
  }

  if (!summaryText) return;

  const batch = db.batch();
  const colRef = db.collection("conversations").doc(uid).collection("messages");

  // Delete old summary (if any) and all messages being replaced
  const oldSummary = docs.find(d => d.data().isSummary);
  if (oldSummary) batch.delete(oldSummary.ref);
  toSummarise.forEach(d => batch.delete(d.ref));

  // Write new summary as a user message so Claude sees it as context
  const summaryRef = colRef.doc();
  batch.set(summaryRef, {
    role:      "user",
    content:   `[Earlier conversation summary]\n${summaryText}`,
    isSummary: true,
    timestamp: toSummarise[0].data().timestamp, // Oldest timestamp so it sorts first
  });

  await batch.commit();
  console.log(`[memory] Summarised ${toSummarise.length} messages for ${uid}`);
}

async function saveMessage(uid, role, content) {
  await db
    .collection("conversations")
    .doc(uid)
    .collection("messages")
    .add({
      role,
      content,
      timestamp: Date.now(),
    });

  // Fire summarisation in the background — don't block the response
  maybeSummarise(uid).catch(err => console.error("[memory] maybeSummarise error:", err.message));
}

async function clearHistory(uid) {
  const snap = await db
    .collection("conversations")
    .doc(uid)
    .collection("messages")
    .get();

  const batch = db.batch();
  snap.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
}

module.exports = { getConversationHistory, saveMessage, clearHistory };
