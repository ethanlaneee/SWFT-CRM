// ════════════════════════════════════════════════
// Text-to-Speech — OpenAI tts-1 with a friendly default voice
// POST /api/tts  body: { text: string, voice?: string }
// Returns: audio/mpeg bytes
// ════════════════════════════════════════════════

const express = require("express");
const OpenAI = require("openai");

const router = express.Router();

const ALLOWED_VOICES = new Set(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);
const DEFAULT_VOICE = "nova"; // conversational, warm — good fit for an assistant

router.post("/", async (req, res) => {
  try {
    const textRaw = (req.body && req.body.text) || "";
    const text = String(textRaw).trim();
    if (!text) return res.status(400).json({ error: "text is required" });
    if (text.length > 2000) {
      // Hard cap to keep per-request latency + cost bounded. AI replies in
      // this app run ~40–300 chars; 2000 is a generous ceiling.
      return res.status(400).json({ error: "text too long (max 2000 chars)" });
    }

    const voice = ALLOWED_VOICES.has(req.body?.voice) ? req.body.voice : DEFAULT_VOICE;

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const speech = await openai.audio.speech.create({
      model: "tts-1",
      voice,
      input: text,
    });

    const buffer = Buffer.from(await speech.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buffer.length);
    // Short private cache — repeats of the same reply (e.g. replay) avoid a round-trip
    res.setHeader("Cache-Control", "private, max-age=60");
    return res.send(buffer);
  } catch (err) {
    console.error("[tts] error:", err.message);
    return res.status(500).json({ error: err.message || "TTS failed" });
  }
});

module.exports = router;
