require("dotenv").config();
const crypto = require("crypto");

// Install the auto-redacting console wrapper as early as possible so any
// later code that logs (including third-party libraries) gets PII
// scrubbed before it hits Render's log stream. Call this BEFORE any
// other require that might log on import.
require("./utils/redactLogger").install();

// Prevent unhandled errors from crashing the server
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

const http = require("http");
const path = require("path");
const express = require("express");
const compression = require("compression");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { auth } = require("./middleware/auth");
const { checkAccess } = require("./middleware/checkAccess");
const { requirePlan } = require("./middleware/requirePlan");
const { router: billingRouter, webhookHandler } = require("./routes/billing");
const { router: paymentsRouter, webhookHandler: paymentsWebhookHandler } = require("./routes/payments");
const { router: squareRouter, squareWebhookHandler } = require("./routes/square");
const { router: notificationsRouter } = require("./routes/notifications");
const { router: messagesRouter } = require("./routes/messages");
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
const { router: integrationsRouter, googleIntegrationCallback, quickbooksCallback, stripeOAuthCallback } = require("./routes/integrations");
const { router: automationsRouter, processScheduledMessages } = require("./routes/automations");
const { router: aiSettingsRouter } = require("./routes/aiSettings");
const surveyRouter = require("./routes/survey");
const publicChatRouter = require("./routes/publicChat");
const { router: serviceRequestsRouter, publicRouter: intakePublicRouter } = require("./routes/serviceRequests");
const intakeFormsRouter = require("./routes/intakeForms");
const { router: phoneRouter, vapiWebhookHandler } = require("./routes/phone");

// ── Validate required environment variables on startup ──
const REQUIRED_ENV = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "ANTHROPIC_API_KEY"];
const RECOMMENDED_ENV = ["APP_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ENCRYPT_KEY", "STRIPE_CLIENT_ID"];

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

// Render terminates TLS upstream and forwards via an X-Forwarded-For header.
// Trust one hop so req.ip reflects the real client and express-rate-limit keys
// on the right address.
app.set("trust proxy", 1);

// ── Gzip/Brotli compression — apply before everything else ──
// Compresses HTML/JS/CSS by 60-80%, dramatically reducing transfer times
app.use(compression({ level: 6 }));

// ── Security headers ──
// CSP is enabled with structural protections (frame-ancestors, base-uri,
// form-action, object-src) which defend against clickjacking and base-tag
// hijacking even with 'unsafe-inline' present. 'unsafe-inline' for scripts
// stays because the frontend has thousands of inline event handlers and
// inline <script> blocks; removing it would require a full rewrite of every
// HTML page. The structural directives below give us the bulk of CSP's
// real-world value without that.
const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    "https://www.gstatic.com",
    "https://*.firebaseio.com",
    "https://*.googleapis.com",
    "https://js.stripe.com",
    "https://m.stripe.network",
    "https://connect.facebook.net",
    "https://www.facebook.com",
    "https://challenges.cloudflare.com",
    "https://cdnjs.cloudflare.com",
    "https://maps.googleapis.com",
    "https://www.google.com",
    "https://www.googletagmanager.com",
    "https://www.google-analytics.com",
  ],
  scriptSrcAttr: ["'unsafe-inline'"],
  styleSrc: [
    "'self'",
    "'unsafe-inline'",
    "https://fonts.googleapis.com",
    "https://cdnjs.cloudflare.com",
  ],
  fontSrc: [
    "'self'",
    "data:",
    "https://fonts.gstatic.com",
    "https://cdnjs.cloudflare.com",
  ],
  imgSrc: [
    "'self'",
    "data:",
    "blob:",
    "https:",  // job photos, customer avatars, third-party logos — too many sources to enumerate
  ],
  connectSrc: [
    "'self'",
    "https://*.googleapis.com",
    "https://*.firebaseio.com",
    "https://*.firebaseapp.com",
    "https://identitytoolkit.googleapis.com",
    "https://securetoken.googleapis.com",
    "https://firestore.googleapis.com",
    "https://firebasestorage.googleapis.com",
    "https://api.stripe.com",
    "https://api.open-meteo.com",
    "https://wttr.in",
    "https://api.qrserver.com",
    "https://api.pwnedpasswords.com",
    "https://graph.facebook.com",
    "https://www.facebook.com",
    "https://challenges.cloudflare.com",
    "wss://*.firebaseio.com",
  ],
  frameSrc: [
    "'self'",
    "https://js.stripe.com",
    "https://hooks.stripe.com",
    "https://m.stripe.network",
    "https://*.firebaseapp.com",
    "https://challenges.cloudflare.com",
    "https://www.google.com",
    "https://calendar.google.com",
  ],
  workerSrc: ["'self'", "blob:"],
  childSrc: ["'self'", "blob:"],
  mediaSrc: ["'self'", "blob:", "https:"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'self'"],
  upgradeInsecureRequests: [],
};

