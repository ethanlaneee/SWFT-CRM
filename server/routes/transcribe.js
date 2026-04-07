const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB — Whisper's max
});

// POST /api/transcribe
// Accepts: multipart/form-data with field "audio" (any browser MediaRecorder format)
// Returns: { ok: true, text: "cleaned transcript" }
router.post("/", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No audio file provided" });
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Determine a sensible filename extension so Whisper can detect the codec.
    // MediaRecorder on Chrome uses webm/opus; Safari uses mp4/aac.
    const mime = req.file.mimetype || "audio/webm";
    const ext = mime.includes("mp4") || mime.includes("m4a") ? "m4a"
              : mime.includes("ogg") ? "ogg"
              : "webm";

    const audioFile = new File(
      [req.file.buffer],
      `audio.${ext}`,
      { type: mime }
    );

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
    });

    const rawText = (transcription.text || "").trim();
    if (!rawText) {
      return res.json({ ok: true, text: "" });
    }

    // Clean with Claude — fix punctuation, capitalisation, strip filler words
    const anthropic = new Anthropic();
    const cleaned = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content:
            "Clean up this voice transcription for use in a business chat input. " +
            "Fix punctuation and capitalisation, remove filler words (um, uh, like, you know), " +
            "and make it read naturally as typed text. " +
            "Return ONLY the cleaned text with no explanation or quotes:\n\n" +
            rawText,
        },
      ],
    });

    const text = (cleaned.content[0]?.text || rawText).trim();
    return res.json({ ok: true, text });
  } catch (err) {
    console.error("[transcribe] error:", err.message);
    return res.status(500).json({ error: err.message || "Transcription failed" });
  }
});

module.exports = router;
