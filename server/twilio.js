const twilio = require("twilio");

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER || "+16812812146";

function getClient() {
  if (!ACCOUNT_SID || !API_KEY_SID || !API_KEY_SECRET) {
    throw new Error("Twilio credentials not configured");
  }
  return twilio(API_KEY_SID, API_KEY_SECRET, { accountSid: ACCOUNT_SID });
}

/**
 * Send an SMS using the shared Twilio number.
 * TODO: When Twilio is upgraded, switch to per-user sub-accounts
 * with dedicated phone numbers for each SWFT user.
 */
async function sendSms(to, body) {
  const client = getClient();
  const message = await client.messages.create({
    from: TWILIO_PHONE,
    to,
    body,
  });
  return { sid: message.sid, status: message.status };
}

module.exports = { sendSms };
