// Field-level encryption for high-sensitivity PII at rest.
//
// Why this matters: Firestore is already encrypted at rest by Google with
// platform-managed keys. That defends against a stolen disk in a Google
// data center. It does NOT defend against:
//   • A misconfigured Firestore security rule that exposes a collection
//     to client reads.
//   • A leaked Firebase Admin SDK key (anyone with the key can read
//     everything in plaintext).
//   • A supply-chain compromise of a server dependency.
//   • An over-broad export to Anthropic / SES / Stripe that includes
//     fields that didn't need to be sent.
//
// With application-level encryption keyed off ENCRYPT_KEY (held in Render
// env vars, never in Firestore), a Firestore breach yields ciphertext
// only. Decryption requires both the database AND the server's secret —
// a much higher bar.
//
// Algorithm: AES-256-GCM. AEAD primitive — authenticates the ciphertext
// AND any associated data. We bind the (orgId, fieldName) as additional
// authenticated data so a ciphertext from one customer's "phone" field
// cannot be cut-and-pasted into another customer's "email" field.
//
// Wire format (base64-encoded blob):
//   "v1:" + base64( iv(12) || ciphertext || authTag(16) )
//
// The "v1:" prefix lets us migrate algorithms without breaking existing
// data — a future v2 can co-exist and we decrypt by version.

const crypto = require("crypto");

const ALG = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION = "v1";

// Derive a 32-byte key from the operator-supplied secret. Using HKDF here
// so a short / weakly-formatted ENCRYPT_KEY still produces a uniform key,
// and so we can derive multiple sub-keys later (e.g. per-tenant) without
// reusing the master.
let _cachedKey = null;
function getKey() {
  if (_cachedKey) return _cachedKey;
  const secret = process.env.ENCRYPT_KEY;
  if (!secret || secret.length < 16) {
    throw new Error(
      "ENCRYPT_KEY missing or too short (need 16+ chars). " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  _cachedKey = crypto.hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.alloc(0),  // empty salt — secret is already the secret
    Buffer.from("swft-crm:field-encryption:v1", "utf8"),
    32
  );
  return _cachedKey;
}

function isEncryptionConfigured() {
  return !!(process.env.ENCRYPT_KEY && process.env.ENCRYPT_KEY.length >= 16);
}

function encrypt(plaintext, aad = "") {
  if (plaintext == null || plaintext === "") return plaintext;
  if (typeof plaintext !== "string") plaintext = String(plaintext);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, getKey(), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, ct, tag]).toString("base64");
  return `${VERSION}:${blob}`;
}

function decrypt(payload, aad = "") {
  if (payload == null || payload === "") return payload;
  if (typeof payload !== "string") return payload;
  // Backwards-compat: not-yet-encrypted records pass through unchanged.
  if (!payload.startsWith(VERSION + ":")) return payload;
  try {
    const blob = Buffer.from(payload.slice(VERSION.length + 1), "base64");
    if (blob.length < IV_LEN + TAG_LEN + 1) return payload;
    const iv = blob.subarray(0, IV_LEN);
    const tag = blob.subarray(blob.length - TAG_LEN);
    const ct = blob.subarray(IV_LEN, blob.length - TAG_LEN);
    const decipher = crypto.createDecipheriv(ALG, getKey(), iv);
    if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    return pt;
  } catch (e) {
    // Authentication failure — log without echoing the ciphertext.
    console.error("[fieldCrypto] decrypt failed:", e.message);
    return null;
  }
}

// Encrypt a set of fields on a record in place. AAD is "<orgId>:<field>"
// so a ciphertext is bound to the (tenant, field-name) pair and cannot be
// substituted across either dimension. No-ops cleanly when ENCRYPT_KEY is
// not configured — useful during initial rollout / local dev.
function encryptFields(record, fields, orgId) {
  if (!isEncryptionConfigured()) return record;
  if (!record || !Array.isArray(fields)) return record;
  for (const f of fields) {
    if (record[f] != null && record[f] !== "") {
      record[f] = encrypt(record[f], `${orgId || ""}:${f}`);
    }
  }
  return record;
}

function decryptFields(record, fields, orgId) {
  if (!isEncryptionConfigured()) return record;
  if (!record || !Array.isArray(fields)) return record;
  for (const f of fields) {
    if (record[f] != null && record[f] !== "") {
      const out = decrypt(record[f], `${orgId || ""}:${f}`);
      if (out !== null) record[f] = out;
    }
  }
  return record;
}

// PII fields by collection.
//
// Current scope: ONLY customers.notes is encrypted. Why so narrow? Because
// email / phone / address are read directly from the customers collection
// by ~20 other route files (quotes, invoices, jobs, automations, billing,
// broadcasts, payments, AI agent, social messages, …). Encrypting those
// without a coordinated migration to a shared `getCustomer()` accessor
// would cause every email/SMS automation to send ciphertext.
//
// Notes is the safe wedge: it's a free-text scratchpad that's only read
// via /api/customers (which decrypts automatically), so flipping
// ENCRYPT_KEY on cannot break any existing flow.
//
// Migration path for the rest:
//   1. Build a single `customerStore` accessor used by every consumer.
//   2. Make every direct `db.collection("customers").doc(...)` call route
//      through it.
//   3. Once that's done, add email/phone/address to the list below.
//
// Keep this list short and high-signal — every added field costs crypto
// work on every read/write and breaks Firestore-side search (you can't
// startsWith/contains an encrypted string).
const PII_FIELDS = {
  customers: ["notes"],
};

module.exports = {
  encrypt,
  decrypt,
  encryptFields,
  decryptFields,
  isEncryptionConfigured,
  PII_FIELDS,
};
