require("dotenv").config();

// Prevent unhandled errors from crashing the server
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { auth } = require("./middleware/auth");
const { checkAccess } = require("./middleware/checkAccess");
const { router: billingRouter, webhookHandler } = require("./routes/billing");
const { router: paymentsRouter, webhookHandler: paymentsWebhookHandler } = require("./routes/payments");
const { router: squareRouter, squareWebhookHandler } = require("./routes/square");
const { router: notificationsRouter } = require("./routes/notifications");
const { router: messagesRouter, telnyxIncomingHandler } = require("./routes/messages");
const {
  router: socialMessagesRouter,
  facebookVerifyWebhook,
  facebookIncomingHandler,
  instagramVerifyWebhook,
  instagramIncomingHandler,
  whatsappVerifyWebhook,
  whatsappIncomingHandler,
} = require("./routes/socialMessages");
const { router: metaRouter, webhookVerify: metaWebhookVerify, webhookReceive: metaWebhookReceive, oauthCallback: metaOAuthCallback } = require("./routes/meta");
const { router: googleAuthRouter, googleCallback } = require("./routes/googleAuth");
const { router: integrationsRouter, googleIntegrationCallback, quickbooksCallback } = require("./routes/integrations");
const { router: automationsRouter, processScheduledMessages } = require("./routes/automations");
const { runFollowupAgent } = require("./ai/followup-agent");
const surveyRouter = require("./routes/survey");
const publicChatRouter = require("./routes/publicChat");

// ── Validate required environment variables on startup ──
const REQUIRED_ENV = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "ANTHROPIC_API_KEY"];
const RECOMMENDED_ENV = ["APP_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ENCRYPT_KEY"];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`FATAL: Missing required environment variable: ${key}`);
    process.exit(1);
  }
}
for (const key of RECOMMENDED_ENV) {
  if (!process.env[key]) {
    console.warn(`WARNING: Missing recommended environment variable: ${key}`);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security headers ──
app.use(helmet({
  contentSecurityPolicy: false,  // disabled — frontend uses inline scripts and external CDNs
  crossOriginEmbedderPolicy: false,  // disabled — Stripe embeds
  hsts: { maxAge: 63072000, includeSubDomains: true },
}));

// ── CORS — restrict to production domain ──
const APP_URL = process.env.APP_URL || "https://goswft.com";
app.use(cors({
  origin: [APP_URL, "https://goswft.com", "https://www.goswft.com"],
  credentials: true,
}));

// ── Rate limiting ──
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100,                 // 100 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again shortly." },
});
app.use("/api/", apiLimiter);

// Stricter limit on auth-sensitive endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // 20 attempts per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});
app.use("/api/me/status", authLimiter);
app.use("/api/billing/create-checkout-session", authLimiter);

// ── Stripe webhooks — MUST be registered before express.json() ──
// Stripe requires the raw request body to verify the webhook signature.
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), webhookHandler);
app.post("/api/payments/webhook", express.raw({ type: "application/json" }), paymentsWebhookHandler);
app.post("/api/square/webhook", express.json(), squareWebhookHandler);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// ── Incoming message webhooks (no auth — called by external platforms) ──
app.post("/api/webhooks/telnyx/sms", telnyxIncomingHandler);

// ── Social messaging webhooks (no auth — called by Meta) ──
app.get("/api/webhooks/facebook", facebookVerifyWebhook);
app.post("/api/webhooks/facebook", facebookIncomingHandler);
app.get("/api/webhooks/instagram", instagramVerifyWebhook);
app.post("/api/webhooks/instagram", instagramIncomingHandler);
app.get("/api/webhooks/whatsapp", whatsappVerifyWebhook);
app.post("/api/webhooks/whatsapp", whatsappIncomingHandler);
// Unified Meta webhook (single endpoint for all Meta products)
app.get("/api/webhooks/meta", metaWebhookVerify);
app.post("/api/webhooks/meta", metaWebhookReceive);
// Meta OAuth callback — no auth, Facebook redirects here after user authorizes
app.get("/api/meta/callback", metaOAuthCallback);

