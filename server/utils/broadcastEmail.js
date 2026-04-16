/**
 * Broadcast email utility — sends email campaigns via SWFT's own SMTP infrastructure.
 * Replaces Gmail-based broadcast sending with a configurable SMTP transport.
 *
 * Environment variables:
 *   BROADCAST_SMTP_HOST   – SMTP server hostname (required)
 *   BROADCAST_SMTP_PORT   – SMTP port (default 587)
 *   BROADCAST_SMTP_USER   – SMTP auth username (required)
 *   BROADCAST_SMTP_PASS   – SMTP auth password (required)
 *   BROADCAST_FROM_EMAIL  – From address (default "broadcasts@mail.goswft.com")
 *   BROADCAST_FROM_NAME   – From display name (default "SWFT")
 *   ENCRYPT_KEY           – HMAC key for unsubscribe tokens
 */

const nodemailer = require("nodemailer");
const crypto = require("crypto");

// ── SMTP transport (lazy-initialised) ──────────────────────────────────────

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  _transporter = nodemailer.createTransport({
    host: process.env.BROADCAST_SMTP_HOST,
    port: parseInt(process.env.BROADCAST_SMTP_PORT, 10) || 587,
    secure: (parseInt(process.env.BROADCAST_SMTP_PORT, 10) || 587) === 465,
    auth: {
      user: process.env.BROADCAST_SMTP_USER,
      pass: process.env.BROADCAST_SMTP_PASS,
    },
  });

  return _transporter;
}

// ── Configuration check ────────────────────────────────────────────────────

function isConfigured() {
  return !!(
    process.env.BROADCAST_SMTP_HOST &&
    process.env.BROADCAST_SMTP_USER &&
    process.env.BROADCAST_SMTP_PASS
  );
}

// ── Unsubscribe token helpers ──────────────────────────────────────────────

const HMAC_KEY = process.env.ENCRYPT_KEY || "swft-default-broadcast-key";

/**
 * Generate an HMAC-signed token that encodes the subscriber email.
 * Format: base64url(email) + "." + hex(hmac)
 */
function generateUnsubToken(email) {
  const payload = Buffer.from(email).toString("base64url");
  const sig = crypto.createHmac("sha256", HMAC_KEY).update(payload).digest("hex");
  return payload + "." + sig;
}

/**
 * Verify and decode an unsubscribe token.
 * Returns the email string on success, or null if invalid.
 */
function verifyUnsubToken(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", HMAC_KEY).update(payload).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) {
    return null;
  }
  try {
    return Buffer.from(payload, "base64url").toString("utf-8");
  } catch {
    return null;
  }
}

// ── HTML email template ────────────────────────────────────────────────────

function buildHtml(textBody, opts = {}) {
  const companyName = opts.companyName || "SWFT";
  const unsubscribeUrl = opts.unsubscribeUrl || "#";

  // Convert plain-text line breaks to <br> for the HTML version
  const htmlContent = textBody
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${companyName}</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="padding:28px 32px 20px;border-bottom:1px solid #eeeeee;">
              <h1 style="margin:0;font-size:20px;font-weight:700;color:#1a1a1a;letter-spacing:0.5px;">${companyName}</h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:28px 32px 32px;">
              <div style="font-size:15px;line-height:1.7;color:#333333;">${htmlContent}</div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px 24px;border-top:1px solid #eeeeee;background-color:#fafafa;">
              <p style="margin:0 0 6px;font-size:12px;color:#999999;">${companyName} &middot; Powered by <a href="https://goswft.com" style="color:#999999;text-decoration:underline;">SWFT</a></p>
              <p style="margin:0;font-size:12px;"><a href="${unsubscribeUrl}" style="color:#999999;text-decoration:underline;">Unsubscribe</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Send broadcast email ───────────────────────────────────────────────────

/**
 * Send a single broadcast email.
 *
 * @param {string} to           – Recipient email address
 * @param {string} subject      – Email subject
 * @param {string} textBody     – Plain-text message body
 * @param {object} opts
 * @param {string} opts.companyName    – Sender company name (header + footer)
 * @param {string} opts.replyTo        – Reply-To address
 * @param {string} opts.unsubscribeUrl – One-click unsubscribe URL
 * @returns {Promise<object>} nodemailer send result
 */
async function sendBroadcastEmail(to, subject, textBody, opts = {}) {
  const fromEmail = process.env.BROADCAST_FROM_EMAIL || "broadcasts@mail.goswft.com";
  const fromName = process.env.BROADCAST_FROM_NAME || "SWFT";
  const html = buildHtml(textBody, opts);

  const mailOptions = {
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject,
    text: textBody,
    html,
  };

  if (opts.replyTo) {
    mailOptions.replyTo = opts.replyTo;
  }

  if (opts.unsubscribeUrl) {
    mailOptions.headers = {
      "List-Unsubscribe": `<${opts.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  }

  const transporter = getTransporter();
  return transporter.sendMail(mailOptions);
}

module.exports = {
  sendBroadcastEmail,
  isConfigured,
  generateUnsubToken,
  verifyUnsubToken,
};
