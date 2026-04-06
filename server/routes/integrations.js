// ════════════════════════════════════════════════
// User Integrations — OAuth connections for external tools
// Each user connects their own accounts (Gmail, Google Calendar, QuickBooks)
// Tokens stored per-user in Firestore
// ════════════════════════════════════════════════

const router = require("express").Router();
const { google } = require("googleapis");
const { db } = require("../firebase");
const { getOAuthClient } = require("../utils/email");

// All available integrations and their metadata
const INTEGRATIONS = [
  {
    id: "gmail",
    name: "Gmail",
    icon: "mail",
    description: "Send and read emails",
    provider: "google",
    scopes: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  },
  {
    id: "google_calendar",
    name: "Google Calendar",
    icon: "calendar",
    description: "View and create calendar events",
    provider: "google",
    scopes: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  },
  {
    id: "google_sheets",
    name: "Google Sheets",
    icon: "spreadsheet",
    description: "Export customers, jobs, and invoices to spreadsheets",
    provider: "google",
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  },
  {
    id: "google_business",
    name: "Google Business Profile",
    icon: "star",
    description: "View and respond to Google reviews",
    provider: "google",
    scopes: [
      "https://www.googleapis.com/auth/business.manage",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  },
  {
    id: "quickbooks",
    name: "QuickBooks",
    icon: "dollar-sign",
    description: "Sync invoices and expenses",
    provider: "quickbooks",
    scopes: ["com.intuit.quickbooks.accounting"],
  },
  {
    id: "stripe",
    name: "Stripe",
    icon: "credit-card",
    description: "Accept payments on invoices via Stripe",
    provider: "stripe",
    scopes: [],
  },
];

// GET /api/integrations — list all available integrations with user's connection status
router.get("/", async (req, res, next) => {
  try {
    const userDoc = await db.collection("users").doc(req.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const connections = userData.integrations || {};

    const result = INTEGRATIONS.map(integration => {
      // Stripe is platform-level: connected if the server has the key configured
      if (integration.id === "stripe") {
        return { ...integration, connected: !!process.env.STRIPE_SECRET_KEY, account: null };
      }
      return {
        ...integration,
        connected: !!connections[integration.id]?.connected,
        account: connections[integration.id]?.account || null,
      };
    });

    res.json({ integrations: result });
  } catch (err) { next(err); }
});

// POST /api/integrations/:id/connect — start OAuth flow for an integration
router.post("/:id/connect", (req, res, next) => {
  try {
    const integration = INTEGRATIONS.find(i => i.id === req.params.id);
    if (!integration) return res.status(404).json({ error: "Integration not found" });

    if (integration.provider === "google") {
      const oauth2Client = getOAuthClient();
      const state = Buffer.from(JSON.stringify({
        uid: req.uid,
        integration: integration.id,
      })).toString("base64");

      // Combine scopes for the requested integration
      const url = oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: integration.scopes,
        state,
      });

      return res.json({ url });
    }

    if (integration.provider === "quickbooks") {
      // QuickBooks OAuth — requires Intuit developer credentials
      const QB_CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID;
      const QB_REDIRECT_URI = process.env.QUICKBOOKS_REDIRECT_URI || "https://goswft.com/api/integrations/quickbooks/callback";

      if (!QB_CLIENT_ID) {
        return res.status(501).json({ error: "QuickBooks integration not configured yet" });
      }

      const state = Buffer.from(JSON.stringify({
        uid: req.uid,
        integration: "quickbooks",
      })).toString("base64");

      const url = `https://appcenter.intuit.com/connect/oauth2?` +
        `client_id=${QB_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(QB_REDIRECT_URI)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent("com.intuit.quickbooks.accounting")}` +
        `&state=${state}`;

      return res.json({ url });
    }

    res.status(400).json({ error: "Unsupported provider" });
  } catch (err) { next(err); }
});

// POST /api/integrations/:id/disconnect — remove an integration
router.post("/:id/disconnect", async (req, res, next) => {
  try {
    const integrationId = req.params.id;

    await db.collection("users").doc(req.uid).set({
      [`integrations.${integrationId}`]: {
        connected: false,
        account: null,
        tokens: null,
      },
    }, { merge: true });

    // Also clear legacy Gmail fields if disconnecting Gmail
    if (integrationId === "gmail") {
      await db.collection("users").doc(req.uid).set({
        gmailConnected: false,
        gmailAddress: "",
        gmailTokens: null,
      }, { merge: true });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Google OAuth callback (handles both Gmail and Calendar) ──

async function googleIntegrationCallback(req, res) {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code or state");

    let uid, integrationId;
    try {
      const decoded = JSON.parse(Buffer.from(state, "base64").toString());
      uid = decoded.uid;
      integrationId = decoded.integration;
    } catch (e) {
      return res.status(400).send("Invalid state parameter");
    }

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    // Get the user's email
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;

    // Store integration tokens
    const integrationData = {
      connected: true,
      account: email,
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        scope: tokens.scope,
        token_type: tokens.token_type,
        expiry_date: tokens.expiry_date,
      },
      connectedAt: Date.now(),
    };

    console.log("Saving integration:", integrationId, "for user:", uid, "email:", email);

    // Use update with nested object to ensure correct Firestore structure
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const existing = userSnap.exists ? userSnap.data().integrations || {} : {};
    existing[integrationId] = integrationData;
    await userRef.set({ integrations: existing }, { merge: true });

    // Also set legacy Gmail fields for backward compatibility
    if (integrationId === "gmail") {
      await userRef.set({
        gmailConnected: true,
        gmailAddress: email,
        gmailTokens: integrationData.tokens,
      }, { merge: true });
    }

    console.log("Integration saved successfully, redirecting to settings");

    // Redirect back to settings with success
    res.redirect(`/swft-settings?connected=${integrationId}`);
  } catch (err) {
    console.error("Integration OAuth callback error:", err);
    res.redirect(`/swft-settings?error=oauth_failed`);
  }
}

// ── QuickBooks OAuth callback ──

async function quickbooksCallback(req, res) {
  try {
    const { code, state, realmId } = req.query;
    if (!code || !state) return res.status(400).send("Missing code or state");

    let uid;
    try {
      const decoded = JSON.parse(Buffer.from(state, "base64").toString());
      uid = decoded.uid;
    } catch (e) {
      return res.status(400).send("Invalid state parameter");
    }

    const QB_CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID;
    const QB_CLIENT_SECRET = process.env.QUICKBOOKS_CLIENT_SECRET;
    const QB_REDIRECT_URI = process.env.QUICKBOOKS_REDIRECT_URI || "https://goswft.com/api/integrations/quickbooks/callback";

    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: QB_REDIRECT_URI,
      }),
    });

    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);

    await db.collection("users").doc(uid).set({
      "integrations.quickbooks": {
        connected: true,
        account: realmId || "QuickBooks",
        realmId: realmId || null,
        tokens: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_type: tokens.token_type,
          expires_in: tokens.expires_in,
          connectedAt: Date.now(),
        },
        connectedAt: Date.now(),
      },
    }, { merge: true });

    res.redirect(`/swft-settings?connected=quickbooks`);
  } catch (err) {
    console.error("QuickBooks OAuth callback error:", err);
    res.redirect(`/swft-settings?error=oauth_failed`);
  }
}

module.exports = { router, googleIntegrationCallback, quickbooksCallback };