// GET version — lets you verify the endpoint is reachable in a browser
app.get("/api/webhooks/telnyx/sms", (req, res) => {
  res.json({
    status: "ok",
    message: "Telnyx SMS webhook endpoint is reachable. Configure this URL in your Telnyx Messaging Profile.",
    telnyxConfigured: !!process.env.TELNYX_API_KEY,
    telnyxPhone: process.env.TELNYX_PHONE_NUMBER ? "configured" : "missing",
    anthropicKey: process.env.ANTHROPIC_API_KEY ? "configured" : "missing",
    appUrl: process.env.APP_URL || "not set",
  });
});

// ── Inbound voice webhook — Telnyx calls this when someone dials your number ──
// Responds with TeXML to greet the caller and optionally collect info.
// Configure this URL in the Telnyx portal under your TeXML Application.
app.post("/api/webhooks/telnyx/voice", async (req, res) => {
  try {
    const { db } = require("./firebase");
    const toNumber = req.body?.To || req.body?.to || "";

    // Look up the business name for a personalised greeting
    let companyName = "our team";
    if (toNumber) {
      const snap = await db.collection("users").where("telnyxPhoneNumber", "==", toNumber).limit(1).get();
      if (!snap.empty) {
        const data = snap.docs[0].data();
        companyName = data.company || data.name || companyName;
      }
    }

    // TeXML response — greet the caller and record a voicemail
    const texml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thanks for calling ${companyName}. We are not available right now. Please leave your name, number, and a brief message after the tone and we will get back to you shortly.</Say>
  <Record maxLength="120" playBeep="true" transcribe="true" transcribeCallback="/api/webhooks/telnyx/transcription" />
  <Say voice="Polly.Joanna">Thank you. Goodbye.</Say>
</Response>`;

    res.type("text/xml").send(texml);
  } catch (err) {
    console.error("[voice-webhook] Error:", err.message);
    const fallback = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Thank you for calling. Please try again later.</Say>
</Response>`;
    res.type("text/xml").send(fallback);
  }
});

