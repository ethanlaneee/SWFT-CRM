// Auth-security utilities: per-account lockout, breached-password check,
// and session-revocation endpoints. All endpoints in this file are
// intentionally public (no Firebase ID token required) because the user
// is, by definition, not signed in yet when they hit them. Each one is
// protected by its own per-IP rate limiter mounted in index.js.

const crypto = require("crypto");
const express = require("express");
const { db, authAdmin } = require("../firebase");

const router = express.Router();

const LOGIN_ATTEMPTS_COL = "loginAttempts";
const SECURITY_AUDIT_COL = "securityAudit";

// Lockout policy: 8 failed attempts within a 15-minute rolling window
// triggers a 15-minute lockout for that email + IP pair. Successful sign-in
// clears the counter. We key on (email, ip) rather than email alone so a
// single attacker IP can't lock a real user out of their account at will.
const LOCKOUT_THRESHOLD = 8;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

function attemptKey(email, ip) {
  const e = (email || "").trim().toLowerCase();
  const i = (ip || "0.0.0.0").trim();
  return crypto.createHash("sha256").update(`${e}|${i}`).digest("hex").slice(0, 32);
}

function getClientIp(req) {
  return (req.ip || req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || "0.0.0.0";
}

async function readAttemptDoc(email, ip) {
  const key = attemptKey(email, ip);
  const ref = db.collection(LOGIN_ATTEMPTS_COL).doc(key);
  const snap = await ref.get();
  return { ref, data: snap.exists ? snap.data() : null };
}

function isLockedOut(data) {
  if (!data) return false;
  if (data.lockedUntil && data.lockedUntil > Date.now()) return true;
  return false;
}

// ─── Turnstile (CAPTCHA) ──────────────────────────────────────────────────
// Cloudflare Turnstile is a privacy-friendly CAPTCHA. The client renders a
// widget using the public site key and gets a one-time token. We verify
// the token server-side against Turnstile's siteverify endpoint with the
// secret key. If TURNSTILE_SECRET_KEY isn't configured, the entire flow
// no-ops — useful during local dev and when the customer hasn't yet
// signed up for Turnstile.
async function verifyTurnstile(token, ip) {
  if (!process.env.TURNSTILE_SECRET_KEY) {
    return { ok: true, skipped: true };
  }
  if (!token || typeof token !== "string") {
    return { ok: false, reason: "missing-token" };
  }
  try {
    const params = new URLSearchParams();
    params.set("secret", process.env.TURNSTILE_SECRET_KEY);
    params.set("response", token);
    if (ip) params.set("remoteip", ip);
    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: params,
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return { ok: false, reason: "siteverify-http-" + resp.status };
    const data = await resp.json();
    return { ok: !!data.success, reason: data["error-codes"]?.join(",") };
  } catch (e) {
    console.warn("[turnstile] verify failed:", e.message);
    // Fail open on network error — never block legitimate users on a
    // Cloudflare hiccup. The other defenses (lockout, Firebase native
    // rate-limits) still apply.
    return { ok: true, soft: true };
  }
}

// Public config endpoint — the client fetches this on page load to render
// the widget. Returns null siteKey when Turnstile isn't configured, in which
// case the widget is omitted and the server-side verify is also a no-op.
router.get("/turnstile-config", (req, res) => {
  res.json({
    siteKey: process.env.TURNSTILE_SITE_KEY || null,
    enabled: !!process.env.TURNSTILE_SECRET_KEY,
  });
});

// ─── /api/auth/login-precheck ─────────────────────────────────────────────
// Called by the client *before* attempting Firebase signInWithEmailAndPassword.
// Returns { locked: bool, retryAfterMs?: number }. The client refuses to
// even attempt login if locked. This isn't tamper-proof (a determined
// attacker can bypass the client) but combined with Firebase Auth's own
// per-IP rate limits it shuts down credential-stuffing botnets that don't
// bother executing JS.
//
// Also enforces Turnstile: if TURNSTILE_SECRET_KEY is set, the client must
// include a valid token. This blocks headless-browser credential-stuffing
// attempts at the network layer before they ever reach Firebase Auth.
router.post("/login-precheck", async (req, res) => {
  try {
    const email = (req.body?.email || "").toString().trim().toLowerCase();
    const turnstileToken = (req.body?.turnstileToken || "").toString();

    const tv = await verifyTurnstile(turnstileToken, getClientIp(req));
    if (!tv.ok) {
      return res.status(400).json({
        locked: false,
        captchaRequired: true,
        error: "Please complete the CAPTCHA challenge.",
      });
    }

    if (!email) return res.json({ locked: false });
    const { data } = await readAttemptDoc(email, getClientIp(req));
    if (isLockedOut(data)) {
      return res.json({
        locked: true,
        retryAfterMs: data.lockedUntil - Date.now(),
      });
    }
    return res.json({ locked: false });
  } catch (e) {
    console.error("[login-precheck]", e.message);
    // Fail open — don't block legitimate users if Firestore hiccups.
    return res.json({ locked: false });
  }
});

// ─── /api/auth/login-attempt ──────────────────────────────────────────────
// The client reports the outcome of signInWithEmailAndPassword. On success,
// we clear the counter. On failure, we increment and possibly trigger
// lockout. Body: { email, success: bool }.
router.post("/login-attempt", async (req, res) => {
  try {
    const email = (req.body?.email || "").toString().trim().toLowerCase();
    const success = req.body?.success === true;
    if (!email) return res.json({ ok: true });

    const ip = getClientIp(req);
    const { ref, data } = await readAttemptDoc(email, ip);

    if (success) {
      // Clear the counter and write an audit row asynchronously.
      if (data) await ref.delete().catch(() => {});
      db.collection(SECURITY_AUDIT_COL).add({
        kind: "login_success",
        email, ip, ts: Date.now(),
      }).catch(() => {});
      return res.json({ ok: true });
    }

    const now = Date.now();
    const prev = data || { count: 0, firstAt: now };
    // Reset the rolling window if the previous failure is too old.
    const windowStart = now - LOCKOUT_WINDOW_MS;
    const inWindow = prev.firstAt && prev.firstAt >= windowStart;
    const count = (inWindow ? prev.count : 0) + 1;
    const firstAt = inWindow ? prev.firstAt : now;
    const update = {
      email, ip,
      count, firstAt,
      lastAt: now,
    };
    if (count >= LOCKOUT_THRESHOLD) {
      update.lockedUntil = now + LOCKOUT_DURATION_MS;
      db.collection(SECURITY_AUDIT_COL).add({
        kind: "lockout_triggered",
        email, ip, count, ts: now,
      }).catch(() => {});
    }
    await ref.set(update, { merge: true });

    return res.json({
      ok: true,
      locked: !!update.lockedUntil,
      retryAfterMs: update.lockedUntil ? LOCKOUT_DURATION_MS : 0,
    });
  } catch (e) {
    console.error("[login-attempt]", e.message);
    return res.json({ ok: true });
  }
});

// ─── /api/auth/check-password ─────────────────────────────────────────────
// k-anonymity check against the Have I Been Pwned password database.
// The client sends a SHA-1 hash of the password; we forward only the first
// 5 hex chars (~470 candidate hashes per query) and check the response for
// the remainder locally. The full password never leaves the user's browser
// and the prefix doesn't identify them either.
//
// Why proxy this server-side instead of letting the client call HIBP
// directly? Two reasons: (1) it lets us centralize the User-Agent header
// HIBP requires, and (2) it keeps the call path same-origin, which means
// we don't have to add api.pwnedpasswords.com to the CSP connect-src for
// any future client that isn't already allowlisted.
router.post("/check-password", async (req, res) => {
  try {
    const sha1 = (req.body?.sha1 || "").toString().toUpperCase().trim();
    if (!/^[0-9A-F]{40}$/.test(sha1)) {
      return res.status(400).json({ error: "Invalid hash format" });
    }
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const resp = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: {
        "User-Agent": "SWFT-CRM-Security-Check",
        "Add-Padding": "true",
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) {
      // Fail open — we don't want HIBP downtime to block signups.
      return res.json({ breached: false, count: 0, unavailable: true });
    }
    const text = await resp.text();
    let count = 0;
    for (const line of text.split("\n")) {
      const [hashSuffix, hitsRaw] = line.split(":");
      if (hashSuffix && hashSuffix.trim().toUpperCase() === suffix) {
        count = parseInt(hitsRaw, 10) || 1;
        break;
      }
    }
    return res.json({ breached: count > 0, count });
  } catch (e) {
    console.warn("[check-password]", e.message);
    return res.json({ breached: false, count: 0, unavailable: true });
  }
});

// ─── /api/auth/revoke-all-sessions ────────────────────────────────────────
// Authenticated. Forces every existing refresh token for the calling user
// to be invalidated, then writes an audit row. The frontend should call
// this from a "Sign out everywhere" button. Subsequent ID-token verifications
// older than `tokensValidAfterTime` will fail.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }
  try {
    const decoded = await authAdmin.verifyIdToken(header.split("Bearer ")[1], true);
    req.uid = decoded.uid;
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ─── /api/auth/audit-log ──────────────────────────────────────────────────
// Authenticated. Returns up to 50 recent security events for the calling
// user — sign-ins, lockout triggers, sessions-revoked events, MFA changes,
// and recent-reauth challenges. Lets account owners spot suspicious
// activity (e.g. sign-ins from unfamiliar IPs / countries) without us
// needing to build a full SIEM dashboard. Read-only — auditing of admin
// changes happens via Firestore directly.
router.get("/audit-log", requireAuth, async (req, res) => {
  try {
    const email = (req.user?.email || "").toLowerCase();
    const uid = req.uid;

    // Two queries: events keyed by email (login_success, lockout_triggered)
    // and events keyed by uid (sessions_revoked). Merge + sort + cap.
    const [byEmail, byUid] = await Promise.all([
      email
        ? db.collection(SECURITY_AUDIT_COL)
            .where("email", "==", email)
            .orderBy("ts", "desc")
            .limit(50)
            .get()
            .catch(() => ({ docs: [] }))
        : { docs: [] },
      db.collection(SECURITY_AUDIT_COL)
        .where("uid", "==", uid)
        .orderBy("ts", "desc")
        .limit(50)
        .get()
        .catch(() => ({ docs: [] })),
    ]);

    const seen = new Set();
    const events = [];
    for (const snap of [byEmail.docs, byUid.docs]) {
      for (const d of snap) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        const data = d.data();
        events.push({
          id: d.id,
          kind: data.kind,
          ts: data.ts,
          ip: data.ip || null,
          // Include any extra context fields we recorded, but never include
          // the email/uid back — the client already knows who they are.
          count: data.count,
        });
      }
    }
    events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    res.json({ events: events.slice(0, 50) });
  } catch (e) {
    console.error("[audit-log]", e.message);
    res.status(500).json({ error: "Failed to load audit log." });
  }
});

router.post("/revoke-all-sessions", requireAuth, async (req, res) => {
  try {
    await authAdmin.revokeRefreshTokens(req.uid);
    db.collection(SECURITY_AUDIT_COL).add({
      kind: "sessions_revoked",
      uid: req.uid,
      email: req.user?.email || null,
      ip: getClientIp(req),
      ts: Date.now(),
    }).catch(() => {});
    return res.json({ ok: true });
  } catch (e) {
    console.error("[revoke-all-sessions]", e.message);
    return res.status(500).json({ error: "Failed to revoke sessions." });
  }
});

module.exports = { router };
