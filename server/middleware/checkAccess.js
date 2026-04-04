const { authAdmin, db } = require("../firebase");

const col = () => db.collection("users");

// Admin accounts bypass all subscription/trial checks
const ADMIN_EMAILS = ["ethan@goswft.com"];

// Maps API base routes → permission key
const ROUTE_PERMISSION = {
  "/api/dashboard":     "dashboard",
  "/api/customers":     "customers",
  "/api/jobs":          "jobs",
  "/api/quotes":        "quotes",
  "/api/invoices":      "invoices",
  "/api/schedule":      "schedule",
  "/api/messages":      "messages",
  "/api/ai":            "ai",
  "/api/team":          "team",
  "/api/integrations":  "integrations",
  "/api/payments":      "invoices",
  "/api/photos":        "jobs",
  "/api/notifications": "dashboard",
};

// Permissions per built-in role
const ROLE_PERMISSIONS = {
  owner:      null, // null = unrestricted
  admin:      new Set(["dashboard","customers","jobs","quotes","invoices","schedule","messages","ai","team","integrations","settings"]),
  office:     new Set(["dashboard","customers","jobs","quotes","invoices","schedule","messages","ai"]),
  technician: new Set(["dashboard","jobs","schedule","messages","ai"]),
};

/**
 * checkAccess middleware — runs after the `auth` middleware on all private routes.
 *
 * Step 1 — Authentication:
 *   Verifies the Firebase JWT in the Authorization header.
 *   Returns 401 + { redirect: "/login" } if missing, malformed, or invalid.
 *
 * Step 2 — Account status:
 *   Fetches the user's Firestore profile and (if needed) auto-expires a lapsed trial.
 *   • "active" | "trialing"  → next()
 *   • "expired" | "canceled" → 403 + { redirect: "/billing", message }
 *
 * Usage in index.js:
 *   const { auth } = require("./middleware/auth");
 *   const { checkAccess } = require("./middleware/checkAccess");
 *
 *   // Auth-only (user/billing profile always accessible):
 *   app.use("/api/me", auth, require("./routes/user"));
 *
 *   // Fully gated (requires active/trialing account):
 *   app.use("/api/dashboard", auth, checkAccess, require("./routes/dashboard"));
 */
async function checkAccess(req, res, next) {
  // ── Step 1: Authentication ────────────────────────────────────────────────
  // If checkAccess is used standalone (without a preceding `auth` middleware),
  // verify the token here. If `auth` already ran, req.uid is already set and
  // this block is skipped.
  if (!req.uid) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required.",
        redirect: "/login",
      });
    }
    try {
      const token = header.split("Bearer ")[1];
      const decoded = await authAdmin.verifyIdToken(token);
      req.uid = decoded.uid;
      req.user = decoded;
    } catch {
      return res.status(401).json({
        error: "Invalid or expired session. Please log in again.",
        redirect: "/login",
      });
    }
  }

  // ── Admin bypass ─────────────────────────────────────────────────────────
  if (req.user?.email && ADMIN_EMAILS.includes(req.user.email)) {
    return next();
  }

  // ── Step 2: Account status ────────────────────────────────────────────────
  try {
    const doc = await col().doc(req.uid).get();

    // No profile yet — treat as trialing (GET /api/me will create it)
    if (!doc.exists) return next();

    let { accountStatus, isSubscribed, trialEndDate } = doc.data();

    // Auto-expire: trial window has closed and user is not subscribed
    if (!isSubscribed && trialEndDate && Date.now() > trialEndDate) {
      if (accountStatus !== "expired") {
        await col().doc(req.uid).set({ accountStatus: "expired" }, { merge: true });
      }
      accountStatus = "expired";
    }

    if (!accountStatus || accountStatus === "active" || accountStatus === "trialing") {
      // ── Role-based permission check ────────────────────────────────────────
      const role = req.userRole || "owner";
      const allowedPerms = ROLE_PERMISSIONS[role]; // null = owner (unrestricted)
      if (allowedPerms) {
        const requiredPerm = ROUTE_PERMISSION[req.baseUrl];
        if (requiredPerm && !allowedPerms.has(requiredPerm)) {
          return res.status(403).json({
            error: `Your role (${role}) doesn't have permission to access this area.`,
          });
        }
      }
      return next();
    }

    // "expired" or "canceled"
    return res.status(403).json({
      error: "Access denied.",
      message: "Your trial has ended. Please upgrade to continue.",
      redirect: "/billing",
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { checkAccess };
