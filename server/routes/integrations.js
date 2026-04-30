// ════════════════════════════════════════════════
// User Integrations — OAuth connections for external tools
// Each user connects their own accounts (Gmail, Google Calendar, QuickBooks)
// Tokens stored per-user in Firestore
// ════════════════════════════════════════════════

const router = require("express").Router();
const { google } = require("googleapis");
const { admin, db } = require("../firebase");
const { getOAuthClient } = require("../utils/email");
const { requirePlan } = require("../middleware/requirePlan");
const FieldValue = admin.firestore.FieldValue;

// QuickBooks is available on all plans; all other integrations require SWFT Pro (business)
const requireBusinessForNonQB = (req, res, next) => {
  if (req.params.id === "quickbooks") return next();
  return requirePlan("business")(req, res, next);
};

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
    id: "google_drive",
    name: "Google Drive",
    icon: "folder",
    description: "Attach photos and documents from Google Drive to jobs and customers",
    provider: "google",
    scopes: [
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  },
  {
    id: "meta_lead_ads",
    name: "Meta Lead Ads",
    icon: "zap",
    description: "Automatically import leads from Facebook and Instagram ad forms into your CRM",
    provider: "meta_lead_ads",
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
  {
    id: "facebook",
    name: "Facebook Messenger",
    icon: "message-circle",
    description: "Receive and send Facebook Messenger messages in your unified inbox",
    provider: "facebook",
    scopes: ["pages_messaging", "pages_read_engagement"],
  },
  {
    id: "instagram",
    name: "Instagram DMs",
    icon: "camera",
    description: "Receive and send Instagram Direct Messages in your unified inbox",
    provider: "instagram",
    scopes: ["instagram_manage_messages", "instagram_basic"],
  },
  {
    id: "whatsapp",
    name: "WhatsApp Business",
    icon: "phone",
    description: "Receive and send WhatsApp messages in your unified inbox",
    provider: "whatsapp",
    scopes: ["whatsapp_business_messaging"],
  },
  {
    id: "mailchimp",
    name: "Mailchimp",
    icon: "mail",
    description: "Send email campaigns and broadcasts to your customer list via Mailchimp",
    provider: "mailchimp",
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
      // Stripe Connect is per-owner: connected only when we have their linked account id
      if (integration.id === "stripe") {
        const accountId = connections.stripe?.accountId || null;
        const configured = !!process.env.STRIPE_CLIENT_ID;
        return {
          ...integration,
          connected: !!accountId,
          account: connections.stripe?.accountEmail || accountId || null,
          configured,
        };
      }
      // Check both new integrations map and legacy fields
      let connected = !!connections[integration.id]?.connected;
      let account = connections[integration.id]?.account || null;
      if (!connected && integration.id === "gmail" && userData.gmailConnected) {
        connected = true;
        account = userData.gmailAddress || null;
      }
      if (!connected && integration.id === "google_calendar" && userData.googleCalendarConnected) {
        connected = true;
      }
      // Social platforms — check for accessToken instead of "connected" flag
      if (!connected && integration.id === "facebook" && connections.facebook?.accessToken) {
        connected = true;
        account = connections.facebook?.pageName || null;
      }
      if (!connected && integration.id === "instagram" && connections.instagram?.accessToken) {
        connected = true;
        account = connections.instagram?.accountName || null;
      }
      if (!connected && integration.id === "whatsapp" && connections.whatsapp?.accessToken) {
        connected = true;
        account = connections.whatsapp?.displayPhone || null;
      }
      // Legacy fields from /api/meta/callback (Facebook OAuth flow)
      if (!connected && integration.id === "facebook" && userData.facebookPageAccessToken) {
        connected = true;
        account = userData.facebookPageName || null;
      }
      if (!connected && integration.id === "instagram" && userData.instagramUserId) {
        connected = true;
        account = userData.instagramUsername ? '@' + userData.instagramUsername : null;
      }
      if (!connected && integration.id === "meta_lead_ads" && userData.metaLeadAdsConnected) {
        connected = true;
        const pages = userData.metaLeadAdsPages || [];
        account = pages.length ? pages.map(p => p.name).join(", ") : null;
      }
      if (!connected && integration.id === "google_drive" && connections.google_drive?.connected) {
        connected = true;
        account = connections.google_drive?.account || null;
      }
      return { ...integration, connected, account };
    });

    res.json({ integrations: result });
  } catch (err) { next(err); }
});

