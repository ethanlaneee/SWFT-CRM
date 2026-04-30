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

const RECENT_AUTH_WINDOW_S = 5 * 60; // 5 minutes

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
