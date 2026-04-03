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
 * List all active sub-accounts.
 */
async function listSubAccounts() {
  const client = getMasterClient();
  return client.api.accounts.list({ status: "active" });
}

/**
 * Close all sub-accounts except the main one (cleanup helper).
 */
async function closeAllSubAccounts() {
  const client = getMasterClient();
  const accounts = await client.api.accounts.list({ status: "active" });
  let closed = 0;
  for (const acct of accounts) {
    if (acct.sid !== ACCOUNT_SID) {
      try {
        await client.api.accounts(acct.sid).update({ status: "closed" });
        closed++;
      } catch (e) { /* skip if can't close */ }
    }
  }
  return closed;
}

/**
 * Create a Twilio sub-account for a SWFT user.
 * If at the sub-account limit, closes unused ones first.
 * @param {string} friendlyName - e.g. "SWFT-<uid>" or company name
 * @param {string[]} [activeSids] - sub-account SIDs currently in use (don't close these)
 * @returns {{ sid: string, authToken: string }}
 */
async function createSubAccount(friendlyName, activeSids) {
  const client = getMasterClient();
  try {
    const account = await client.api.accounts.create({ friendlyName });
    return { sid: account.sid, authToken: account.authToken };
  } catch (err) {
    // If we hit the sub-account limit, close unused ones and retry
    if (err.message && err.message.toLowerCase().includes("max")) {
      const accounts = await client.api.accounts.list({ status: "active" });
      const safeSet = new Set(activeSids || []);
      safeSet.add(ACCOUNT_SID); // never close the main account
      let closed = 0;
      for (const acct of accounts) {
        if (!safeSet.has(acct.sid)) {
          try {
            await client.api.accounts(acct.sid).update({ status: "closed" });
            closed++;
          } catch (e) { /* skip */ }
        }
      }
      if (closed === 0) throw new Error("Cannot create sub-account: limit reached and no unused accounts to close");
      // Retry
      const account = await client.api.accounts.create({ friendlyName });
      return { sid: account.sid, authToken: account.authToken };
    }
    throw err;
  }
}

/**
 * Buy a local US phone number for a sub-account.
 * Tries to match the user's area code for a local number.
 * @param {string} subAccountSid
 * @param {string} subAccountAuthToken
 * @param {string} [userPhone] - User's own phone number to extract area code
 * @returns {string} The purchased phone number (e.g. "+15551234567")
 */
async function buyPhoneNumber(subAccountSid, subAccountAuthToken, userPhone) {
  const subClient = twilio(subAccountSid, subAccountAuthToken);

  // Extract area code from user's phone number (e.g. "+14035551234" → "403")
  let areaCode = null;
  if (userPhone) {
    const digits = userPhone.replace(/\D/g, "");
    // North American numbers: strip leading 1 if 11 digits, then take first 3
    const national = digits.length === 11 && digits[0] === "1" ? digits.slice(1) : digits;
    if (national.length === 10) areaCode = national.slice(0, 3);
  }

  // Canadian area codes (Calgary target market + common CA codes)
  const canadianAreaCodes = ["403", "587", "780", "604", "778", "250", "236", "416", "647", "437", "905", "289", "365", "613", "343", "819", "873", "514", "438", "450", "579", "306", "639", "204", "431", "506", "709", "902", "782", "867"];
  const isCanadian = areaCode && canadianAreaCodes.includes(areaCode);
  const country = isCanadian ? "CA" : "US";

  let available = [];

  // First try: match user's area code in their country
  if (areaCode) {
    available = await subClient
      .availablePhoneNumbers(country)
      .local.list({ areaCode, limit: 1 });
  }

  // Fallback: any available number in the same country
  if (!available.length) {
    available = await subClient
      .availablePhoneNumbers(country)
      .local.list({ limit: 1 });
  }

  // Last resort: try the other country
  if (!available.length) {
    const fallbackCountry = country === "CA" ? "US" : "CA";
    available = await subClient
      .availablePhoneNumbers(fallbackCountry)
      .local.list({ limit: 1 });
  }

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
  listSubAccounts,
  closeAllSubAccounts,
};
