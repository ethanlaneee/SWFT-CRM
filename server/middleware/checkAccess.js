const { authAdmin, db } = require("../firebase");

const col = () => db.collection("users");

// Admin accounts bypass all subscription/trial checks
const ADMIN_EMAILS = ["ethan@goswft.com"];

// Cache account status for 2 minutes to reduce Firestore reads
const accessCache = new Map();
const ACCESS_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

// Cache org-specific custom role permissions for 5 minutes
const customPermCache = new Map();
const CUSTOM_PERM_CACHE_TTL = 5 * 60 * 1000;

async function getCustomPermissions(orgId, role) {
  if (!orgId || !role) return null;
  const cacheKey = `${orgId}:${role}`;
  const cached = customPermCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < CUSTOM_PERM_CACHE_TTL) return cached.perms;
  try {
    const doc = await db.collection("orgRoles").doc(orgId).get();
    if (doc.exists) {
      const customRoles = doc.data().roles || {};
      const roleConfig = customRoles[role];
      if (roleConfig && Array.isArray(roleConfig.permissions)) {
        const perms = new Set(roleConfig.permissions);
        customPermCache.set(cacheKey, { perms, ts: Date.now() });
        return perms;
      }
    }
  } catch (_) {}
  customPermCache.set(cacheKey, { perms: null, ts: Date.now() });
  return null;
}

// Maps (baseUrl, HTTP method) → required permission key
const METHOD_PERMISSION = {
  "/api/dashboard":     { GET: "dashboard.view" },
  "/api/customers":     { GET: "customers.view", POST: "customers.add",   PUT: "customers.edit",   DELETE: "customers.delete" },
  "/api/jobs":          { GET: "jobs.view",       POST: "jobs.add",        PUT: "jobs.edit",        DELETE: "jobs.delete" },
  "/api/quotes":        { GET: "quotes.view",     POST: "quotes.add",      PUT: "quotes.edit",      DELETE: "quotes.delete" },
  "/api/invoices":      { GET: "invoices.view",   POST: "invoices.add",    PUT: "invoices.edit",    DELETE: "invoices.delete" },
  "/api/schedule":      { GET: "schedule.view",   POST: "schedule.add",    PUT: "schedule.edit",    DELETE: "schedule.delete" },
  "/api/messages":      { GET: "messages.view",   POST: "messages.send",   DELETE: "messages.delete" },
  "/api/social":        { GET: "messages.view",   POST: "messages.send" },
  "/api/email":             { GET: "email.send",        POST: "email.send" },
  "/api/email-templates":   { GET: "email.templates",   POST: "email.templates",        PUT: "email.templates",  DELETE: "email.templates" },
  "/api/payments":      { GET: "invoices.view",   POST: "invoices.edit" },
  "/api/photos":            { GET: "jobs.view",        POST: "photos.upload",          DELETE: "photos.delete" },
  "/api/ai":                { GET: "ai.use",           POST: "ai.use",                 DELETE: "ai.use" },
  "/api/notifications":     { GET: "dashboard.view",  POST: "dashboard.view",         DELETE: "dashboard.view" },
  "/api/team":              { GET: "team.manage",      POST: "team.manage",            PUT: "team.manage",      DELETE: "team.manage" },
  "/api/integrations":      { GET: "integrations.manage", POST: "integrations.manage", PUT: "integrations.manage", DELETE: "integrations.manage" },
  "/api/service-requests":  { GET: "intake.view",      POST: "jobs.add",               DELETE: "intake.manage" },
  "/api/intake-forms":      { GET: "intake.view",      POST: "intake.manage",          PUT: "intake.manage",    DELETE: "intake.manage" },
  "/api/broadcasts":        { GET: "broadcasts.view",  POST: "broadcasts.send",        DELETE: "broadcasts.delete" },
  "/api/agents":            { GET: "automations.view", POST: "automations.manage",     PUT: "automations.manage", DELETE: "automations.manage" },
  "/api/automations":       { GET: "automations.view", POST: "automations.manage",     PUT: "automations.manage", DELETE: "automations.manage" },
  "/api/import":            { GET: "import.use",       POST: "import.use" },
  "/api/team-chat":         { GET: "teamchat.view",    POST: "teamchat.send",          DELETE: "teamchat.view" },
  "/api/tracker":           { GET: "tracker.view",     POST: "tracker.view" },
  "/api/doors":             { GET: "doors.view",       POST: "doors.add",              PUT: "doors.edit",       DELETE: "doors.delete" },
  "/api/agent-actions":     { GET: "dashboard.view",   POST: "dashboard.view",         DELETE: "dashboard.view" },
};

