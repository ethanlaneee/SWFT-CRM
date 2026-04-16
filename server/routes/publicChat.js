const router = require("express").Router();
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic();

// In-memory session store (keyed by IP + short session ID)
// Auto-cleans sessions older than 30 minutes
const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL) sessions.delete(key);
  }
}, 5 * 60 * 1000);

const SYSTEM_PROMPT = `You are SWFT's website assistant. You help visitors learn about SWFT — an AI-powered CRM built for home service businesses (HVAC, plumbing, electrical, landscaping, cleaning, etc.).

KEY FACTS:
- SWFT replaces spreadsheets and 6+ different apps with one platform
- Features: Customer management, job tracking, quotes, invoices, scheduling, email (Gmail integration), AI assistant, team management, team chat, automations, broadcasts, QuickBooks integration, Google Calendar sync, data import
- Pricing: Starter $89/mo (75 AI messages, up to 5 users), Pro $179/mo (1,000 AI messages, up to 10 users, AI automations, broadcasts, weather), Business $349/mo (unlimited AI & team members)
- All plans include a 14-day free trial
- Built specifically for home service pros who are busy and need things simple
- Sign up at goswft.com/swft-checkout

RULES:
- Keep responses short — 1-3 sentences max. Be conversational, not salesy.
- If someone asks something you don't know about SWFT, say so honestly.
- Don't make up features that aren't listed above.
- If someone seems interested, suggest they start a free trial.
- Don't discuss competitors by name.
- For support questions from existing users, direct them to sign in to their dashboard.
- Be friendly and casual — like texting, not a corporate FAQ.`;

router.post("/", async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message || typeof message !== "string" || message.length > 1000) {
      return res.status(400).json({ error: "Message is required (max 1000 chars)" });
    }

    const clientIp = req.headers["x-forwarded-for"] || req.ip || "unknown";
    const sKey = `${clientIp}:${sessionId || "default"}`;

    if (!sessions.has(sKey)) {
      sessions.set(sKey, { messages: [], lastActivity: Date.now() });
    }
    const session = sessions.get(sKey);
    session.lastActivity = Date.now();

    // Keep last 10 messages to limit context size
    session.messages.push({ role: "user", content: message });
    if (session.messages.length > 10) {
      session.messages = session.messages.slice(-10);
    }

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: session.messages,
    });

    const reply = response.content[0].text;
    session.messages.push({ role: "assistant", content: reply });

    res.json({ reply });
  } catch (err) {
    console.error("Public chat error:", err.message);
    res.status(500).json({ error: "Chat unavailable right now" });
  }
});

module.exports = router;
