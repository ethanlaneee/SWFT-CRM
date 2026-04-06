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

    // Load orgId and role from user profile
    // orgId defaults to uid for solo users (full backward compat)
    const userDoc = await db.collection("users").doc(decoded.uid).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      req.orgId = userData.orgId || decoded.uid;
      req.userRole = userData.role || "owner";
    } else {
      req.orgId = decoded.uid;
      req.userRole = "owner";
    }

    next();
  } catch (err) {
    console.error("[auth] Token verification failed:", err.code || err.message);
    console.error("[auth] Full error:", JSON.stringify({ code: err.code, message: err.message, stack: err.stack?.split('\n').slice(0, 3) }));
    return res.status(401).json({ error: "Invalid or expired token", detail: err.code || err.message });
  }
}

module.exports = { auth };
