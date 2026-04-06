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
  const fromAddr = user.gmailAddress || user.email;
  const fromName = user.company || user.name || "SWFT";

  return { gmail, fromAddr, fromName };
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
function buildSimpleMime({ from, fromName, to, subject, textBody, htmlBody }) {
  const boundary = "swft_boundary_" + Date.now();
  let mime = "";
  mime += `From: ${fromName} <${from}>\r\n`;
  mime += `To: ${to}\r\n`;
  mime += `Subject: ${subject}\r\n`;
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
async function sendSimpleGmail(user, to, subject, textBody, htmlBody) {
  const { gmail, fromAddr, fromName } = await getGmailClient(user);
  const mime = buildSimpleMime({ from: fromAddr, fromName, to, subject, textBody, htmlBody });
  const encoded = encodeMime(mime);
  await gmail.users.messages.send({ userId: "me", requestBody: { raw: encoded } });
}

module.exports = { getOAuthClient, getGmailClient, encodeMime, buildSimpleMime, sendSimpleGmail };
