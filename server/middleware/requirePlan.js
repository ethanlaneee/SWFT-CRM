const { db } = require("../firebase");

// Admin accounts bypass all plan checks
const ADMIN_EMAILS = ["ethan@goswft.com"];

const PLAN_LEVEL = { starter: 0, pro: 1, business: 2 };

// Cache plan lookups for 2 minutes to reduce Firestore reads
const planCache = new Map();
const PLAN_CACHE_TTL = 2 * 60 * 1000;

/**
 * Middleware factory that gates routes by minimum plan level.
 * Uses req.orgId || req.uid to check the org owner's plan (team members inherit).
 *
 * Usage:  app.use("/api/broadcasts", auth, checkAccess, requirePlan("pro"), router);
 */
function requirePlan(minPlan) {
  const minLevel = PLAN_LEVEL[minPlan] ?? 0;

  return async (req, res, next) => {
    try {
      // Admin bypass
      if (req.user?.email && ADMIN_EMAILS.includes(req.user.email.toLowerCase())) {
        req.userPlan = "business";
        return next();
      }

      const planUid = req.orgId || req.uid;
      let plan = "starter";

      // Check cache first
      const cached = planCache.get(planUid);
      if (cached && (Date.now() - cached.ts) < PLAN_CACHE_TTL) {
        plan = cached.plan;
      } else {
        const userDoc = await db.collection("users").doc(planUid).get();
        plan = userDoc.exists ? (userDoc.data().plan || "starter") : "starter";
        planCache.set(planUid, { plan, ts: Date.now() });
      }

      req.userPlan = plan;
      const userLevel = PLAN_LEVEL[plan] ?? 0;

      if (userLevel < minLevel) {
        return res.status(403).json({
          error: `This feature requires the ${minPlan.charAt(0).toUpperCase() + minPlan.slice(1)} plan or higher.`,
          planRequired: minPlan,
          currentPlan: plan,
          upgradeUrl: `/swft-checkout?plan=${minPlan}`,
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requirePlan };
