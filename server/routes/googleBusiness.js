// ════════════════════════════════════════════════
// Google Business Profile — Reviews management
// Requires google_business integration connected
// ════════════════════════════════════════════════

const router = require("express").Router();
const { google } = require("googleapis");
const { db } = require("../firebase");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "https://goswft.com/api/auth/google/callback";

async function getGoogleClient(uid) {
  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.exists ? userDoc.data() : {};
  const tokens = userData?.integrations?.google_business?.tokens;
  if (!tokens?.access_token) {
    throw Object.assign(new Error("Google Business Profile not connected"), { statusCode: 403 });
  }
  const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  auth.setCredentials(tokens);
  return auth;
}

async function gbpFetch(auth, path) {
  const token = await auth.getAccessToken();
  const res = await fetch(`https://mybusiness.googleapis.com/v4${path}`, {
    headers: { Authorization: `Bearer ${token.token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `GBP API error ${res.status}`);
  }
  return res.json();
}

async function gbpPost(auth, path, body) {
  const token = await auth.getAccessToken();
  const res = await fetch(`https://mybusiness.googleapis.com/v4${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `GBP API error ${res.status}`);
  }
  return res.json();
}

async function gbpDelete(auth, path) {
  const token = await auth.getAccessToken();
  const res = await fetch(`https://mybusiness.googleapis.com/v4${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token.token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `GBP API error ${res.status}`);
  }
  return res.status === 204 ? {} : res.json();
}

// GET /api/google-business/accounts — list GBP accounts
router.get("/accounts", async (req, res, next) => {
  try {
    const auth = await getGoogleClient(req.uid);
    const token = await auth.getAccessToken();
    const accountsRes = await fetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", {
      headers: { Authorization: `Bearer ${token.token}` },
    });
    const data = await accountsRes.json();
    if (!accountsRes.ok) {
      return res.status(400).json({ error: data.error?.message || "Failed to fetch accounts" });
    }
    res.json({ accounts: data.accounts || [] });
  } catch (err) {
    if (err.statusCode === 403) return res.status(403).json({ error: err.message });
    next(err);
  }
});

// GET /api/google-business/reviews?accountId=...&locationId=...
router.get("/reviews", async (req, res, next) => {
  try {
    const { accountId, locationId } = req.query;
    if (!accountId || !locationId) {
      return res.status(400).json({ error: "accountId and locationId are required" });
    }
    const auth = await getGoogleClient(req.uid);
    const path = `/accounts/${accountId}/locations/${locationId}/reviews`;
    const data = await gbpFetch(auth, path);
    res.json({ reviews: data.reviews || [], averageRating: data.averageRating });
  } catch (err) {
    if (err.statusCode === 403) return res.status(403).json({ error: err.message });
    next(err);
  }
});

// POST /api/google-business/reviews/:reviewName/reply
// Body: { accountId, locationId, comment }
router.post("/reviews/:reviewId/reply", async (req, res, next) => {
  try {
    const { accountId, locationId, comment } = req.body;
    if (!accountId || !locationId || !comment) {
      return res.status(400).json({ error: "accountId, locationId, and comment are required" });
    }
    const auth = await getGoogleClient(req.uid);
    const path = `/accounts/${accountId}/locations/${locationId}/reviews/${req.params.reviewId}/reply`;
    const data = await gbpPost(auth, path, { comment });
    res.json({ reply: data });
  } catch (err) {
    if (err.statusCode === 403) return res.status(403).json({ error: err.message });
    next(err);
  }
});

// DELETE /api/google-business/reviews/:reviewId/reply
router.delete("/reviews/:reviewId/reply", async (req, res, next) => {
  try {
    const { accountId, locationId } = req.query;
    if (!accountId || !locationId) {
      return res.status(400).json({ error: "accountId and locationId are required" });
    }
    const auth = await getGoogleClient(req.uid);
    const path = `/accounts/${accountId}/locations/${locationId}/reviews/${req.params.reviewId}/reply`;
    await gbpDelete(auth, path);
    res.json({ success: true });
  } catch (err) {
    if (err.statusCode === 403) return res.status(403).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
