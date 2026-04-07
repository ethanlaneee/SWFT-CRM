const { authAdmin, db } = require("../firebase");

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

  try {
    // Load orgId and role from user profile
    // orgId defaults to uid for solo users (full backward compat)
    const userDoc = await db.collection("users").doc(req.uid).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      req.orgId = userData.orgId || req.uid;
      req.userRole = userData.role || "owner";
    } else {
      req.orgId = req.uid;
      req.userRole = "owner";
    }
  } catch (err) {
    console.error("[auth] Firestore user lookup failed:", err.code || err.message);
    // Don't block the request — use defaults
    req.orgId = req.uid;
    req.userRole = "owner";
  }

  next();
}

module.exports = { auth };