// POST /api/integrations/:id/connect — start OAuth flow for an integration
router.post("/:id/connect", requireBusinessForNonQB, (req, res, next) => {
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

    // Stripe Connect (Standard) — OAuth into the owner's Stripe account so
    // invoice pay links get created on their account and money lands in
    // their Stripe balance, not ours.
    if (integration.provider === "stripe") {
      const SC_CLIENT_ID = process.env.STRIPE_CLIENT_ID;
      const APP_URL = process.env.APP_URL || "https://goswft.com";
      const SC_REDIRECT_URI = `${APP_URL}/api/integrations/stripe/callback`;

      if (!SC_CLIENT_ID) {
        return res.status(501).json({ error: "Stripe Connect is not configured on this server. Please add STRIPE_CLIENT_ID." });
      }

      const state = Buffer.from(JSON.stringify({
        uid: req.uid,
        integration: "stripe",
      })).toString("base64url");

      const url = `https://connect.stripe.com/oauth/authorize?` +
        `response_type=code` +
        `&client_id=${encodeURIComponent(SC_CLIENT_ID)}` +
        `&scope=read_write` +
        `&redirect_uri=${encodeURIComponent(SC_REDIRECT_URI)}` +
        `&state=${encodeURIComponent(state)}`;

      return res.json({ url });
    }

    // Meta Lead Ads — use same Meta OAuth flow
    if (integration.provider === "meta_lead_ads") {
      const meta = require("../meta");
      if (!meta.isConfigured()) return res.status(503).json({ error: "Meta app not configured" });
      const state = Buffer.from(JSON.stringify({ uid: req.uid, integration: "meta_lead_ads" })).toString("base64url");
      return res.json({ url: meta.getLeadAdsOAuthUrl(state) });
    }

    // Mailchimp OAuth
    if (integration.provider === "mailchimp") {
      const MC_CLIENT_ID = process.env.MAILCHIMP_CLIENT_ID;
      const MC_REDIRECT_URI = process.env.MAILCHIMP_REDIRECT_URI || "https://goswft.com/api/integrations/mailchimp/callback";

      if (!MC_CLIENT_ID) {
        return res.status(501).json({ error: "Mailchimp integration not configured yet. Please add MAILCHIMP_CLIENT_ID to your environment." });
      }

      const state = Buffer.from(JSON.stringify({
        uid: req.uid,
        integration: "mailchimp",
      })).toString("base64");

      const url = `https://login.mailchimp.com/oauth2/authorize?` +
        `client_id=${MC_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(MC_REDIRECT_URI)}` +
        `&response_type=code` +
        `&state=${state}`;

      return res.json({ url });
    }

    // Social messaging platforms — redirect to the social connect endpoint
    if (["facebook", "instagram", "whatsapp"].includes(integration.provider)) {
      return res.json({ socialConnect: true, provider: integration.provider });
    }

    res.status(400).json({ error: "Unsupported provider" });
  } catch (err) { next(err); }
});

