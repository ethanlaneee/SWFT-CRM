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

// ── OAuth callbacks (no auth — providers redirect here directly) ──
app.get("/api/auth/google/callback", googleCallback);
app.get("/api/integrations/google/callback", googleIntegrationCallback);
app.get("/api/integrations/quickbooks/callback", quickbooksCallback);

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

// Rewrite clean URLs → .html before static lookup (e.g. /swft-customers → /swft-customers.html)
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/") && !path.extname(req.path) && req.path !== "/") {
    req.url = req.url.replace(req.path, req.path + ".html");
  }
  next();
});

app.use(express.static(staticRoot));

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
const { router: teamRouter, publicRouter: teamPublicRouter } = require("./routes/team");
app.use("/api/team",        teamPublicRouter);                        // validate invite (no auth), join (has own auth)
app.use("/api/team",        auth, checkAccess, teamRouter);           // full auth — manage team
app.use("/api/integrations", auth, checkAccess, integrationsRouter);
app.use("/api/email",     auth, checkAccess,  require("./routes/email"));
app.use("/api/messages",  auth, checkAccess,  messagesRouter);
app.use("/api/photos",        auth, checkAccess,  require("./routes/photos"));
app.use("/api/notifications", auth, checkAccess,  notificationsRouter);
app.use("/api/square",        auth, checkAccess,  squareRouter);
app.use("/api/import",        auth, checkAccess,  require("./routes/import"));
app.use("/api/google-business", auth, checkAccess, require("./routes/googleBusiness"));
app.use("/api/automations",   auth, checkAccess,  automationsRouter);
app.use("/api/dev",           auth,               require("./routes/dev"));

// ── Health check ──
app.get("/health", (req, res) => res.json({ status: "ok" }));

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
