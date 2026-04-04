const router = require("express").Router();
const { db } = require("../firebase");
const { runHybridAgent } = require("../ai/agent");
const { clearHistory } = require("../ai/memory");
const { listConnectors } = require("../ai/manus");

// POST /api/ai/chat — send a message to the hybrid AI agent (Claude + Manus)
router.post("/chat", async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    // Get user profile for context
    const userDoc = await db.collection("users").doc(req.uid).get();
    const userProfile = userDoc.exists ? userDoc.data() : { name: "", company: "" };

    const result = await runHybridAgent(req.uid, message, userProfile);
    res.json(result);
  } catch (err) { next(err); }
});

// DELETE /api/ai/history — clear conversation history
router.delete("/history", async (req, res, next) => {
  try {
    await clearHistory(req.uid);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Connector management (Manus tools) ──

// GET /api/ai/connectors — list available Manus connectors
router.get("/connectors", async (req, res, next) => {
  try {
    if (!process.env.MANUS_API_KEY) {
      return res.json({ connectors: [], enabled: false });
    }
    const data = await listConnectors();
    res.json({ connectors: data.connectors || [], enabled: true });
  } catch (err) { next(err); }
});

// GET /api/ai/connectors/user — get the current user's enabled connectors
router.get("/connectors/user", async (req, res, next) => {
  try {
    const userDoc = await db.collection("users").doc(req.uid).get();
    const data = userDoc.exists ? userDoc.data() : {};
    res.json({ connectors: data.manusConnectors || [] });
  } catch (err) { next(err); }
});

// PUT /api/ai/connectors/user — update the user's enabled connectors
router.put("/connectors/user", async (req, res, next) => {
  try {
    const { connectors } = req.body;
    if (!Array.isArray(connectors)) {
      return res.status(400).json({ error: "connectors must be an array" });
    }
    await db.collection("users").doc(req.uid).update({
      manusConnectors: connectors,
      updatedAt: Date.now(),
    });
    res.json({ success: true, connectors });
  } catch (err) { next(err); }
});

module.exports = router;
