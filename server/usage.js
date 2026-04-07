/**
 * SWFT CRM — Per-user monthly usage tracking.
 *
 * Stores usage counters in Firestore at:
 *   usage/{uid}/months/{YYYY-MM}  →  { smsCount, aiMessageCount }
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
  if (!doc.exists) return { smsCount: 0, aiMessageCount: 0 };
  const data = doc.data();
  return {
    smsCount: data.smsCount || 0,
    aiMessageCount: data.aiMessageCount || 0,
  };
}

/**
 * Increment SMS count by 1. Returns the new count.
 */
async function incrementSms(uid) {
  const ref = usageRef(uid);
  await ref.set({ smsCount: FieldValue.increment(1) }, { merge: true });
  const doc = await ref.get();
  return doc.data().smsCount;
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
 * Add bonus SMS credits from an overage pack purchase.
 */
async function addSmsCredits(uid, amount) {
  const ref = usageRef(uid);
  await ref.set({ smsCredits: FieldValue.increment(amount) }, { merge: true });
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
  if (!doc.exists) return { smsCount: 0, aiMessageCount: 0, smsCredits: 0, aiCredits: 0 };
  const data = doc.data();
  return {
    smsCount: data.smsCount || 0,
    aiMessageCount: data.aiMessageCount || 0,
    smsCredits: data.smsCredits || 0,
    aiCredits: data.aiCredits || 0,
  };
}

module.exports = { getUsage, getEffectiveUsage, incrementSms, incrementAiMessage, addSmsCredits, addAiCredits };
