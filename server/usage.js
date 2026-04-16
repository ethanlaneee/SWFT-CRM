/**
 * SWFT CRM — Per-user monthly usage tracking.
 *
 * Stores usage counters in Firestore at:
 *   usage/{uid}/months/{YYYY-MM}  →  { aiMessageCount }
 *
 * Each helper increments atomically and returns the new count so callers can
 * compare against plan limits before proceeding.
 */

const { db } = require("./firebase");
const { FieldValue } = require("firebase-admin/firestore");

function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function usageRef(uid) {
  return db.collection("usage").doc(uid).collection("months").doc(monthKey());
}

/**
 * Get current usage counts for a user this month.
 */
async function getUsage(uid) {
  const doc = await usageRef(uid).get();
  if (!doc.exists) return { aiMessageCount: 0 };
  const data = doc.data();
  return {
    aiMessageCount: data.aiMessageCount || 0,
  };
}

/**
 * Increment AI message count by 1. Returns the new count.
 */
async function incrementAiMessage(uid) {
  const ref = usageRef(uid);
  await ref.set({ aiMessageCount: FieldValue.increment(1) }, { merge: true });
  const doc = await ref.get();
  return doc.data().aiMessageCount;
}

/**
 * Add bonus AI message credits from an overage pack purchase.
 */
async function addAiCredits(uid, amount) {
  const ref = usageRef(uid);
  await ref.set({ aiCredits: FieldValue.increment(amount) }, { merge: true });
}

/**
 * Get effective remaining allowance: (planLimit + bonusCredits) - used.
 */
async function getEffectiveUsage(uid) {
  const doc = await usageRef(uid).get();
  if (!doc.exists) return { aiMessageCount: 0, aiCredits: 0 };
  const data = doc.data();
  return {
    aiMessageCount: data.aiMessageCount || 0,
    aiCredits: data.aiCredits || 0,
  };
}

module.exports = { getUsage, getEffectiveUsage, incrementAiMessage, addAiCredits };
