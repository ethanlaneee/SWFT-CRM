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
const { router: messagesRouter, twilioIncomingHandler } = require("./routes/messages");
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

// ── Incoming message webhooks (no auth — called by Twilio) ──
app.post("/api/webhooks/twilio/sms", twilioIncomingHandler);

// GET version — lets you verify the endpoint is reachable in a browser
app.get("/api/webhooks/twilio/sms", (req, res) => {
  res.json({
    status: "ok",
    message: "Twilio SMS webhook endpoint is reachable. POST to this URL from Twilio.",
    twilioConfigured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    twilioPhone: process.env.TWILIO_PHONE_NUMBER ? "configured" : "missing",
    anthropicKey: process.env.ANTHROPIC_API_KEY ? "configured" : "missing",
    appUrl: process.env.APP_URL || "not set",
  });
});

// Full end-to-end diagnostic — simulates inbound SMS and reports every step
app.get("/api/webhooks/twilio/test", async (req, res) => {
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

    // Step 4: Check Twilio credentials
    const hasTwilio = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_API_KEY_SID && process.env.TWILIO_API_KEY_SECRET);
    diag.twilioConfigured = hasTwilio;
    diag.twilioPhone = process.env.TWILIO_PHONE_NUMBER || "not set";
    if (!hasTwilio) {
      diag.steps.push("FAIL: Twilio credentials missing (need ACCOUNT_SID, API_KEY_SID, API_KEY_SECRET)");
    } else {
      diag.steps.push("OK: Twilio credentials configured");
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

        // Test Twilio send
        try {
          const { sendSms } = require("./twilio");
          const testPhone = req.query.to || "";
          if (testPhone) {
            await sendSms(testPhone, "SWFT AI Receptionist test - this confirms SMS sending works!");
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

// ── Auth debug endpoint (temporary — remove after fixing 401 issue) ──
app.get("/api/auth-debug", async (req, res) => {
  const header = req.headers.authorization;
  const result = { hasHeader: !!header };
  if (header && header.startsWith("Bearer ")) {
    const token = header.split("Bearer ")[1];
    result.tokenLength = token.length;
    result.tokenPrefix = token.substring(0, 20) + "...";
    try {
      const decoded = await require("./firebase").authAdmin.verifyIdToken(token);
      result.verified = true;
      result.uid = decoded.uid;
      result.email = decoded.email;
      result.iss = decoded.iss;
      result.aud = decoded.aud;
    } catch (e) {
      result.verified = false;
      result.errorCode = e.code;
      result.errorMessage = e.message;
    }
  }
  // Also test basic Firebase Admin connectivity
  try {
    const listResult = await require("./firebase").authAdmin.listUsers(1);
    result.adminSdkWorks = true;
    result.sampleUserCount = listResult.users.length;
  } catch (e) {
    result.adminSdkWorks = false;
    result.adminSdkError = e.message;
  }
  res.json(result);
});

// ── Health check (before URL rewrite so /health doesn't become /health.html) ──
app.get("/health", async (req, res) => {
  let firebaseOk = false;
  let firebaseError = null;
  try {
    await require("./firebase").authAdmin.listUsers(1);
    firebaseOk = true;
  } catch (e) {
    firebaseError = e.message;
    console.error("[health] Firebase auth check failed:", e.message);
  }
  res.json({
    status: "ok",
    firebaseAuth: firebaseOk,
    firebaseError,
    twilioConfigured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    twilioPhone: process.env.TWILIO_PHONE_NUMBER || "not set",
    appUrl: process.env.APP_URL || "not set",
  });
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
app.use("/api/photos",        auth, checkAccess,  require("./routes/photos"));
app.use("/api/notifications", auth, checkAccess,  notificationsRouter);
app.use("/api/square",        auth, checkAccess,  squareRouter);
app.use("/api/import",        auth, checkAccess,  require("./routes/import"));
// Calendar: token generation needs auth, ICS feed is public (uses calendar token)
app.post("/api/calendar/token", auth, checkAccess, require("./routes/calendar").tokenHandler);
app.use("/api/calendar",      require("./routes/calendar"));
app.use("/api/google-business", auth, checkAccess, require("./routes/googleBusiness"));
app.use("/api/automations",   auth, checkAccess,  automationsRouter);
app.use("/api/dev",           auth,               require("./routes/dev"));


// ── Error handler ──
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`SWFT server running on port ${PORT}`);
});

// ── Automation worker ──
// Process pending scheduled messages every 30 seconds
setInterval(() => {
  processScheduledMessages().catch(err => console.error("Automation worker error:", err));
}, 30 * 1000);

// Run once on startup after 5 seconds
setTimeout(() => processScheduledMessages().catch(console.error), 5000);

// ── Follow-up Agent worker ──
// Scans for unsigned quotes, overdue invoices, completed jobs every 60 seconds
setInterval(() => {
  runFollowupAgent().catch(err => console.error("Follow-up agent error:", err));
}, 60 * 1000);

// Run once on startup after 10 seconds
setTimeout(() => runFollowupAgent().catch(console.error), 10000);
