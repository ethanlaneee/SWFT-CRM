require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const { auth } = require("./middleware/auth");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Serve frontend files ──
app.use(express.static(path.join(__dirname, "..")));

// ── Routes ──
app.use("/api/dashboard", auth, require("./routes/dashboard"));
app.use("/api/me", auth, require("./routes/user"));
app.use("/api/customers", auth, require("./routes/customers"));
app.use("/api/jobs", auth, require("./routes/jobs"));
app.use("/api/quotes", auth, require("./routes/quotes"));
app.use("/api/invoices", auth, require("./routes/invoices"));
app.use("/api/schedule", auth, require("./routes/schedule"));
app.use("/api/ai", auth, require("./routes/ai"));

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
