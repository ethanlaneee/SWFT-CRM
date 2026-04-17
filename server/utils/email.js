/**
 * Shared Gmail email sending utility.
 * Consolidates duplicated MIME construction from messages.js, automations.js, survey.js, team.js.
 */
const { google } = require("googleapis");
const { db } = require("../firebase");

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || "https://goswft.com/api/auth/google/callback"
  );
}

/**
 * Get an authenticated Gmail client for a user.
 * Refreshes tokens automatically if expired.
 * @param {object} user - User object with gmailTokens and _uid
 * @returns {{ gmail, fromAddr, fromName }}
 */
async function getGmailClient(user) {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials(user.gmailTokens);

  // Refresh token if expired
  const tokenInfo = await oauth2Client.getAccessToken();
  if (tokenInfo.token !== user.gmailTokens.access_token && user._uid) {
    await db.collection("users").doc(user._uid).set({
      gmailTokens: { ...user.gmailTokens, access_token: tokenInfo.token },
    }, { merge: true });
  }

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const fromAddr = user.gmailAddress || user.companyEmail || user.email;
  const fromName = user.company || user.name || "SWFT";

  return { gmail, fromAddr, fromName };
}

/**
 * Build the owner's email signature in text + HTML.
 *
 *   Best,
 *   {First Last}
 *   {Company}
 *
 * Returns { text, html }. Empty strings if no sensible name exists.
 */
function buildSignature(user = {}) {
  const first = (user.firstName || "").trim();
  const last  = (user.lastName  || "").trim();
  const fullName = [first, last].filter(Boolean).join(" ")
                || (user.name || "").trim();
  const company = (user.company || "").trim();

  if (!fullName && !company) return { text: "", html: "" };

  const lines = ["Best,"];
  if (fullName) lines.push(fullName);
  if (company)  lines.push(company);
  const text = "\n\n" + lines.join("\n");

  let html = `<p style="margin:24px 0 0;font-size:14px;line-height:1.5;color:#333;">Best,<br/>`;
  if (fullName) html += `<strong>${escapeHtml(fullName)}</strong><br/>`;
  if (company)  html += `<span style="color:#666;">${escapeHtml(company)}</span>`;
  html += `</p>`;

  return { text, html };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Heuristic: skip auto-append if the author already signed off.
const SIGNOFF_RE = /\b(best|thanks|thank you|regards|cheers|sincerely|talk soon)\b[\s,]*(\n|<br)/i;

function alreadySigned(textBody, htmlBody) {
  const text = (textBody || "").slice(-400);
  const html = (htmlBody || "").slice(-600);
  return SIGNOFF_RE.test(text) || SIGNOFF_RE.test(html);
}

/**
 * Append the owner's signature to an outgoing email body pair, unless the
 * author already signed off themselves.
 *
 * @param {object} user   - user doc (firstName, lastName, name, company)
 * @param {string} textBody
 * @param {string} htmlBody
 * @returns {{ textBody, htmlBody }}
 */
function withSignature(user, textBody, htmlBody) {
  if (alreadySigned(textBody, htmlBody)) return { textBody, htmlBody };
  const sig = buildSignature(user);
  if (!sig.text && !sig.html) return { textBody, htmlBody };
  return {
    textBody: (textBody || "") + sig.text,
    htmlBody: (htmlBody || "") + sig.html,
  };
}

/**
 * Encode a MIME message to base64url for Gmail API.
 */
function encodeMime(mime) {
  return Buffer.from(mime)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build a simple text+HTML email (no attachments).
 * Used by automations, surveys, team invites.
 */
function buildSimpleMime({ from, fromName, to, subject, textBody, htmlBody, inReplyTo, references, extraHeaders }) {
  const boundary = "swft_boundary_" + Date.now();
  let mime = "";
  mime += `From: ${fromName} <${from}>\r\n`;
  mime += `To: ${to}\r\n`;
  mime += `Subject: ${subject}\r\n`;
  if (inReplyTo) mime += `In-Reply-To: ${inReplyTo}\r\n`;
  if (references) mime += `References: ${references}\r\n`;
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      mime += `${key}: ${value}\r\n`;
    }
  }
  mime += `MIME-Version: 1.0\r\n`;
  mime += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`;
  mime += `--${boundary}\r\n`;
  mime += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
  mime += (textBody || "") + "\r\n\r\n";
  mime += `--${boundary}\r\n`;
  mime += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
  mime += (htmlBody || "") + "\r\n\r\n";
  mime += `--${boundary}--`;
  return mime;
}

/**
 * Send a simple email via Gmail (no attachments).
 * Used by automations, surveys, team invites.
 */
async function sendSimpleGmail(user, to, subject, textBody, htmlBody, opts = {}) {
  const { gmail, fromAddr, fromName } = await getGmailClient(user);
  const signed = opts.skipSignature
    ? { textBody, htmlBody }
    : withSignature(user, textBody, htmlBody);
  const mime = buildSimpleMime({ from: fromAddr, fromName, to, subject, textBody: signed.textBody, htmlBody: signed.htmlBody, inReplyTo: opts.inReplyTo, references: opts.references, extraHeaders: opts.extraHeaders });
  const encoded = encodeMime(mime);
  const requestBody = { raw: encoded };
  if (opts.threadId) requestBody.threadId = opts.threadId;
  const result = await gmail.users.messages.send({ userId: "me", requestBody });

  // Fetch RFC Message-ID for threading future replies
  let rfcMessageId = null;
  try {
    const sent = await gmail.users.messages.get({ userId: "me", id: result.data.id, format: "metadata", metadataHeaders: ["Message-ID"] });
    const headers = sent.data.payload?.headers || [];
    const msgIdHeader = headers.find(h => h.name.toLowerCase() === "message-id");
    rfcMessageId = msgIdHeader?.value || null;
  } catch (e) { /* ignore */ }

  return { messageId: result.data.id, threadId: result.data.threadId, rfcMessageId };
}

module.exports = { getOAuthClient, getGmailClient, encodeMime, buildSimpleMime, sendSimpleGmail, withSignature, buildSignature };
