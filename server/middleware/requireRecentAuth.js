// requireRecentAuth — gate sensitive operations (billing changes, team
// management, account deletion, integration disconnects) on a "recent"
// authentication. Even with a valid Firebase ID token, the request is
// rejected if the user's last actual sign-in is older than the window.
//
// The frontend handles the 403 by walking the user through a Firebase
// `reauthenticateWithCredential` (or `reauthenticateWithPopup` for
// Google) and retrying the request with the freshly minted ID token.
//
// Why this matters: a stolen ID token (XSS, malware, lost laptop) gives
// an attacker up to an hour of access. With this middleware, the highest-
// blast-radius operations require the attacker to *also* know the user's
// password or possess their MFA factor — a much higher bar.

const { db } = require("../firebase");

const RECENT_AUTH_WINDOW_S = 5 * 60; // 5 minutes
const SECURITY_AUDIT_COL = "securityAudit";

function getClientIp(req) {
  return (req.ip || req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || null;
}

function requireRecentAuth(windowSeconds = RECENT_AUTH_WINDOW_S) {
  return function (req, res, next) {
    const authTime = req.user?.auth_time;
    if (!authTime) {
      return res.status(401).json({
        error: "Authentication required.",
        code: "auth_required",
      });
    }
    const ageSeconds = Math.floor(Date.now() / 1000) - authTime;
    if (ageSeconds > windowSeconds) {
      // Log every reauth challenge so the user can see the access pattern
      // in their security audit log. Fire-and-forget — don't block the
      // 403 response on Firestore.
      db.collection(SECURITY_AUDIT_COL).add({
        kind: "reauth_challenged",
        uid: req.uid || null,
        email: req.user?.email?.toLowerCase() || null,
        ip: getClientIp(req),
        path: req.originalUrl || req.url || null,
        method: req.method,
        ageSeconds,
        ts: Date.now(),
      }).catch(() => {});
      return res.status(403).json({
        error: "Please re-enter your password to perform this action.",
        code: "reauth_required",
        windowSeconds,
        ageSeconds,
      });
    }
    next();
  };
}

module.exports = { requireRecentAuth };
