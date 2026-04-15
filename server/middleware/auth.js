const { authAdmin, db } = require("../firebase");

// These accounts always get owner-level access regardless of what's in Firestore.
// Their role can never be changed by any team operation.
const PROTECTED_EMAILS = ["ethan@goswft.com"];

// Cache user profiles for 5 minutes to reduce Firestore reads
// Key: uid, Value: { orgId, role, cachedAt }
const userCache = new Map();
const USER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }

  try {
    const token = header.split("Bearer ")[1];
    const decoded = await authAdmin.verifyIdToken(token);
    req.uid = decoded.uid;
    req.user = decoded;
  } catch (err) {
    console.error("[auth] Token verification failed:", err.code || err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // Protected accounts always get owner role.
  // Synchronously repair Firestore if role/orgId was corrupted (e.g. by joining a team).
  if (req.user?.email && PROTECTED_EMAILS.includes(req.user.email.toLowerCase())) {
    req.orgId = req.uid;
    req.userRole = "owner";
    userCache.delete(req.uid); // never serve a stale role from cache for this account
    try {
      const doc = await db.collection("users").doc(req.uid).get();
      if (doc.exists) {
        const d = doc.data();
        if (d.role !== "owner" || d.orgId !== req.uid) {
          await db.collection("users").doc(req.uid).set(
            { role: "owner", orgId: req.uid },
            { merge: true }
          );
          console.log("[auth] Repaired protected account role for", req.user.email);
        }
      }
    } catch (err) {
      console.error("[auth] Failed to repair protected account role:", err.message);
    }
    return next();
  }

  // Check cache first to avoid burning Firestore reads
  const cached = userCache.get(req.uid);
  if (cached && cached.orgId && (Date.now() - cached.cachedAt) < USER_CACHE_TTL) {
    req.orgId = cached.orgId;
    req.userRole = cached.role;
    return next();
  }

  try {
    const userDoc = await db.collection("users").doc(req.uid).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      req.orgId = userData.orgId || req.uid;
      req.userRole = userData.role || "owner";

      // Any user who is the primary owner of their own org (orgId === uid) must
      // always be treated as owner. Repair Firestore silently if it drifted.
      if (req.orgId === req.uid && req.userRole !== "owner") {
        req.userRole = "owner";
        db.collection("users").doc(req.uid).set({ role: "owner" }, { merge: true })
          .then(() => console.log("[auth] Repaired owner role for uid", req.uid))
          .catch(err => console.error("[auth] Failed to repair owner role:", err.message));
      }
    } else {
      req.orgId = req.uid;
      req.userRole = "owner";
    }
    // Cache the result
    console.log("[auth] User", req.uid, "→ orgId:", req.orgId, "role:", req.userRole);
    userCache.set(req.uid, { orgId: req.orgId, role: req.userRole, cachedAt: Date.now() });
  } catch (err) {
    console.error("[auth] Firestore user lookup failed:", err.code || err.message);
    // Don't cache failures — use defaults but retry next time
    req.orgId = req.uid;
    req.userRole = "owner";
    return next();
  }

  next();
}

module.exports = { auth };