// Human-readable labels for 403 messages
const PERM_LABEL = {
  "dashboard.view":        "view the dashboard",
  "customers.view":        "view customers",
  "customers.add":         "add customers",
  "customers.edit":        "edit customers",
  "customers.delete":      "delete customers",
  "jobs.view":             "view jobs",
  "jobs.add":              "add jobs",
  "jobs.edit":             "edit jobs",
  "jobs.delete":           "delete jobs",
  "quotes.view":           "view quotes",
  "quotes.add":            "create quotes",
  "quotes.edit":           "edit quotes",
  "quotes.delete":         "delete quotes",
  "invoices.view":         "view invoices",
  "invoices.add":          "create invoices",
  "invoices.edit":         "edit invoices",
  "invoices.delete":       "delete invoices",
  "schedule.view":         "view the schedule",
  "schedule.add":          "add schedule entries",
  "schedule.edit":         "edit schedule entries",
  "schedule.delete":       "delete schedule entries",
  "messages.view":         "view messages",
  "messages.send":         "send messages",
  "messages.delete":       "delete messages",
  "email.send":            "send emails",
  "email.templates":       "manage email templates",
  "photos.upload":         "upload job photos",
  "photos.delete":         "delete job photos",
  "ai.use":                "use the AI assistant",
  "broadcasts.view":       "view broadcasts",
  "broadcasts.send":       "send broadcasts",
  "broadcasts.delete":     "delete broadcasts",
  "automations.view":      "view automations",
  "automations.manage":    "manage automations",
  "reviews.view":          "view reviews",
  "reviews.respond":       "respond to reviews",
  "intake.view":           "view intake requests",
  "intake.manage":         "manage intake forms",
  "import.use":            "import data",
  "billing.view":          "view billing",
  "billing.manage":        "manage billing",
  "team.manage":           "manage team members",
  "integrations.manage":   "manage SWFT Connect",
  "settings.manage":       "change settings",
  "teamchat.view":         "view team chat",
  "teamchat.send":         "send team messages",
  "tracker.view":          "view the team tracker",
  "tracker.viewAll":       "see all teammates on the map",
  "doors.view":            "view your door knocks",
  "doors.viewAll":         "view the whole team's door knocks",
  "doors.add":             "log door knocks",
  "doors.edit":            "edit door details",
  "doors.delete":          "delete doors",
  "doors.import":          "bulk-import addresses",
};

// Permissions per built-in role
const ROLE_PERMISSIONS = {
  owner: null, // unrestricted
  admin: new Set([
    "dashboard.view",
    "customers.view","customers.add","customers.edit","customers.delete",
    "jobs.view","jobs.viewAll","jobs.add","jobs.edit","jobs.delete",
    "quotes.view","quotes.add","quotes.edit","quotes.delete",
    "invoices.view","invoices.add","invoices.edit","invoices.delete",
    "billing.view","billing.manage",
    "schedule.view","schedule.add","schedule.edit","schedule.delete",
    "messages.view","messages.send","messages.delete",
    "email.send","email.templates",
    "photos.upload","photos.delete",
    "ai.use",
    "broadcasts.view","broadcasts.send","broadcasts.delete",
    "automations.view","automations.manage",
    "reviews.view","reviews.respond",
    "intake.view","intake.manage",
    "import.use",
    "teamchat.view","teamchat.send",
    "tracker.view","tracker.viewAll",
    "doors.view","doors.viewAll","doors.add","doors.edit","doors.delete","doors.import",
    "team.manage",
    "integrations.manage",
    "settings.manage",
  ]),
  office: new Set([
    "dashboard.view",
    "customers.view","customers.add","customers.edit","customers.delete",
    "jobs.view","jobs.viewAll","jobs.add","jobs.edit","jobs.delete",
    "quotes.view","quotes.add","quotes.edit","quotes.delete",
    "invoices.view","invoices.add","invoices.edit","invoices.delete",
    "schedule.view","schedule.add","schedule.edit","schedule.delete",
    "messages.view","messages.send",
    "email.send","email.templates",
    "photos.upload",
    "ai.use",
    "broadcasts.view","broadcasts.send",
    "automations.view",
    "reviews.view","reviews.respond",
    "intake.view",
    "teamchat.view","teamchat.send",
    "tracker.view",
    "doors.view","doors.viewAll","doors.add","doors.edit","doors.delete","doors.import",
  ]),
  technician: new Set([
    "dashboard.view",
    "jobs.view",
    "jobs.edit",
    "schedule.view",
    "messages.view","messages.send",
    // photos.upload intentionally omitted — owner grants it via team permissions
    "ai.use",
    "teamchat.view","teamchat.send",
    "tracker.view",
    "doors.view","doors.add","doors.edit",
  ]),
};

