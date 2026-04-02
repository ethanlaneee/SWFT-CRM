require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const { auth } = require("./middleware/auth");
const { checkAccess } = require("./middleware/checkAccess");
const { router: billingRouter, webhookHandler } = require("./routes/billing");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// ── Stripe webhook — MUST be registered before express.json() ──
// Stripe requires the raw request body to verify the webhook signature.
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), webhookHandler);

app.use(express.json());

// ── Serve frontend files ──
app.use(express.static(path.join(__dirname, "..")));

// ── Routes ──
// /api/me is auth-only: expired/canceled users must still reach their profile
// and billing page to upgrade. All other routes are fully gated by checkAccess.
app.use("/api/me",        auth,               require("./routes/user"));
app.use("/api/billing",   auth,               billingRouter);
app.use("/api/dashboard", auth, checkAccess,  require("./routes/dashboard"));
app.use("/api/customers", auth, checkAccess,  require("./routes/customers"));
app.use("/api/jobs",      auth, checkAccess,  require("./routes/jobs"));
app.use("/api/quotes",    auth, checkAccess,  require("./routes/quotes"));
app.use("/api/invoices",  auth, checkAccess,  require("./routes/invoices"));
app.use("/api/schedule",  auth, checkAccess,  require("./routes/schedule"));
app.use("/api/ai",        auth, checkAccess,  require("./routes/ai"));
app.use("/api/email",     auth, checkAccess,  require("./routes/email"));
app.use("/api/messages",  auth, checkAccess,  require("./routes/messages"));

// ── Root redirect ──
app.get("/", (req, res) => res.redirect("/swft-login.html"));

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
