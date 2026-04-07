/**
 * One-time script to remove the Ethan test account (ethanmlane@gmail.com)
 * and all associated data from Firestore + Firebase Auth.
 *
 * Usage: node server/scripts/remove-test-account.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { db, authAdmin } = require("../firebase");

const TARGET_EMAIL = "ethanmlane@gmail.com";

async function deleteCollection(collectionName, uid) {
  const snap = await db.collection(collectionName).where("userId", "==", uid).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  snap.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
  return snap.size;
}

async function main() {
  console.log(`Looking for user with email: ${TARGET_EMAIL}`);

  // Find the user in Firestore by email
  const usersSnap = await db.collection("users").where("email", "==", TARGET_EMAIL).get();

  if (usersSnap.empty) {
    console.log("No user found in Firestore with that email.");
    // Still try to delete from Firebase Auth
    try {
      const authUser = await authAdmin.getUserByEmail(TARGET_EMAIL);
      console.log(`Found in Firebase Auth: ${authUser.uid} — deleting...`);
      await authAdmin.deleteUser(authUser.uid);
      console.log("Firebase Auth account deleted.");
    } catch (e) {
      console.log("Not found in Firebase Auth either. Nothing to do.");
    }
    process.exit(0);
  }

  const userDoc = usersSnap.docs[0];
  const uid = userDoc.id;
  const userData = userDoc.data();
  console.log(`Found user: ${userData.name || "(no name)"} (uid: ${uid})`);

  // Delete all related collections
  const collections = ["customers", "jobs", "quotes", "invoices", "schedule", "messages", "scheduledMessages", "followups"];
  for (const col of collections) {
    const count = await deleteCollection(col, uid);
    if (count > 0) console.log(`  Deleted ${count} docs from '${col}'`);
  }

  // Delete by orgId too (for team/org-scoped data)
  const orgId = userData.orgId || uid;
  for (const col of ["scheduledMessages", "followups", "messages"]) {
    const snap = await db.collection(col).where("orgId", "==", orgId).get();
    if (!snap.empty) {
      const batch = db.batch();
      snap.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      console.log(`  Deleted ${snap.size} org-scoped docs from '${col}'`);
    }
  }

  // Delete conversation history
  try {
    const convSnap = await db.collection("conversations").doc(uid).collection("messages").get();
    if (!convSnap.empty) {
      const batch = db.batch();
      convSnap.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      console.log(`  Deleted ${convSnap.size} conversation messages`);
    }
    await db.collection("conversations").doc(uid).delete();
  } catch (e) { /* may not exist */ }

  // Delete usage subcollection
  try {
    const usageSnap = await db.collection("usage").doc(uid).collection("months").get();
    if (!usageSnap.empty) {
      const batch = db.batch();
      usageSnap.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      console.log(`  Deleted ${usageSnap.size} usage records`);
    }
    await db.collection("usage").doc(uid).delete();
  } catch (e) { /* may not exist */ }

  // Delete team membership
  try {
    const teamSnap = await db.collection("team").where("uid", "==", uid).get();
    if (!teamSnap.empty) {
      const batch = db.batch();
      teamSnap.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      console.log(`  Deleted ${teamSnap.size} team records`);
    }
  } catch (e) { /* may not exist */ }

  // Delete user profile
  await db.collection("users").doc(uid).delete();
  console.log("  Deleted user profile");

  // Delete Firebase Auth account
  try {
    await authAdmin.deleteUser(uid);
    console.log("  Deleted Firebase Auth account");
  } catch (e) {
    // Try by email as fallback
    try {
      const authUser = await authAdmin.getUserByEmail(TARGET_EMAIL);
      await authAdmin.deleteUser(authUser.uid);
      console.log("  Deleted Firebase Auth account (by email lookup)");
    } catch (e2) {
      console.log("  Firebase Auth account not found (may already be deleted)");
    }
  }

  console.log("\nDone! Test account fully removed.");
  process.exit(0);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
