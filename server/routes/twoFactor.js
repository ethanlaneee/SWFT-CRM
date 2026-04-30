const router = require("express").Router();
const { authenticator } = require("otplib");
const QRCode = require("qrcode");
const crypto = require("crypto");
const { db } = require("../firebase");

const col = () => db.collection("users");

// AES-256-GCM encryption for the TOTP secret stored in Firestore.
// TWO_FACTOR_KEY must be a 64-char hex string (32 bytes). Falls back to a
// deterministic key derived from FIREBASE_PROJECT_ID for local dev (not secure).
function getEncKey() {
  const hex = process.env.TWO_FACTOR_KEY;
  if (hex && hex.length === 64) return Buffer.from(hex, "hex");
  // Fallback: derive 32 bytes from any available env secret — never used in prod
  const fallback = process.env.FIREBASE_PROJECT_ID || "swft-local-dev-key-fallback-xx";
  return crypto.createHash("sha256").update(fallback).digest();
}

function encrypt(text) {
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}.${enc.toString("hex")}.${tag.toString("hex")}`;
}

function decrypt(stored) {
  const [ivHex, encHex, tagHex] = stored.split(".");
  const key = getEncKey();
  const iv = Buffer.from(ivHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// Sign a 2FA session token (uid + expiry) with HMAC-SHA256 so the client can
// include it in requests made during a login session. The server validates it
// at /api/2fa/validate and the login page stores it in sessionStorage.
function sign2FAToken(uid) {
  const secret = process.env.TWO_FACTOR_KEY || process.env.FIREBASE_PROJECT_ID || "swft-session";
  const exp = Date.now() + 12 * 60 * 60 * 1000; // 12 h
  const payload = `${uid}:${exp}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

function verify2FAToken(token, uid) {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length !== 3) return false;
    const [tUid, exp, sig] = parts;
    if (tUid !== uid) return false;
    if (Date.now() > Number(exp)) return false;
    const secret = process.env.TWO_FACTOR_KEY || process.env.FIREBASE_PROJECT_ID || "swft-session";
    const expected = crypto.createHmac("sha256", secret).update(`${tUid}:${exp}`).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

// GET /api/2fa/status — is 2FA enabled for this user?
router.get("/status", async (req, res, next) => {
  try {
    const doc = await col().doc(req.uid).get();
    const data = doc.exists ? doc.data() : {};
    res.json({ enabled: !!data.twoFactorEnabled });
  } catch (err) { next(err); }
});

// POST /api/2fa/setup — generate a new TOTP secret + QR code URI (not saved yet)
router.post("/setup", async (req, res, next) => {
  try {
    const doc = await col().doc(req.uid).get();
    const data = doc.exists ? doc.data() : {};
    if (data.twoFactorEnabled) {
      return res.status(400).json({ error: "2FA is already enabled. Disable it first." });
    }

    const secret = authenticator.generateSecret();
    const email = data.email || req.user?.email || req.uid;
    const otpauthUrl = authenticator.keyuri(email, "SWFT CRM", secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);

    // Store the pending (unconfirmed) secret temporarily — it won't be activated
    // until the user verifies a valid code via POST /api/2fa/enable.
    await col().doc(req.uid).set({ twoFactorPendingSecret: encrypt(secret) }, { merge: true });

    res.json({ secret, qrDataUrl, otpauthUrl });
  } catch (err) { next(err); }
});

// POST /api/2fa/enable — verify user's first TOTP code and activate 2FA
router.post("/enable", async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Verification code is required." });

    const doc = await col().doc(req.uid).get();
    const data = doc.exists ? doc.data() : {};

    if (!data.twoFactorPendingSecret) {
      return res.status(400).json({ error: "No setup in progress. Call /api/2fa/setup first." });
    }

    let secret;
    try { secret = decrypt(data.twoFactorPendingSecret); } catch {
      return res.status(500).json({ error: "Failed to read pending secret. Please restart setup." });
    }

    authenticator.options = { window: 1 };
    const valid = authenticator.verify({ token: code.replace(/\s/g, ""), secret });
    if (!valid) return res.status(400).json({ error: "Invalid code. Make sure your authenticator app is synced and try again." });

    await col().doc(req.uid).set({
      twoFactorEnabled: true,
      twoFactorSecret: encrypt(secret),
      twoFactorPendingSecret: null,
      twoFactorEnabledAt: Date.now(),
    }, { merge: true });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/2fa/disable — verify current TOTP code then disable 2FA
router.post("/disable", async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Verification code is required to disable 2FA." });

    const doc = await col().doc(req.uid).get();
    const data = doc.exists ? doc.data() : {};

    if (!data.twoFactorEnabled || !data.twoFactorSecret) {
      return res.status(400).json({ error: "2FA is not enabled." });
    }

    let secret;
    try { secret = decrypt(data.twoFactorSecret); } catch {
      return res.status(500).json({ error: "Failed to read 2FA secret." });
    }

    authenticator.options = { window: 1 };
    const valid = authenticator.verify({ token: code.replace(/\s/g, ""), secret });
    if (!valid) return res.status(400).json({ error: "Invalid code." });

    await col().doc(req.uid).set({
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorPendingSecret: null,
      twoFactorDisabledAt: Date.now(),
    }, { merge: true });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/2fa/validate — called after Firebase login to verify TOTP code.
// Returns a signed session token the client stores in sessionStorage.
router.post("/validate", async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Verification code is required." });

    const doc = await col().doc(req.uid).get();
    const data = doc.exists ? doc.data() : {};

    if (!data.twoFactorEnabled || !data.twoFactorSecret) {
      // 2FA not enabled — treat as valid (no gate)
      return res.json({ success: true, token: sign2FAToken(req.uid) });
    }

    let secret;
    try { secret = decrypt(data.twoFactorSecret); } catch {
      return res.status(500).json({ error: "Failed to read 2FA secret." });
    }

    authenticator.options = { window: 1 };
    const valid = authenticator.verify({ token: code.replace(/\s/g, ""), secret });
    if (!valid) return res.status(400).json({ error: "Invalid code. Try again." });

    res.json({ success: true, token: sign2FAToken(req.uid) });
  } catch (err) { next(err); }
});

// POST /api/2fa/verify-token — middleware helper: check a 2FA session token
router.post("/verify-token", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ valid: false });
  res.json({ valid: verify2FAToken(token, req.uid) });
});

module.exports = router;
module.exports.verify2FAToken = verify2FAToken;