// POST /api/integrations/:id/disconnect — remove an integration
router.post("/:id/disconnect", requireBusinessForNonQB, async (req, res, next) => {
  try {
    const integrationId = req.params.id;
    const userRef = db.collection("users").doc(req.uid);

    // Clear the integration data
    await userRef.update({
      [`integrations.${integrationId}.connected`]: false,
      [`integrations.${integrationId}.account`]: FieldValue.delete(),
      [`integrations.${integrationId}.tokens`]: FieldValue.delete(),
    });

    // Also clear legacy Gmail fields if disconnecting Gmail
    if (integrationId === "gmail") {
      await userRef.update({
        gmailConnected: false,
        gmailAddress: FieldValue.delete(),
        gmailTokens: FieldValue.delete(),
      });
    }

    // Also clear legacy Google Calendar fields
    if (integrationId === "google_calendar") {
      await userRef.update({
        googleCalendarConnected: false,
        googleCalendarTokens: FieldValue.delete(),
      }).catch(() => {}); // ignore if fields don't exist
    }

    // Social platforms — clear the full integration object
    if (["facebook", "instagram", "whatsapp"].includes(integrationId)) {
      await userRef.update({
        [`integrations.${integrationId}`]: FieldValue.delete(),
      }).catch(() => {});
    }

    // Stripe Connect — revoke on Stripe's side too, then clear the whole entry
    if (integrationId === "stripe") {
      try {
        const userSnap = await userRef.get();
        const accountId = userSnap.exists ? userSnap.data()?.integrations?.stripe?.accountId : null;
        if (accountId && process.env.STRIPE_CLIENT_ID) {
          const { getStripe } = require("../utils/stripe");
          await getStripe().oauth.deauthorize({
            client_id: process.env.STRIPE_CLIENT_ID,
            stripe_user_id: accountId,
          });
        }
      } catch (e) {
        // If Stripe already revoked, that's fine — just clear our side
        console.warn("[stripe-connect] deauthorize failed (non-fatal):", e.message);
      }
      await userRef.update({
        "integrations.stripe": FieldValue.delete(),
      }).catch(() => {});
    }

    console.log(`[integrations] Disconnected ${integrationId} for user ${req.uid}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[integrations] Disconnect error:`, err);
    next(err);
  }
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

// ── Stripe Connect OAuth callback ──
// Stripe redirects here after the owner authorizes on connect.stripe.com.
// We exchange the authorization code for their account id and stash it on
// the user doc. No auth middleware on this route — Stripe doesn't send our
// bearer token, we rely on the base64 `state` param (set in /connect) to
// identify which SWFT user is connecting.
async function stripeOAuthCallback(req, res) {
  try {
    const { code, state, error } = req.query;
    if (error) {
      console.warn("[stripe-connect] User denied or error:", error);
      return res.redirect(`/swft-connect?error=stripe_denied`);
    }
    if (!code || !state) return res.status(400).send("Missing code or state");

    let uid;
    try {
      const decoded = JSON.parse(Buffer.from(state, "base64url").toString());
      uid = decoded.uid;
      if (decoded.integration !== "stripe") throw new Error("integration mismatch");
    } catch (e) {
      return res.status(400).send("Invalid state parameter");
    }
    if (!uid) return res.status(400).send("Missing uid in state");

    const { getStripe } = require("../utils/stripe");
    const stripe = getStripe();

    // Exchange the auth code for the connected account id
    const tokenResp = await stripe.oauth.token({
      grant_type: "authorization_code",
      code,
    });

    const accountId = tokenResp.stripe_user_id;
    if (!accountId) throw new Error("No stripe_user_id in token response");

    // Fetch the connected account's display email for nicer UI
    let accountEmail = null;
    try {
      const account = await stripe.accounts.retrieve(accountId);
      accountEmail = account.email || account.business_profile?.name || null;
    } catch (_) { /* non-fatal */ }

    await db.collection("users").doc(uid).set({
      "integrations.stripe": {
        connected: true,
        accountId,
        accountEmail,
        connectedAt: Date.now(),
      },
    }, { merge: true });

    console.log(`[stripe-connect] Linked ${accountId} to user ${uid}`);
    res.redirect(`/swft-connect?connected=stripe`);
  } catch (err) {
    console.error("[stripe-connect] callback error:", err.message);
    res.redirect(`/swft-connect?error=stripe_oauth_failed`);
  }
}

module.exports = { router, googleIntegrationCallback, quickbooksCallback, stripeOAuthCallback };
