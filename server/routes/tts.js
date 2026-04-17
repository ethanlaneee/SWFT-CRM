// ════════════════════════════════════════════════
// Text-to-Speech
//   Primary:  ElevenLabs (eleven_flash_v2_5 — ~75ms latency, lifelike)
//   Fallback: OpenAI tts-1 (used if ELEVENLABS_API_KEY isn't set or the
//             ElevenLabs call fails, so the voice never goes silent)
//
// POST /api/tts  body: { text: string, voice?: string }
// Returns: audio/mpeg bytes
// ════════════════════════════════════════════════

const express = require("express");
const OpenAI = require("openai");

const router = express.Router();

// ── ElevenLabs voice allowlist ──
// Default is "jessica" — labeled as Conversational in the ElevenLabs
// library. Owners can override by passing `voice` in the request body.
const ELEVEN_VOICES = {
  // Conversational voices (easy, casual tone)
  jessica:      "cgSgspJ2msm6clMCkdW9", // Conversational — default
  aria:         "9BWtsMINqrJLrRacOk9x", // Middle-aged female, expressive
  lily:         "pFZP5JQG7iQjIQuC4Bku", // Warm, clear
  // Classic / warm
  rachel:       "21m00Tcm4TlvDq8ikWAM", // Warm American female
  sarah:        "EXAVITQu4vr4xnSDxMaL", // Soft female
  // Male options
  antoni:       "ErXwobaYiN019PkySvjV", // Warm male
  adam:         "pNInz6obpgDQGcFmaJgB", // Deep male
  brian:        "nPczCjzI2devNBz1zQrb", // American male, friendly
};
const DEFAULT_ELEVEN_VOICE = "jessica";

const OPENAI_VOICES = new Set(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);
const DEFAULT_OPENAI_VOICE = "nova";

function pickElevenVoiceId(requested) {
  if (!requested) return ELEVEN_VOICES[DEFAULT_ELEVEN_VOICE];
  const key = String(requested).toLowerCase();
  return ELEVEN_VOICES[key] || ELEVEN_VOICES[DEFAULT_ELEVEN_VOICE];
}

async function speakViaElevenLabs(text, voice) {
  const voiceId = pickElevenVoiceId(voice);
  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_flash_v2_5",
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.75,
        style: 0.2,
        use_speaker_boost: true,
      },
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    const err = new Error(`ElevenLabs ${resp.status}: ${errText.slice(0, 200)}`);
    err.status = resp.status;
    throw err;
  }
  return Buffer.from(await resp.arrayBuffer());
}

async function speakViaOpenAI(text, voice) {
  const v = (voice && OPENAI_VOICES.has(voice)) ? voice : DEFAULT_OPENAI_VOICE;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const speech = await openai.audio.speech.create({
    model: "tts-1",
    voice: v,
    input: text,
  });
  return Buffer.from(await speech.arrayBuffer());
}

router.post("/", async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) return res.status(400).json({ error: "text is required" });
    if (text.length > 2000) {
      return res.status(400).json({ error: "text too long (max 2000 chars)" });
    }
    const voice = req.body?.voice;

    let buffer;
    let provider;

    if (process.env.ELEVENLABS_API_KEY) {
      try {
        buffer = await speakViaElevenLabs(text, voice);
        provider = "elevenlabs";
      } catch (err) {
        console.warn("[tts] ElevenLabs failed, falling back to OpenAI:", err.message);
        if (!process.env.OPENAI_API_KEY) throw err;
        buffer = await speakViaOpenAI(text, voice);
        provider = "openai-fallback";
      }
    } else if (process.env.OPENAI_API_KEY) {
      buffer = await speakViaOpenAI(text, voice);
      provider = "openai";
    } else {
      return res.status(503).json({ error: "No TTS provider configured. Set ELEVENLABS_API_KEY or OPENAI_API_KEY." });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("X-TTS-Provider", provider);
    res.setHeader("Cache-Control", "private, max-age=60");
    return res.send(buffer);
  } catch (err) {
    console.error("[tts] error:", err.message);
    return res.status(500).json({ error: err.message || "TTS failed" });
  }
});

module.exports = router;
