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
    // Whisper often returns "you" / "." / "thanks" on silence or mic noise.
    // Treat anything shorter than ~3 real chars or without a letter as empty.
    if (rawText.length < 3 || !/[a-z]/i.test(rawText)) {
      return res.json({ ok: true, text: "" });
    }

    // Clean with Claude — fix punctuation, capitalisation, strip filler words.
    // Hard-constrain the prompt so it can't wander when the input is noisy —
    // if the cleaner can't produce meaningful text, it must return the raw
    // string unchanged (never a meta-message about needing more input).
    const anthropic = new Anthropic();
    const cleaned = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content:
            "You are a transcript cleaner. Your ONLY job is to fix punctuation, " +
            "capitalisation, and remove filler words (um, uh, like, you know) " +
            "from voice transcriptions.\n\n" +
            "Rules (absolute):\n" +
            "- Return ONLY the cleaned text. No quotes, no explanations, no meta-commentary.\n" +
            "- Never ask questions or describe the input.\n" +
            "- If the input is incomplete, unclear, or just a word or two, return it unchanged. Never invent content.\n" +
            "- Never output more than the original length plus a few characters.\n\n" +
            "Input:\n" + rawText,
        },
      ],
    });

    let text = (cleaned.content[0]?.text || rawText).trim();

    // Strip surrounding quotes if Claude added them
    text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();

    // Safety net: if Claude went off-script (responded with something much
    // longer than the source, or contains self-reference), fall back to raw.
    const wentOffScript = text.length > rawText.length * 3 + 20
      || /\bvoice transcription\b|\bprovide\b|\binput\b|\b(you (only|just)) provided\b/i.test(text);
    if (wentOffScript) {
      console.warn("[transcribe] cleaner went off-script, falling back to raw:", rawText);
      text = rawText;
    }

    return res.json({ ok: true, text });
  } catch (err) {
    console.error("[transcribe] error:", err.message);
    return res.status(500).json({ error: err.message || "Transcription failed" });
  }
});

module.exports = router;
