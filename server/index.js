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
const cors = require("cors");
const { auth } = require("./middleware/auth");
const { checkAccess } = require("./middleware/checkAccess");
const { router: billingRouter, webhookHandler } = require("./routes/billing");
const { router: messagesRouter, twilioIncomingHandler, postmarkIncomingHandler } = require("./routes/messages");
const { router: googleAuthRouter, googleCallback } = require("./routes/googleAuth");
const { router: integrationsRouter, googleIntegrationCallback, quickbooksCallback } = require("./routes/integrations");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// ── Stripe webhook — MUST be registered before express.json() ──
// Stripe requires the raw request body to verify the webhook signature.
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), webhookHandler);

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded webhooks

// ── Incoming message webhooks (no auth — called by Twilio/Postmark) ──
app.post("/api/webhooks/twilio/sms", twilioIncomingHandler);
app.post("/api/webhooks/postmark/inbound", postmarkIncomingHandler);

// ── OAuth callbacks (no auth — providers redirect here directly) ──
app.get("/api/auth/google/callback", googleCallback);
app.get("/api/integrations/google/callback", googleIntegrationCallback);
app.get("/api/integrations/quickbooks/callback", quickbooksCallback);

// ── Serve frontend files ──
const staticRoot = path.join(__dirname, "..");

// Backward compat: old swft-shell URL → renamed swft-dashboard
app.get("/swft-shell", (req, res) => res.redirect("/swft-dashboard"));
app.get("/swft-shell.html", (req, res) => res.redirect("/swft-dashboard"));

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
app.use("/api/schedule",  auth, checkAccess,  require("./routes/schedule"));
app.use("/api/ai",        auth, checkAccess,  require("./routes/ai"));
app.use("/api/integrations", auth, checkAccess, integrationsRouter);
app.use("/api/email",     auth, checkAccess,  require("./routes/email"));
app.use("/api/messages",  auth, checkAccess,  messagesRouter);

// ── Root redirect ──
app.get("/", (req, res) => res.redirect("/swft-landing"));

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
