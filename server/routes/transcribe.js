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
    // Treat anything shorter than ~3 real chars or without a letter/digit as empty.
    if (rawText.length < 2 || !/[a-z0-9]/i.test(rawText)) {
      return res.json({ ok: true, text: "" });
    }

    // First pass: a lightweight regex that rewrites spelled-out digits into
    // numerals. Whisper consistently emits "five five five" for phone numbers
    // and "three two one Main Street" for addresses. Do this locally before
    // Claude so the cleaner has digits to work with.
    const normalised = spellOutDigitsToNumerals(rawText);

    // Clean with Claude — fix punctuation, capitalisation, strip filler words,
    // and enforce digit-form for phone numbers and street numbers.
    const anthropic = new Anthropic();
    const cleaned = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content:
            "You are a transcript cleaner for a CRM voice assistant. Your job is to " +
            "produce a clean, typed-text version of a voice input.\n\n" +
            "Rules (absolute):\n" +
            "- Return ONLY the cleaned text. No quotes, no explanations, no meta-commentary.\n" +
            "- Never ask questions or describe the input.\n" +
            "- If the input is incomplete or unclear, return it unchanged. Never invent content.\n" +
            "- Fix punctuation, capitalisation, and remove filler words (um, uh, like, you know).\n" +
            "- Convert spelled-out digits into numerals, especially in phone numbers, " +
            "  addresses, dollar amounts, and dates. Examples:\n" +
            "    'five five five dash zero one nine nine' → '555-0199'\n" +
            "    'five five five zero one nine nine'      → '555-0199'\n" +
            "    'one two three Main Street'              → '123 Main Street'\n" +
            "    'two thousand four hundred dollars'      → '\$2,400'\n" +
            "- Standardise phone numbers to ###-#### or ###-###-#### format.\n" +
            "- Reconstruct email addresses that were dictated with spoken punctuation:\n" +
            "    'john doe at gmail dot com'         → 'johndoe@gmail.com'\n" +
            "    'john dot doe at company dot com'   → 'john.doe@company.com'\n" +
            "    'nathanieltlane at gmail dot com'   → 'nathanieltlane@gmail.com'\n" +
            "  The word 'at' becomes '@' and 'dot' becomes '.' ONLY inside an email\n" +
            "  (i.e. when surrounded by word tokens that form a plausible address with\n" +
            "  a TLD like com/org/net/io/co). Leave 'at' and 'dot' alone in other\n" +
            "  contexts like 'meet at 3pm' or 'dot your i's'.\n" +
            "- Remove all whitespace inside an email address. Never include a space\n" +
            "  on either side of @ or . in an email.\n\n" +
            "Input:\n" + normalised,
        },
      ],
    });

    let text = (cleaned.content[0]?.text || normalised).trim();

    // Strip surrounding quotes if Claude added them
    text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();

    // Safety net: if Claude went off-script (responded with something much
    // longer than the source, or the source-sabotage phrases appeared),
    // fall back to the locally-normalised raw. Keep this conservative —
    // common words like "input" and "provide" are NOT triggers, we check
    // for whole-phrase meta-commentary instead.
    const wentOffScript = text.length > normalised.length * 3 + 40
      || /\b(voice transcription|the cleaned text|you (only|just) provided|i need the actual)\b/i.test(text);
    if (wentOffScript) {
      console.warn("[transcribe] cleaner went off-script, falling back to raw:", normalised);
      text = normalised;
    }

    return res.json({ ok: true, text });
  } catch (err) {
    console.error("[transcribe] error:", err.message);
    return res.status(500).json({ error: err.message || "Transcription failed" });
  }
});

// Map spoken digit words → numerals. Tolerates common Whisper quirks like
// "oh" for zero, "dash/hyphen" between digit groups.
const DIGIT_WORDS = {
  "zero": "0", "oh": "0", "o": "0",
  "one": "1", "two": "2", "to": "2", "too": "2",
  "three": "3", "four": "4", "for": "4", "fore": "4",
  "five": "5", "six": "6", "seven": "7",
  "eight": "8", "ate": "8", "nine": "9",
};

function spellOutDigitsToNumerals(text) {
  if (!text) return text;
  // Replace each spelled digit word with its numeral. \b keeps it from
  // mangling words like "forty" (not in the map) or "Forest".
  const wordPattern = new RegExp(
    "\\b(" + Object.keys(DIGIT_WORDS).join("|") + ")\\b",
    "gi"
  );
  let out = text.replace(wordPattern, (m) => DIGIT_WORDS[m.toLowerCase()] || m);

  // Normalise separators Whisper emits between digit groups.
  //   "555 dash 0199" → "555-0199"
  //   "555 hyphen 0199" → "555-0199"
  out = out.replace(/\b(\d)\s*(?:dash|hyphen|minus)\s*(\d)/gi, "$1-$2");

  // Collapse runs of digits separated only by spaces into contiguous blocks
  // so "5 5 5 0 1 9 9" becomes "5550199". Limit the greedy match to ≤20 so
  // we don't accidentally mash numeric prose together.
  out = out.replace(/(?:\b\d\b[\s-]*){3,20}/g, (m) => m.replace(/\s+/g, ""));

  return out;
}

module.exports = router;
