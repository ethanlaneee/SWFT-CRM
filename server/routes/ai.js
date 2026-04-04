const router = require("express").Router();
const { db } = require("../firebase");
const { runAgent } = require("../ai/agent");
const { clearHistory } = require("../ai/memory");

// POST /api/ai/chat — send a message to the AI agent
router.post("/chat", async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    // Get user profile for context
    const userDoc = await db.collection("users").doc(req.uid).get();
    const userProfile = userDoc.exists ? userDoc.data() : { name: "", company: "" };

    const result = await runAgent(req.uid, message, userProfile);
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

module.exports = router;
