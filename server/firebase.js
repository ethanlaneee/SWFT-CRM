const admin = require("firebase-admin");

let credential;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  // Production: load from environment variable (Render, Railway, etc.)
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  credential = admin.credential.cert(serviceAccount);
} else {
  // Local dev: load from file
  try {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./serviceAccountKey.json";
    const serviceAccount = require(serviceAccountPath);
    credential = admin.credential.cert(serviceAccount);
  } catch (e) {
    credential = admin.credential.applicationDefault();
  }
}

admin.initializeApp({ credential });

const db = admin.firestore();
const authAdmin = admin.auth();

module.exports = { admin, db, authAdmin };
