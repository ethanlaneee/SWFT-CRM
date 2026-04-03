const twilio = require("twilio");

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;

// Master client authenticated with API key
function getMasterClient() {
  if (!ACCOUNT_SID || !API_KEY_SID || !API_KEY_SECRET) {
    throw new Error("Twilio credentials not configured");
  }
  return twilio(API_KEY_SID, API_KEY_SECRET, { accountSid: ACCOUNT_SID });
}

/**
 * Create a Twilio sub-account for a SWFT user.
 * @param {string} friendlyName - e.g. "SWFT-<uid>" or company name
 * @returns {{ sid: string, authToken: string }}
 */
async function createSubAccount(friendlyName) {
  const client = getMasterClient();
  const account = await client.api.accounts.create({ friendlyName });
  return { sid: account.sid, authToken: account.authToken };
}

/**
 * Buy a local US phone number for a sub-account.
 * @param {string} subAccountSid
 * @param {string} subAccountAuthToken
 * @returns {string} The purchased phone number (e.g. "+15551234567")
 */
async function buyPhoneNumber(subAccountSid, subAccountAuthToken) {
  const subClient = twilio(subAccountSid, subAccountAuthToken);

  // Search for available local US numbers
  const available = await subClient
    .availablePhoneNumbers("US")
    .local.list({ limit: 1 });

  if (!available.length) {
    throw new Error("No available phone numbers found");
  }

  // Purchase the number
  const purchased = await subClient.incomingPhoneNumbers.create({
    phoneNumber: available[0].phoneNumber,
  });

  return purchased.phoneNumber;
}

/**
 * Send an SMS via a user's Twilio sub-account.
 * @param {string} subAccountSid
 * @param {string} subAccountAuthToken
 * @param {string} from - The user's Twilio phone number
 * @param {string} to - Recipient phone number
 * @param {string} body - Message body
 * @returns {{ sid: string, status: string }}
 */
async function sendSms(subAccountSid, subAccountAuthToken, from, to, body) {
  const subClient = twilio(subAccountSid, subAccountAuthToken);
  const message = await subClient.messages.create({ from, to, body });
  return { sid: message.sid, status: message.status };
}

/**
 * Close/suspend a Twilio sub-account (releases numbers, stops billing).
 * @param {string} subAccountSid
 */
async function closeSubAccount(subAccountSid) {
  const client = getMasterClient();
  await client.api.accounts(subAccountSid).update({ status: "closed" });
}

module.exports = {
  createSubAccount,
  buyPhoneNumber,
  sendSms,
  closeSubAccount,
};