// ── Voice transcription callback — stores voicemail text as a notification ──
app.post("/api/webhooks/telnyx/transcription", async (req, res) => {
  try {
    const { db } = require("./firebase");
    const transcriptionText = req.body?.TranscriptionText || req.body?.transcription_text || "";
    const from = req.body?.From || req.body?.from || "";
    const to = req.body?.To || req.body?.to || "";

    if (transcriptionText && to) {
      const snap = await db.collection("users").where("telnyxPhoneNumber", "==", to).limit(1).get();
      if (!snap.empty) {
        const ownerUid = snap.docs[0].id;
        const ownerData = snap.docs[0].data();
        const orgId = ownerData.orgId || ownerUid;
        await db.collection("notifications").add({
          orgId,
          userId: ownerUid,
          type: "voicemail",
          title: `Voicemail from ${from}`,
          message: transcriptionText,
          phone: from,
          read: false,
          createdAt: Date.now(),
        });
        console.log(`[voice-webhook] Saved voicemail transcription for ${ownerUid} from ${from}`);
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("[transcription-webhook] Error:", err.message);
    res.sendStatus(200);
  }
});

// Full end-to-end diagnostic — simulates inbound SMS and reports every step
app.get("/api/webhooks/telnyx/test", async (req, res) => {
  const { db } = require("./firebase");
  const { getReceptionistConfig } = require("./ai/receptionist-agent");
  const { getPlan } = require("./plans");
  const { getUsage } = require("./usage");
  const diag = { steps: [] };

  try {
    // Step 1: Find user
    const allUsers = await db.collection("users").limit(1).get();
    if (allUsers.empty) { diag.steps.push("FAIL: No users in database"); return res.json(diag); }
    const user = allUsers.docs[0];
    const userData = user.data();
    const ownerUid = user.id;
    const orgId = userData.orgId || ownerUid;
    diag.steps.push(`OK: Found user ${userData.name || userData.email} (uid: ${ownerUid}, orgId: ${orgId})`);

    // Step 2: Check receptionist config
    const config = await getReceptionistConfig(orgId);
    diag.receptionistConfig = config;
    if (!config) {
      diag.steps.push(`FAIL: Receptionist not enabled for orgId: ${orgId}`);
    } else {
      diag.steps.push(`OK: Receptionist enabled (tone: ${config.tone})`);
    }

    // Step 3: Check SMS limits
    const plan = getPlan(userData.plan);
    const usage = await getUsage(ownerUid);
    diag.plan = { name: plan.name, smsLimit: plan.smsLimit };
    diag.usage = usage;
    if (usage.smsCount >= plan.smsLimit) {
      diag.steps.push(`FAIL: SMS limit reached (${usage.smsCount}/${plan.smsLimit})`);
    } else {
      diag.steps.push(`OK: SMS limit fine (${usage.smsCount}/${plan.smsLimit})`);
    }

    // Step 4: Check Telnyx credentials
    const hasTelnyx = !!process.env.TELNYX_API_KEY;
    diag.telnyxConfigured = hasTelnyx;
    diag.telnyxPhone = process.env.TELNYX_PHONE_NUMBER || "not set";
    diag.userTelnyxPhone = userData.telnyxPhoneNumber || "not provisioned";
    if (!hasTelnyx) {
      diag.steps.push("FAIL: TELNYX_API_KEY not configured");
    } else {
      diag.steps.push("OK: Telnyx API key configured");
    }

    // Step 5: Check Anthropic key
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    if (!hasAnthropic) {
      diag.steps.push("FAIL: ANTHROPIC_API_KEY not set");
    } else {
      diag.steps.push("OK: Anthropic API key configured");
    }

    // Step 6: Actually test the receptionist (dry run with Claude, skip SMS send)
    if (req.query.run === "1") {
      try {
        const Anthropic = require("@anthropic-ai/sdk");
        const anthropic = new Anthropic();
        diag.steps.push("INFO: Testing Claude API call...");
        const testReply = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 100,
          system: "You are a test. Reply with exactly: TEST_OK",
          messages: [{ role: "user", content: "ping" }],
        });
        const replyText = testReply.content[0]?.text || "";
        diag.steps.push(`OK: Claude replied: "${replyText.slice(0, 50)}"`);

        // Test Telnyx SMS send
        try {
          const { sendSms } = require("./telnyx");
          const testPhone = req.query.to || "";
          if (testPhone) {
            await sendSms(testPhone, "SWFT AI Receptionist test — Telnyx SMS confirmed!");
            diag.steps.push(`OK: Test SMS sent to ${testPhone}`);
          } else {
            diag.steps.push("SKIP: Add ?to=+1XXXXXXXXXX to test SMS sending");
          }
        } catch (smsErr) {
          diag.steps.push(`FAIL: SMS send error: ${smsErr.message}`);
        }
      } catch (aiErr) {
        diag.steps.push(`FAIL: Claude API error: ${aiErr.message}`);
      }
    } else {
      diag.steps.push("INFO: Add ?run=1 to actually test Claude + SMS. Add &to=+1XXXXXXXXXX to test sending.");
    }

    res.json(diag);
  } catch (err) {
    diag.steps.push(`ERROR: ${err.message}`);
    diag.stack = err.stack?.split("\n").slice(0, 3);
    res.json(diag);
  }
});

// ── OAuth callbacks (no auth — providers redirect here directly) ──
app.get("/api/auth/google/callback", googleIntegrationCallback);
app.get("/api/integrations/google/callback", googleIntegrationCallback);
app.get("/api/integrations/quickbooks/callback", quickbooksCallback);

// ── Diagnostic: test follow-up email ──
app.get("/api/debug/followup-test", async (req, res) => {
  try {
    const { sendFollowupEmail } = require("./ai/followup-agent");
    const { db } = require("./firebase");
    const snap = await db.collection("users").limit(1).get();
    if (snap.empty) return res.json({ error: "No users found" });
    const ownerUid = snap.docs[0].id;
    const to = req.query.to || "ethanmlane@gmail.com";
    await sendFollowupEmail(
      ownerUid,
      to,
      "SWFT Follow-up Agent — Test Email",
      `Hi Ethan,\n\nThis is a test from the SWFT Follow-up Agent. If you're seeing this, the email pipeline is working!\n\nThe agent will automatically send follow-ups for:\n- Unsigned quotes (day 1, 3, 7)\n- Overdue invoices (day 1, 3, 7)\n- Review requests (24h after job completion)\n\n— SWFT AI`
    );
    res.json({ success: true, sentTo: to });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Diagnostic: test calendar event creation ──
app.get("/api/debug/calendar-test", async (req, res) => {
  try {
    const { db } = require("./firebase");
    const { google } = require("googleapis");
    const snap = await db.collection("users").limit(1).get();
    if (snap.empty) return res.json({ error: "No users" });
    const data = snap.docs[0].data();
    const gcal = (data.integrations || {}).google_calendar;
    if (!gcal?.tokens) return res.json({ error: "No calendar tokens" });

    const client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    client.setCredentials(gcal.tokens);

    const calendar = google.calendar({ version: "v3", auth: client });
    const now = new Date();
    const later = new Date(now.getTime() + 60 * 60 * 1000);

    const event = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: "SWFT Test Event",
        start: { dateTime: now.toISOString(), timeZone: "America/Edmonton" },
        end: { dateTime: later.toISOString(), timeZone: "America/Edmonton" },
      },
    });
    res.json({ success: true, eventId: event.data.id, link: event.data.htmlLink });
  } catch (e) {
    res.json({ error: e.message, code: e.code, status: e.status });
  }
});

