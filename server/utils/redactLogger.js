// Auto-redacting console wrapper.
//
// Render captures everything written to stdout/stderr and exposes it in
// the dashboard. That log stream is, in practice, a backup data store
// — anyone who can read it gets a slice of customer data going back as
// long as the retention window. We don't want it to contain raw emails,
// phone numbers, JWTs, or payment IDs.
//
// This module overrides console.log / warn / error / info / debug to
// run every string argument through a redactor. Tokens that match a
// known PII shape (email address, phone, credit-card-like number,
// Bearer JWT, Stripe key, Firebase ID token) are replaced with a
// short marker that preserves enough info to debug ("[email]",
// "[phone]", "[token]") without leaking the value.
//
// Cost: a regex pass per log argument. Negligible compared to whatever
// I/O actually drove the log call.
//
// To opt out for a single call, use console._raw(...) which is preserved
// in case you ever need to print a real value (e.g. while debugging).

const ORIG = {
  log:   console.log.bind(console),
  warn:  console.warn.bind(console),
  error: console.error.bind(console),
  info:  console.info.bind(console),
  debug: console.debug.bind(console),
};

// Order matters — the more specific patterns must run first, otherwise
// generic ones (like phone) will eat parts of more specific ones (like
// credit cards). Each entry is [regex, replacement-marker].
const PATTERNS = [
  // JSON Web Tokens (Firebase ID tokens, Stripe keys, …): three
  // base64url segments separated by dots. ~600+ chars for a Firebase
  // token, but we match anything 20+ chars per segment.
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[jwt]"],
  // Bearer tokens explicitly
  [/Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi, "Bearer [token]"],
  // Stripe secret / live keys
  [/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]{16,}\b/g, "[stripe-key]"],
  // Firebase API key shape (AIza...)
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[firebase-key]"],
  // Anthropic + OpenAI key shapes
  [/\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/g, "[ai-key]"],
  // Email addresses
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]"],
  // Credit-card-like 13-19 digit runs (with optional spaces / dashes)
  [/\b(?:\d[ -]?){12,18}\d\b/g, "[card]"],
  // Phone numbers — North-American 10-digit + international, with
  // optional parens / dashes / dots / spaces. Run AFTER credit-card so
  // we don't shadow it.
  [/\+?\d[\d ().\-]{8,16}\d/g, "[phone]"],
  // SSN / SIN
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]"],
];

function redactString(s) {
  if (typeof s !== "string") return s;
  // Most logs don't contain anything sensitive — fast-path skip if there
  // are no plausible trigger characters at all. Keeps the hot path cheap.
  if (!/[@\d.]/.test(s)) return s;
  let out = s;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}

function redactArg(arg) {
  if (arg == null) return arg;
  if (typeof arg === "string") return redactString(arg);
  if (arg instanceof Error) {
    // Error objects: redact the message but keep the stack.
    const e = new Error(redactString(arg.message));
    e.stack = arg.stack ? redactString(arg.stack) : undefined;
    e.code = arg.code;
    return e;
  }
  if (typeof arg !== "object") return arg;
  // Shallow-clone and redact string fields. Don't recurse into nested
  // objects — Render will JSON.stringify these and we don't want to
  // pay a deep-walk cost on every log line. If you need nested
  // redaction, redact your strings before logging.
  try {
    const out = Array.isArray(arg) ? arg.slice() : { ...arg };
    for (const k of Object.keys(out)) {
      if (typeof out[k] === "string") out[k] = redactString(out[k]);
    }
    return out;
  } catch {
    return arg;
  }
}

function wrap(method) {
  return function (...args) {
    method(...args.map(redactArg));
  };
}

function install() {
  if (console._raw) return; // already installed
  console._raw = ORIG;
  console.log   = wrap(ORIG.log);
  console.warn  = wrap(ORIG.warn);
  console.error = wrap(ORIG.error);
  console.info  = wrap(ORIG.info);
  console.debug = wrap(ORIG.debug);
}

module.exports = { install, redactString, redactArg };