app.use(helmet({
  contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
  crossOriginEmbedderPolicy: false,  // disabled — Stripe embeds
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }, // Google sign-in popup
  crossOriginResourcePolicy: { policy: "cross-origin" },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
}));

// Permissions-Policy: lock down powerful browser APIs we don't use
app.use((req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "accelerometer=(), autoplay=(), camera=(self), encrypted-media=(), " +
    "fullscreen=(self), geolocation=(self), gyroscope=(), magnetometer=(), " +
    "microphone=(self), midi=(), payment=(self \"https://js.stripe.com\"), " +
    "picture-in-picture=(), sync-xhr=(self), usb=(), interest-cohort=()"
  );
  next();
});

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

// ── Auth-security endpoints (lockout, HIBP, session revocation) ──
// Public-facing lockout endpoints get an extra-tight per-IP limit on top of
// the apiLimiter. 30 precheck/attempt calls per 15 minutes per IP — enough
// for normal humans (and slow typists) but quickly throttles botnets.
const authSecurityLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});
app.use("/api/auth/login-precheck", authSecurityLimiter);
app.use("/api/auth/login-attempt", authSecurityLimiter);
app.use("/api/auth/check-password", authSecurityLimiter);

// ── Stripe webhooks — MUST be registered before express.json() ──
// Stripe requires the raw request body to verify the webhook signature.
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), webhookHandler);
app.post("/api/payments/webhook", express.raw({ type: "application/json" }), paymentsWebhookHandler);
app.post("/api/square/webhook", express.json(), squareWebhookHandler);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// ── Vapi phone webhook (no auth — called by Vapi after each call) ──
app.post("/api/phone/vapi-webhook", express.json(), vapiWebhookHandler);

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

// ── OAuth callbacks (no auth — providers redirect here directly) ──
app.get("/api/auth/google/callback", googleIntegrationCallback);
app.get("/api/integrations/google/callback", googleIntegrationCallback);
app.get("/api/integrations/quickbooks/callback", quickbooksCallback);
app.get("/api/integrations/stripe/callback", stripeOAuthCallback);


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

// ── Public intake form (no auth — customers submit from QR-code link) ──
const intakeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,                   // 30 submissions per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many submissions. Please try again later." },
});
app.use("/api/public/intake", intakeLimiter);
app.use("/api/public/intake", intakePublicRouter);

// ── Serve frontend files ──
const staticRoot = path.join(__dirname, "..");

// Backward compat: old swft-shell URL → renamed swft-dashboard
app.get("/swft-shell", (req, res) => res.redirect("/swft-dashboard"));
app.get("/swft-shell.html", (req, res) => res.redirect("/swft-dashboard"));

// ── Root → landing page (must be before static middleware) ──
app.get("/", (req, res) => res.sendFile(path.join(staticRoot, "swft-landing.html")));

