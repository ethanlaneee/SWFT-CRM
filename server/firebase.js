const admin = require("firebase-admin");

let credential;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  // Production: load from environment variable (Render, Railway, etc.)
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  console.log("[firebase] Service account project:", serviceAccount.project_id || "MISSING");
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

const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || "swft-ai26.firebasestorage.app";
admin.initializeApp({ credential, storageBucket });

const db = admin.firestore();
const authAdmin = admin.auth();

// Resolve the correct Storage bucket at startup (try primary, then fallback)
const BUCKET_CANDIDATES = [
  storageBucket,
  "swft-ai26.appspot.com",
];
let _resolvedBucket = admin.storage().bucket(); // default

(async () => {
  for (const name of BUCKET_CANDIDATES) {
    try {
      const b = admin.storage().bucket(name);
      const [exists] = await b.exists();
      if (exists) {
        _resolvedBucket = b;
        console.log("[firebase] Storage bucket resolved:", name);
        return;
      }
    } catch (e) {
      console.warn("[firebase] Bucket check failed for", name, ":", e.message);
    }
  }
  console.error("[firebase] No valid storage bucket found. Photo uploads will fail.");
})();

// Getter so photo routes always use the resolved bucket
function getStorageBucket() { return _resolvedBucket; }

// Expose the project ID for diagnostics
const projectId = admin.app().options?.projectId || admin.app().options?.credential?.projectId || "unknown";
console.log("[firebase] Admin SDK project ID:", projectId);

module.exports = { admin, db, authAdmin, projectId, get bucket() { return _resolvedBucket; }, getStorageBucket };
