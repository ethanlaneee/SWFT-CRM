const { db } = require("../firebase");

const MAX_HISTORY = 50; // Keep last 50 messages per user

async function getConversationHistory(uid) {
  const snap = await db
    .collection("conversations")
    .doc(uid)
    .collection("messages")
    .orderBy("timestamp", "asc")
    .limitToLast(MAX_HISTORY)
    .get();

  return snap.docs.map(d => ({
    role: d.data().role,
    content: d.data().content,
  }));
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