// ── Diagnostic: check integration status ──
app.get("/api/debug/integrations", async (req, res) => {
  try {
    const { db } = require("./firebase");
    const snap = await db.collection("users").limit(1).get();
    if (snap.empty) return res.json({ error: "No users" });
    const data = snap.docs[0].data();
    const integrations = data.integrations || {};
    const result = {};
    for (const [key, val] of Object.entries(integrations)) {
      result[key] = {
        connected: val.connected,
        account: val.account,
        hasTokens: !!val.tokens,
        hasAccessToken: !!val.tokens?.access_token,
        hasRefreshToken: !!val.tokens?.refresh_token,
        connectedAt: val.connectedAt,
      };
    }
    // Also check legacy gmail fields
    result._legacyGmail = {
      gmailConnected: data.gmailConnected,
      gmailAddress: data.gmailAddress,
      hasGmailTokens: !!data.gmailTokens,
    };
    res.json({ uid: snap.docs[0].id, integrations: result });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Debug: check email threading data for messages
app.get("/api/debug/email-threading", async (req, res) => {
  try {
    const { db } = require("./firebase");
    const snap = await db.collection("users").limit(1).get();
    if (snap.empty) return res.json({ error: "No users" });
    const uid = snap.docs[0].id;
    const msgSnap = await db.collection("messages")
      .where("userId", "==", uid)
      .where("type", "==", "email")
      .get();
    const msgs = msgSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0))
      .slice(0, 20)
      .map(m => ({
        id: m.id,
        direction: m.direction || "outbound",
        to: m.to,
        from: m.from,
        subject: (m.subject || "").substring(0, 50),
        gmailMessageId: m.gmailMessageId || null,
        gmailThreadId: m.gmailThreadId || null,
        rfcMessageId: m.rfcMessageId || null,
        isReply: m.isReply || false,
        inReplyTo: m.inReplyTo || null,
        sentAt: m.sentAt,
      }));
    res.json({ count: msgs.length, messages: msgs });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Public routes (no auth) ──
app.use("/api/survey", surveyRouter);
const publicChatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many messages. Please wait a moment." },
});
app.use("/api/public/chat", publicChatLimiter);
app.use("/api/public/chat", publicChatRouter);

// ── Serve frontend files ──
const staticRoot = path.join(__dirname, "..");

// Backward compat: old swft-shell URL → renamed swft-dashboard
app.get("/swft-shell", (req, res) => res.redirect("/swft-dashboard"));
app.get("/swft-shell.html", (req, res) => res.redirect("/swft-dashboard"));

// ── Root → landing page (must be before static middleware) ──
app.get("/", (req, res) => res.sendFile(path.join(staticRoot, "swft-landing.html")));

// ── Weather proxy (Pro+ only, avoids CORS issues with Open-Meteo) ──
app.get("/api/weather", auth, async (req, res) => {
  try {
    const { db } = require("./firebase");
    const userDoc = await db.collection("users").doc(req.uid).get();
    const plan = userDoc.exists ? (userDoc.data().plan || "starter") : "starter";
    if (plan === "starter") {
      return res.status(403).json({ error: "Weather forecasts require the Pro plan or higher.", plan: "starter" });
    }

    const { lat, lon, units } = req.query;
    const latitude = parseFloat(lat) || 30.27;
    const longitude = parseFloat(lon) || -97.74;
    const tempUnit = units === "celsius" ? "celsius" : "fahrenheit";

    // Try Open-Meteo first (16-day forecast)
    try {
      const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=weathercode,temperature_2m_max,temperature_2m_min&current_weather=true&temperature_unit=${tempUnit}&timezone=auto&forecast_days=16`;
      const omResp = await fetch(omUrl, { signal: AbortSignal.timeout(5000) });
      if (omResp.ok) {
        const data = await omResp.json();
        res.set("Cache-Control", "public, max-age=1800");
        return res.json(data);
      }
    } catch (e) { console.warn("Open-Meteo failed, trying fallback:", e.message); }

    // Fallback: wttr.in (3-day, always available, no key needed)
    try {
      const wttrResp = await fetch(`https://wttr.in/${latitude},${longitude}?format=j1`, { signal: AbortSignal.timeout(5000) });
      if (!wttrResp.ok) throw new Error("wttr.in " + wttrResp.status);
      const wttr = await wttrResp.json();

      // Map WWO weather codes to WMO codes
      const wwoToWmo = (code) => {
        const c = parseInt(code) || 0;
        if (c <= 113) return 0;   // Clear
        if (c <= 116) return 2;   // Partly cloudy
        if (c <= 122) return 3;   // Overcast
        if (c <= 143) return 45;  // Fog
        if (c <= 182) return 51;  // Drizzle/light precip
        if (c <= 248) return 45;  // Fog
        if (c <= 284) return 55;  // Freezing drizzle
        if (c <= 302) return 61;  // Light rain
        if (c <= 314) return 63;  // Rain
        if (c <= 356) return 65;  // Heavy rain
        if (c <= 377) return 73;  // Snow
        if (c <= 395) return 95;  // Thunder
        return 3;
      };

      const useCelsius = tempUnit === "celsius";
      const cc = wttr.current_condition?.[0] || {};
      const days = wttr.weather || [];

      // Build Open-Meteo compatible response
      const data = {
        current_weather: {
          temperature: parseFloat(useCelsius ? cc.temp_C : cc.temp_F) || 0,
          weathercode: wwoToWmo(cc.weatherCode),
        },
        daily: {
          time: days.map(d => d.date),
          weathercode: days.map(d => wwoToWmo(d.hourly?.[4]?.weatherCode || d.hourly?.[0]?.weatherCode || 0)),
          temperature_2m_max: days.map(d => parseFloat(useCelsius ? d.maxtempC : d.maxtempF) || 0),
          temperature_2m_min: days.map(d => parseFloat(useCelsius ? d.mintempC : d.mintempF) || 0),
        },
      };

      res.set("Cache-Control", "public, max-age=1800");
      return res.json(data);
    } catch (e2) { console.error("wttr.in fallback also failed:", e2.message); }

    res.status(502).json({ error: "All weather services unavailable" });
  } catch (e) {
    res.status(500).json({ error: "Internal error" });
  }
});

// ── Health check (before URL rewrite so /health doesn't become /health.html) ──
app.get("/health", async (req, res) => {
  const fb = require("./firebase");
  let firebaseOk = false;
  let firebaseError = null;
  try {
    await fb.authAdmin.listUsers(1);
    firebaseOk = true;
  } catch (e) {
    firebaseError = e.message;
    console.error("[health] Firebase auth check failed:", e.message);
  }
  res.json({
    status: "ok",
    firebaseAuth: firebaseOk,
    firebaseError,
    adminProjectId: fb.projectId,
    telnyxConfigured: !!process.env.TELNYX_API_KEY,
    appUrl: process.env.APP_URL || "not set",
  });
});

// ── Serve .md files as plain text for AI readability ──
app.get("*.md", (req, res, next) => {
  res.type("text/plain");
  next();
});

// Rewrite clean URLs → .html before static lookup (e.g. /swft-customers → /swft-customers.html)
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/") && !path.extname(req.path) && req.path !== "/") {
    req.url = req.url.replace(req.path, req.path + ".html");
  }
  next();
});

