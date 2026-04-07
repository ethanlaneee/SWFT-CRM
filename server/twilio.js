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
 * Buy a local phone number for a sub-account in the user's country/region.
 * Searches for available numbers with SMS capability and provisions the first match.
 *
 * @param {string} subAccountSid
 * @param {string} subAccountAuthToken
 * @param {string} webhookUrl - URL for incoming SMS webhook
 * @param {{ countryCode?: string, areaCode?: string }} [options]
 *   countryCode: ISO 3166-1 alpha-2 (e.g. "US", "CA", "GB"). Defaults to "US".
 *   areaCode: Optional area/region code to get a number local to the user's city.
 * @returns {{ phoneNumber: string, phoneSid: string }}
 */
async function buyPhoneNumber(subAccountSid, subAccountAuthToken, webhookUrl, options = {}) {
  const subClient = twilio(subAccountSid, subAccountAuthToken);
  const countryCode = (options.countryCode || "US").toUpperCase();
  const searchParams = { smsEnabled: true, limit: 1 };

  // If an area code is provided, try to get a number in that region
  if (options.areaCode) {
    searchParams.areaCode = options.areaCode;
  }

  // Try local numbers first, then fall back to mobile (some countries only have mobile)
  let available = [];
  try {
    available = await subClient.availablePhoneNumbers(countryCode)
      .local.list(searchParams);
  } catch (err) {
    // Some countries (e.g. UK) may not support "local" — try mobile
    console.log(`[twilio] No local numbers for ${countryCode}, trying mobile:`, err.message);
  }

  if (!available.length) {
    try {
      available = await subClient.availablePhoneNumbers(countryCode)
        .mobile.list(searchParams);
    } catch (err) {
      console.log(`[twilio] No mobile numbers for ${countryCode}:`, err.message);
    }
  }

  // Last resort: if area code was too restrictive, retry without it
  if (!available.length && options.areaCode) {
    delete searchParams.areaCode;
    try {
      available = await subClient.availablePhoneNumbers(countryCode)
        .local.list(searchParams);
    } catch (_) { /* already logged */ }
    if (!available.length) {
      try {
        available = await subClient.availablePhoneNumbers(countryCode)
          .mobile.list(searchParams);
      } catch (_) { /* already logged */ }
    }
  }

  if (!available.length) {
    throw new Error(`No available phone numbers found for country ${countryCode}. Please try again or contact support.`);
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
