const {
  SESv2Client,
  SendEmailCommand,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  DeleteEmailIdentityCommand,
} = require("@aws-sdk/client-sesv2");
const crypto = require("crypto");

let _sesClient = null;

function getSESClient() {
  if (_sesClient) return _sesClient;
  _sesClient = new SESv2Client({
    region: process.env.SES_REGION || process.env.AWS_REGION || "us-east-1",
  });
  return _sesClient;
}

function isConfigured() {
  return !!(
    (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN) &&
    process.env.AWS_SECRET_ACCESS_KEY
  );
}

// ── Unsubscribe token helpers ──────────────────────────────────────────────

const HMAC_KEY = process.env.ENCRYPT_KEY || "swft-default-broadcast-key";

function generateUnsubToken(email) {
  const payload = Buffer.from(email).toString("base64url");
  const sig = crypto.createHmac("sha256", HMAC_KEY).update(payload).digest("hex");
  return payload + "." + sig;
}

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
          <tr>
            <td style="padding:28px 32px 20px;border-bottom:1px solid #eeeeee;">
              <h1 style="margin:0;font-size:20px;font-weight:700;color:#1a1a1a;letter-spacing:0.5px;">${companyName}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 32px;">
              <div style="font-size:15px;line-height:1.7;color:#333333;">${htmlContent}</div>
            </td>
          </tr>
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

// ── Domain identity management ─────────────────────────────────────────────

/**
 * Create an SES domain identity with Easy DKIM enabled.
 * Returns the 3 DKIM tokens — caller must show these as CNAMEs:
 *   <token>._domainkey.<domain> → <token>.dkim.amazonses.com
 */
async function createDomainIdentity(domain) {
  const client = getSESClient();
  const res = await client.send(new CreateEmailIdentityCommand({
    EmailIdentity: domain,
    DkimSigningAttributes: {
      NextSigningKeyLength: "RSA_2048_BIT",
    },
  }));
  return {
    domain,
    dkimTokens: res.DkimAttributes?.Tokens || [],
    verifiedForSendingStatus: res.VerifiedForSendingStatus || false,
  };
}

async function getDomainIdentity(domain) {
  const client = getSESClient();
  try {
    const res = await client.send(new GetEmailIdentityCommand({
      EmailIdentity: domain,
    }));
    return {
      domain,
      verifiedForSendingStatus: res.VerifiedForSendingStatus || false,
      dkimTokens: res.DkimAttributes?.Tokens || [],
      dkimStatus: res.DkimAttributes?.Status || "NOT_STARTED",
    };
  } catch (err) {
    if (err.name === "NotFoundException") return null;
    throw err;
  }
}

async function deleteDomainIdentity(domain) {
  const client = getSESClient();
  try {
    await client.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain }));
    return true;
  } catch (err) {
    if (err.name === "NotFoundException") return true;
    throw err;
  }
}

function buildDkimRecords(domain, tokens) {
  return (tokens || []).map(token => ({
    type: "CNAME",
    name: `${token}._domainkey.${domain}`,
    value: `${token}.dkim.amazonses.com`,
  }));
}

// ── Send broadcast email via Amazon SES ────────────────────────────────────

async function sendBroadcastEmail(to, subject, textBody, opts = {}) {
  const defaultFromEmail = process.env.BROADCAST_FROM_EMAIL || "broadcasts@mail.goswft.com";
  const fromEmail = opts.fromEmail || defaultFromEmail;
  const fromName = opts.fromName || opts.companyName || process.env.BROADCAST_FROM_NAME || "SWFT";
  const html = buildHtml(textBody, opts);

  const params = {
    FromEmailAddress: `"${fromName}" <${fromEmail}>`,
    Destination: { ToAddresses: [to] },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: textBody, Charset: "UTF-8" },
          Html: { Data: html, Charset: "UTF-8" },
        },
      },
    },
  };

  if (opts.replyTo) {
    params.ReplyToAddresses = [opts.replyTo];
  }

  if (opts.unsubscribeUrl) {
    params.ListManagementOptions = undefined;
    params.Content.Simple.Headers = [
      { Name: "List-Unsubscribe", Value: `<${opts.unsubscribeUrl}>` },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ];
  }

  const client = getSESClient();
  return client.send(new SendEmailCommand(params));
}

module.exports = {
  sendBroadcastEmail,
  isConfigured,
  generateUnsubToken,
  verifyUnsubToken,
  createDomainIdentity,
  getDomainIdentity,
  deleteDomainIdentity,
  buildDkimRecords,
};