app.use(express.static(staticRoot, {
  etag: false,
  setHeaders: function(res, filePath) {
    // No caching for HTML/JS files so deploys take effect immediately
    if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ── Login hint — public, no auth ──
// Looks up a Firestore user by email and returns only first name + initials
// so the sign-in page can personalise the UI (à la Google) before the user
// authenticates. Intentionally returns no sensitive fields.
// Tight per-IP rate limit to prevent bulk email enumeration.
const hintLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests." },
});
app.get("/api/login-hint", hintLimiter, async (req, res) => {
  const email = (req.query.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.json({ exists: false });
  }
  try {
    const { db } = require("./firebase");
    const snap = await db.collection("users")
      .where("email", "==", email)
      .limit(1)
      .get();
    if (snap.empty) return res.json({ exists: false });
    const d = snap.docs[0].data();
    const firstName = d.firstName || d.name?.split(" ")[0] || "";
    const lastName  = d.lastName  || d.name?.split(" ").slice(1).join(" ") || "";
    const initials  = ((firstName[0] || "") + (lastName[0] || "")).toUpperCase() || "?";
    return res.json({ exists: true, firstName, initials });
  } catch (_) {
    return res.json({ exists: false });
  }
});

// ── Routes ──
// /api/me is auth-only: expired/canceled users must still reach their profile
// and billing page to upgrade. All other routes are fully gated by checkAccess.
app.use("/api/me",        auth,               require("./routes/user"));
app.use("/api/auth/google", auth,             googleAuthRouter);
app.use("/api/billing",   auth,               billingRouter);
app.use("/api/dashboard", auth, checkAccess,  require("./routes/dashboard"));
app.use("/api/customers", auth, checkAccess,  require("./routes/customers"));
app.use("/api/jobs",      auth, checkAccess,  require("./routes/jobs"));
app.use("/api/quotes",    auth, checkAccess,  require("./routes/quotes"));
app.use("/api/invoices",  auth, checkAccess,  require("./routes/invoices"));
app.use("/api/payments",  auth, checkAccess,  paymentsRouter);
app.use("/api/schedule",  auth, checkAccess,  require("./routes/schedule"));
app.use("/api/ai",        auth, checkAccess,  require("./routes/ai"));
app.use("/api/agents",    auth, checkAccess,  require("./routes/agents"));
const { router: teamRouter, publicRouter: teamPublicRouter } = require("./routes/team");
app.use("/api/team",        teamPublicRouter);                        // validate invite (no auth), join (has own auth)
app.use("/api/team",        auth, checkAccess, teamRouter);           // full auth — manage team
app.use("/api/integrations", auth, checkAccess, integrationsRouter);
app.use("/api/email",           auth, checkAccess,  require("./routes/email"));
app.use("/api/email-templates", auth, checkAccess,  require("./routes/emailTemplates"));
app.use("/api/messages",  auth, checkAccess,  messagesRouter);
app.use("/api/social",    auth, checkAccess,  socialMessagesRouter);
app.use("/api/meta",      auth, checkAccess,  metaRouter);
app.use("/api/photos",        auth, checkAccess,  require("./routes/photos"));
app.use("/api/notifications", auth, checkAccess,  notificationsRouter);
app.use("/api/square",        auth, checkAccess,  squareRouter);
app.use("/api/import",        auth, checkAccess,  require("./routes/import"));
// Calendar: token generation needs auth, ICS feed is public (uses calendar token)
app.post("/api/calendar/token", auth, checkAccess, require("./routes/calendar").tokenHandler);
app.use("/api/calendar",      require("./routes/calendar"));
app.use("/api/google-business", auth, checkAccess, require("./routes/googleBusiness"));
app.use("/api/automations",   auth, checkAccess,  automationsRouter);
app.use("/api/broadcasts",  auth, checkAccess,  require("./routes/broadcasts"));
app.use("/api/transcribe",    auth, checkAccess,  require("./routes/transcribe"));
app.use("/api/dev",           auth,               require("./routes/dev"));
app.use("/api/outreach",      auth,               require("./routes/outreach"));

// ── Public one-click unsubscribe for outreach emails (no auth — recipient clicks this) ──
app.get("/unsubscribe", async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).send("Missing id");
  try {
    const doc = await db.collection("outreach_leads").doc(id).get();
    if (doc.exists && doc.data().status !== "unsubscribed") {
      await doc.ref.update({ status: "unsubscribed" });
    }
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title><style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#f0f0f0;}.box{text-align:center;max-width:420px;padding:40px;}.check{font-size:48px;margin-bottom:16px;}h2{margin:0 0 8px;font-size:22px;}p{color:#7a7a7a;font-size:15px;line-height:1.5;}</style></head><body><div class="box"><div class="check">&#10003;</div><h2>You've been unsubscribed</h2><p>You won't receive any more emails from SWFT. We're sorry to see you go.</p></div></body></html>`);
  } catch (e) {
    console.error("[unsubscribe] Error:", e.message);
    res.status(500).send("Something went wrong. Please email info@goswft.com to unsubscribe.");
  }
});
app.post("/unsubscribe", async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).send("Missing id");
  try {
    const doc = await db.collection("outreach_leads").doc(id).get();
    if (doc.exists && doc.data().status !== "unsubscribed") {
      await doc.ref.update({ status: "unsubscribed" });
    }
    res.status(200).send("Unsubscribed");
  } catch (e) {
    res.status(500).send("Error");
  }
});