// ── Weather proxy (Pro+ only, avoids CORS issues with Open-Meteo) ──
app.get("/api/weather", auth, requirePlan("pro"), async (req, res) => {
  try {
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
  etag: true,        // enables conditional requests (If-None-Match → 304)
  lastModified: true,
  setHeaders: function(res, filePath) {
    // HTML, JS, CSS: no-store = browser never caches, always fetches fresh copy
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
    // Images/fonts: safe to cache long-term — they don't change between deploys
    else if (/\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  }
}));

// ── Auth-security routes (lockout, HIBP, revoke-all) ──
const { router: authSecurityRouter } = require("./routes/authSecurity");
app.use("/api/auth", authSecurityRouter);

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

// ── Demo login — public, no auth ──
// Issues a Firebase custom token for a fresh per-session demo account so each
// visitor gets their own isolated sandbox. Data created in one demo session is
// never visible to any other demo visitor.
const demoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests." },
});
app.post("/api/demo-login", demoLimiter, async (req, res) => {
  try {
    const { authAdmin, db } = require("./firebase");

    // Unique UID per demo session — each visitor gets their own org
    const demoUid = "demo-" + crypto.randomBytes(8).toString("hex");
    const now = Date.now();

    await db.collection("users").doc(demoUid).set({
      uid: demoUid,
      email: "demo@goswft.com",
      firstName: "Jake",
      lastName: "Reynolds",
      name: "Jake Reynolds",
      displayName: "Jake Reynolds",
      company: "Reynolds Concrete LLC",
      businessName: "Reynolds Concrete LLC",
      plan: "pro",
      isSubscribed: true,
      accountStatus: "active",
      stripeCustomerId: "",
      trialStartDate: now,
      trialEndDate: now + 365 * 24 * 60 * 60 * 1000,
      role: "owner",
      orgId: demoUid,
      demoAccount: true,
      demoCreatedAt: now,
      updatedAt: now,
    });

    const token = await authAdmin.createCustomToken(demoUid);
    return res.json({ token });
  } catch (err) {
    console.error("[demo-login]", err.message);
    return res.status(500).json({ error: "Demo login unavailable." });
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
app.use("/api/agents",    auth, checkAccess, requirePlan("pro"), require("./routes/agents"));
const { router: teamRouter, publicRouter: teamPublicRouter } = require("./routes/team");
app.use("/api/team",        teamPublicRouter);                        // validate invite (no auth), join (has own auth)
app.use("/api/team",        auth, checkAccess, teamRouter);           // full auth — manage team
app.use("/api/tracker",     auth, checkAccess, require("./routes/tracker")); // team tracker — gated on tracker.view
app.use("/api/integrations", auth, checkAccess, integrationsRouter);
app.use("/api/team-chat",    auth, checkAccess, require("./routes/teamChat"));
app.use("/api/email",           auth, checkAccess,  require("./routes/email"));
app.use("/api/email-templates", auth, checkAccess,  require("./routes/emailTemplates"));
app.use("/api/messages",  auth, checkAccess,  messagesRouter);
app.use("/api/social",    auth, checkAccess,  socialMessagesRouter);
app.use("/api/meta",      auth, checkAccess,  metaRouter);
app.use("/api/photos",        auth, checkAccess,  require("./routes/photos"));
app.use("/api/notifications", auth, checkAccess,  notificationsRouter);
app.use("/api/square",        auth, checkAccess,  squareRouter);
app.use("/api/import",        auth, checkAccess,  require("./routes/import"));
app.use("/api/export",        auth, checkAccess, requirePlan("pro"), require("./routes/export"));
// Calendar: token generation needs auth, ICS feed is public (uses calendar token)
app.post("/api/calendar/token", auth, checkAccess, require("./routes/calendar").tokenHandler);
app.use("/api/calendar",      require("./routes/calendar"));
app.use("/api/google-business", auth, checkAccess, require("./routes/googleBusiness"));
app.use("/api/automations",       auth, checkAccess, requirePlan("pro"), automationsRouter);
app.use("/api/ai-settings",       auth, checkAccess, requirePlan("pro"), aiSettingsRouter);
app.get("/api/broadcasts/unsubscribe", require("./routes/broadcasts").unsubscribeHandler);
app.get("/api/broadcasts/resubscribe", require("./routes/broadcasts").resubscribeHandler);
// SNS posts with Content-Type: text/plain, so we need a permissive body parser here.
app.post(
  "/api/ses/webhook",
  express.json({ type: "*/*", limit: "1mb" }),
  require("./routes/sesWebhook").sesWebhookHandler
);
app.use("/api/broadcasts",        auth, checkAccess, requirePlan("pro"), require("./routes/broadcasts"));
app.use("/api/sending-domain",    auth, checkAccess, requirePlan("pro"), require("./routes/sendingDomain"));
app.use("/api/transcribe",        auth, checkAccess,  require("./routes/transcribe"));
app.use("/api/tts",               auth, checkAccess,  require("./routes/tts"));
app.use("/api/dev",               auth,               require("./routes/dev"));
app.use("/api/outreach",          auth,               require("./routes/outreach"));
app.use("/api/service-requests",  auth, checkAccess,  serviceRequestsRouter);
app.use("/api/intake-forms",      auth, checkAccess,  intakeFormsRouter);
app.use("/api/phone",             auth, checkAccess,  phoneRouter);
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

// ── HTTP server ──
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`SWFT server running on port ${PORT}`);
});

// ── Automation worker ──
// Process pending scheduled messages every 5 minutes (was 30s — reduced to save Firestore reads)
setInterval(() => {
  processScheduledMessages().catch(err => console.error("Automation worker error:", err));
}, 5 * 60 * 1000);

// Run once on startup after 10 seconds
setTimeout(() => processScheduledMessages().catch(console.error), 10000);

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
