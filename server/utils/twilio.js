const twilio = require("twilio");

let _client = null;

function getTwilioClient() {
  if (!_client) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error("Twilio credentials not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)");
    _client = twilio(sid, token);
  }
  return _client;
}

/**
 * Send an SMS message via Twilio.
 * @param {string} to   - E.164 phone number e.g. +15551234567
 * @param {string} body - Message text
 * @returns {Promise<{ sid: string, status: string }>}
 */
async function sendSms(to, body) {
  const client = getTwilioClient();
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!from) throw new Error("TWILIO_PHONE_NUMBER env var not set");

  const msg = await client.messages.create({ to, from, body });
  return { sid: msg.sid, status: msg.status };
}

/**
 * Validate an inbound Twilio webhook signature.
 * Returns true if valid, false otherwise.
 */
function validateWebhook(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;
  const url = `${process.env.APP_URL}/api/sms/inbound`;
  return twilio.validateRequest(authToken, req.headers["x-twilio-signature"] || "", url, req.body || {});
}

module.exports = { getTwilioClient, sendSms, validateWebhook };