// ── Error handler ──
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`SWFT server running on port ${PORT}`);
});

// ── Automation worker ──
// Process pending scheduled messages every 5 minutes (was 30s — reduced to save Firestore reads)
setInterval(() => {
  processScheduledMessages().catch(err => console.error("Automation worker error:", err));
}, 5 * 60 * 1000);

// Run once on startup after 10 seconds
setTimeout(() => processScheduledMessages().catch(console.error), 10000);

// ── Follow-up Agent worker ──
// Scans for unsigned quotes, overdue invoices, completed jobs every 10 minutes (was 60s)
setInterval(() => {
  runFollowupAgent().catch(err => console.error("Follow-up agent error:", err));
}, 10 * 60 * 1000);

// Run once on startup after 30 seconds
setTimeout(() => runFollowupAgent().catch(console.error), 30000);

// ── Outreach lead finder worker ──
// Auto-discovers 15 leads per day via Google Places API.
// Runs every 24 hours. Checks Firestore for last run to avoid duplicating on restart.
const outreachRouter = require("./routes/outreach");

async function runLeadFinder() {
  try {
    if (!process.env.GOOGLE_MAPS_API_KEY) return;

    // Check last run time
    const configRef = db.collection("outreach_config").doc("lead_finder");
    const configDoc = await configRef.get();
    const lastRun = configDoc.exists ? configDoc.data().lastRun || 0 : 0;
    const hoursSinceRun = (Date.now() - lastRun) / (1000 * 60 * 60);

    if (hoursSinceRun < 20) return; // Don't run if less than 20 hours since last run

    // Read config for location and trades
    const location = configDoc.exists && configDoc.data().location ? configDoc.data().location : "Austin, TX";
    const trades = configDoc.exists && configDoc.data().trades ? configDoc.data().trades : ["plumber", "HVAC", "roofer", "electrician", "landscaper", "painter", "cleaner", "general contractor"];

    const result = await outreachRouter.findLeads({ location, trades, limit: 15 });
    await configRef.set({ lastRun: Date.now(), location, trades }, { merge: true });
    console.log(`[lead-finder] Auto-imported ${result.imported} leads`);
  } catch (e) {
    console.error("[lead-finder] Worker error:", e.message);
  }
}

// Check every 6 hours if it's time to find leads (runs once per 24h)
setInterval(() => runLeadFinder().catch(console.error), 6 * 60 * 60 * 1000);
// Run once on startup after 60 seconds
setTimeout(() => runLeadFinder().catch(console.error), 60000);

// ── Reply checker worker ──
// Polls Gmail threads every 2 hours to detect replies from outreach leads.
// Marks leads as "replied" so they don't get follow-ups.
async function runReplyChecker() {
  try {
    const result = await outreachRouter.checkReplies();
    if (result.replied > 0) {
      console.log(`[reply-checker] Checked ${result.checked} threads, found ${result.replied} new replies`);
    }
  } catch (e) {
    console.error("[reply-checker] Worker error:", e.message);
  }
}

// Check every 2 hours
setInterval(() => runReplyChecker().catch(console.error), 2 * 60 * 60 * 1000);
// Run once on startup after 90 seconds
setTimeout(() => runReplyChecker().catch(console.error), 90000);
