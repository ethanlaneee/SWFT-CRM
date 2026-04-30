require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { db, authAdmin } = require("../firebase");

async function deleteDemoAccount(uid) {
  const collections = ["customers", "jobs", "quotes", "invoices", "schedule", "messages", "scheduledMessages", "followups"];
  for (const col of collections) {
    const snap = await db.collection(col).where("userId", "==", uid).get();
    if (!snap.empty) {
      const batch = db.batch(); snap.docs.forEach(d => batch.delete(d.ref)); await batch.commit();
    }
  }
  try {
    const convSnap = await db.collection("conversations").doc(uid).collection("messages").get();
    if (!convSnap.empty) {
      const b = db.batch(); convSnap.docs.forEach(d => b.delete(d.ref)); await b.commit();
    }
    await db.collection("conversations").doc(uid).delete();
  } catch (_) {}
  try {
    const usageSnap = await db.collection("usage").doc(uid).collection("months").get();
    if (!usageSnap.empty) {
      const b = db.batch(); usageSnap.docs.forEach(d => b.delete(d.ref)); await b.commit();
    }
    await db.collection("usage").doc(uid).delete();
  } catch (_) {}
  await db.collection("users").doc(uid).delete();
  try { await authAdmin.deleteUser(uid); } catch (_) {}
}

async function main() {
  const snap = await db.collection("users").where("demoAccount", "==", true).get();
  if (snap.empty) { console.log("No demo accounts found."); process.exit(0); }
  console.log(`Found ${snap.size} demo account(s) — deleting...`);
  for (const doc of snap.docs) {
    const d = doc.data();
    console.log(`  Deleting ${doc.id} (visitor: ${d.demoVisitorEmail || "unknown"})`);
    await deleteDemoAccount(doc.id);
  }
  console.log("Done.");
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
