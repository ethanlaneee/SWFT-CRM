const router = require("express").Router();
const { google } = require("googleapis");
const { db } = require("../firebase");
const { getOAuthClient } = require("../utils/email");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

// GET /api/auth/google/authorize — redirect user to Google consent screen
// Requires auth middleware (user must be logged in)
router.get("/authorize", (req, res) => {
  const oauth2Client = getOAuthClient();

  // Pass the user's UID in state so we know who to save tokens for
  const state = Buffer.from(JSON.stringify({ uid: req.uid })).toString("base64");

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });

  res.json({ url });
});

// GET /api/auth/google/callback — handle OAuth callback from Google
// This is NOT behind auth middleware (Google redirects here directly)
async function googleCallback(req, res) {
  try {
    const { code, state } = req.query;

    if (!code || !state) {
      return res.status(400).send("Missing code or state parameter");
    }

    // Decode state to get user ID
    let uid;
    try {
      const decoded = JSON.parse(Buffer.from(state, "base64").toString());
      uid = decoded.uid;
    } catch (e) {
      return res.status(400).send("Invalid state parameter");
    }

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    // Get the user's Gmail address
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const gmailAddress = userInfo.data.email;

    // Save tokens to Firestore
    await db.collection("users").doc(uid).set({
      gmailConnected: true,
      gmailAddress: gmailAddress,
      gmailTokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        scope: tokens.scope,
        token_type: tokens.token_type,
        expiry_date: tokens.expiry_date,
      },
    }, { merge: true });

    // Redirect back to the messages page
    res.redirect("/swft-messages?gmail=connected");
  } catch (err) {
    console.error("Google OAuth callback error:", err);
    res.redirect("/swft-messages?gmail=error");
  }
}

// POST /api/auth/google/disconnect — remove Gmail connection
router.post("/disconnect", async (req, res) => {
  try {
    await db.collection("users").doc(req.uid).set({
      gmailConnected: false,
      gmailAddress: "",
      gmailTokens: null,
    }, { merge: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, googleCallback };