/**
 * checkAccess middleware
 *
 * Step 1 — Authentication: verifies Firebase JWT.
 * Step 2 — Account status: trial / active / expired check.
 * Step 3 — Role permissions: method-level granular enforcement.
 */
async function checkAccess(req, res, next) {
  // ── Step 1: Authentication ────────────────────────────────────────────────
  if (!req.uid) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required.", redirect: "/login" });
    }
    try {
      const token = header.split("Bearer ")[1];
      const decoded = await authAdmin.verifyIdToken(token);
      req.uid = decoded.uid;
      req.user = decoded;
    } catch {
      return res.status(401).json({ error: "Invalid or expired session. Please log in again.", redirect: "/login" });
    }
  }

  // ── Admin bypass ──────────────────────────────────────────────────────────
  if (req.user?.email && ADMIN_EMAILS.includes(req.user.email.toLowerCase())) {
    return next();
  }

  // Team members belong to an org owned by someone else. Their subscription
  // access is governed by the org owner's plan, not their own user doc. If
  // their own user doc carries stale trial fields (e.g. they were a trial
  // signup before being invited), we must NOT block them on Step 2.
  const isTeamMember = !!(req.orgId && req.orgId !== req.uid);

  try {
    // ── Step 2: Account status (owners only) ────────────────────────────────
    if (!isTeamMember) {
      // Check cache first
      const cached = accessCache.get(req.uid);
      let accountStatus, isSubscribed, trialEndDate;

      if (cached && (Date.now() - cached.cachedAt) < ACCESS_CACHE_TTL) {
        accountStatus = cached.accountStatus;
        isSubscribed = cached.isSubscribed;
        trialEndDate = cached.trialEndDate;
      } else {
        const doc = await col().doc(req.uid).get();
        if (!doc.exists) {
          accessCache.set(req.uid, { accountStatus: null, isSubscribed: false, trialEndDate: null, cachedAt: Date.now() });
          return next(); // new user — let them through
        }
        const data = doc.data();
        accountStatus = data.accountStatus;
        isSubscribed = data.isSubscribed;
        trialEndDate = data.trialEndDate;
        accessCache.set(req.uid, { accountStatus, isSubscribed, trialEndDate, cachedAt: Date.now() });
      }

      if (!isSubscribed && trialEndDate && Date.now() > trialEndDate) {
        if (accountStatus !== "expired") {
          await col().doc(req.uid).set({ accountStatus: "expired" }, { merge: true });
          accessCache.delete(req.uid); // invalidate cache
        }
        accountStatus = "expired";
      }

      if (accountStatus === "expired" || accountStatus === "canceled") {
        return res.status(403).json({
          error: "Access denied.",
          message: "Your trial has ended. Please upgrade to continue.",
          redirect: "/billing",
        });
      }
    }

    // ── Step 3: Role-based permission check ───────────────────────────────
    const role = req.userRole || "owner";
    let allowedPerms = ROLE_PERMISSIONS[role]; // null = owner (unrestricted)

    if (allowedPerms) {
      // Override with org-specific custom permissions if the org has configured them
      const customPerms = await getCustomPermissions(req.orgId, role);
      if (customPerms) allowedPerms = customPerms;

      const routePerms = METHOD_PERMISSION[req.baseUrl];
      if (routePerms) {
        const requiredPerm = routePerms[req.method] || null;
        if (requiredPerm && !allowedPerms.has(requiredPerm)) {
          const label = PERM_LABEL[requiredPerm] || "perform this action";
          return res.status(403).json({
            error: `You don't have permission to ${label}.`,
            permission: requiredPerm,
          });
        }
      }
    }

    // Expose resolved permissions to downstream route handlers
    req.userPermissions = allowedPerms; // null = owner (unrestricted), Set otherwise

    return next();
  } catch (err) {
    next(err);
  }
}

function clearCustomPermCache(orgId) {
  if (!orgId) { customPermCache.clear(); return; }
  for (const key of customPermCache.keys()) {
    if (key.startsWith(orgId + ":")) customPermCache.delete(key);
  }
}

module.exports = { checkAccess, ROLE_PERMISSIONS, METHOD_PERMISSION, clearCustomPermCache };
