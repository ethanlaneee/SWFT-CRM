const twilio = require("twilio");

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER || "+15873153452";

/** Master client authenticated with API key */
function getClient() {
  if (!ACCOUNT_SID || !API_KEY_SID || !API_KEY_SECRET) {
    throw new Error("Twilio credentials not configured");
  }
  return twilio(API_KEY_SID, API_KEY_SECRET, { accountSid: ACCOUNT_SID });
}

/** Master client authenticated with Auth Token (needed for sub-account management) */
function getMasterClient() {
  if (!ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio master credentials not configured (need ACCOUNT_SID + AUTH_TOKEN)");
  }
  return twilio(ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

/**
 * Create a Twilio sub-account for a new SWFT user.
 * @param {string} friendlyName - e.g. "SWFT - John's Plumbing"
 * @returns {{ subAccountSid: string, subAccountAuthToken: string }}
 */
async function createSubAccount(friendlyName) {
  const client = getMasterClient();
  const account = await client.api.accounts.create({ friendlyName });
  return {
    subAccountSid: account.sid,
    subAccountAuthToken: account.authToken,
  };
}

/**
 * Buy a local phone number for a sub-account.
 * Searches for available numbers in the US and provisions the first match.
 * @param {string} subAccountSid
 * @param {string} subAccountAuthToken
 * @param {string} webhookUrl - URL for incoming SMS webhook
 * @returns {{ phoneNumber: string, phoneSid: string }}
 */
async function buyPhoneNumber(subAccountSid, subAccountAuthToken, webhookUrl) {
  const subClient = twilio(subAccountSid, subAccountAuthToken);

  // Search for an available local number with SMS capability
  const available = await subClient.availablePhoneNumbers("US")
    .local.list({ smsEnabled: true, limit: 1 });

  if (!available.length) {
    throw new Error("No available phone numbers found. Please try again or contact support.");
  }

  // Purchase the number and configure the SMS webhook
  const purchased = await subClient.incomingPhoneNumbers.create({
    phoneNumber: available[0].phoneNumber,
    smsUrl: webhookUrl,
    smsMethod: "POST",
  });

  return {
    phoneNumber: purchased.phoneNumber,
    phoneSid: purchased.sid,
  };
}

/**
 * Close/suspend a Twilio sub-account (used when a SWFT user deletes their account).
 * @param {string} subAccountSid
 */
async function closeSubAccount(subAccountSid) {
  const client = getMasterClient();
  await client.api.accounts(subAccountSid).update({ status: "closed" });
}

/**
 * Send an SMS. Uses the user's dedicated sub-account if available,
 * otherwise falls back to the shared Twilio number.
 *
 * @param {string} to - recipient phone number
 * @param {string} body - message text
 * @param {{ subAccountSid?: string, subAccountAuthToken?: string, twilioPhoneNumber?: string }} [userTwilio]
 *   Per-user Twilio credentials (from their Firestore profile)
 */
async function sendSms(to, body, userTwilio) {
  let client;
  let from;

  if (userTwilio?.subAccountSid && userTwilio?.subAccountAuthToken && userTwilio?.twilioPhoneNumber) {
    // Per-user sub-account
    client = twilio(userTwilio.subAccountSid, userTwilio.subAccountAuthToken);
    from = userTwilio.twilioPhoneNumber;
  } else {
    // Shared fallback
    client = getClient();
    from = TWILIO_PHONE;
  }

  const message = await client.messages.create({ from, to, body });
  return { sid: message.sid, status: message.status };
}

/**
 * Extract Twilio config from a user data object (from Firestore).
 * Returns the config object to pass to sendSms, or null if not provisioned.
 */
function getUserTwilioConfig(userData) {
  if (userData?.twilioSubAccountSid && userData?.twilioSubAccountAuthToken && userData?.twilioPhoneNumber) {
    return {
      subAccountSid: userData.twilioSubAccountSid,
      subAccountAuthToken: userData.twilioSubAccountAuthToken,
      twilioPhoneNumber: userData.twilioPhoneNumber,
    };
  }
  return null;
}

module.exports = { sendSms, createSubAccount, buyPhoneNumber, closeSubAccount, getUserTwilioConfig };
