const Telnyx = require("telnyx");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_PHONE = process.env.TELNYX_PHONE_NUMBER || "";

function getClient() {
  if (!TELNYX_API_KEY) throw new Error("Telnyx API key not configured (TELNYX_API_KEY)");
  return new Telnyx(TELNYX_API_KEY);
}

/**
 * Create a Telnyx Messaging Profile for a new SWFT user.
 * Groups phone numbers under a shared webhook URL for multi-tenant SMS.
 *
 * @param {string} friendlyName - e.g. "SWFT - John's Plumbing"
 * @param {string} webhookUrl - URL for inbound SMS webhooks
 * @returns {{ messagingProfileId: string }}
 */
async function createMessagingProfile(friendlyName, webhookUrl) {
  const telnyx = getClient();
  const profile = await telnyx.messagingProfiles.create({
    name: friendlyName,
    webhook_url: webhookUrl,
    webhook_failover_url: "",
    enabled: true,
  });
  return {
    messagingProfileId: profile.data.id,
  };
}

/**
 * Search for and purchase a local phone number, assigning it to the user's
 * Messaging Profile so inbound SMS routes to the correct webhook.
 *
 * @param {string} messagingProfileId - User's Telnyx messaging profile ID
 * @param {string} webhookUrl - (Unused — webhook is on the profile, not the number)
 * @param {{ countryCode?: string, areaCode?: string, region?: string }} [options]
 *   countryCode: ISO 3166-1 alpha-2 (e.g. "US", "CA", "GB"). Defaults to "US".
 *   areaCode: Area/NXX code to target a local number (US/CA).
 *   region: US/CA state abbreviation (e.g. "TX") for regional matching.
 * @returns {{ phoneNumber: string, phoneSid: string }}
 */
async function buyPhoneNumber(messagingProfileId, webhookUrl, options = {}) {
  const telnyx = getClient();
  const countryCode = (options.countryCode || "US").toUpperCase();

  // Build search filter (nested object — v6 SDK deepObject style)
  const filter = {
    country_code: countryCode,
    features: ["sms"],
    limit: 5,
  };
  if (options.areaCode) filter.national_destination_code = options.areaCode;
  if (options.region && (countryCode === "US" || countryCode === "CA")) {
    filter.administrative_area = options.region;
  }

  let available = [];
  try {
    const result = await telnyx.availablePhoneNumbers.list({ filter });
    available = result.data || [];
  } catch (err) {
    console.log(`[telnyx] Number search failed for ${countryCode}:`, err.message);
  }

  // Retry without area code / region if too restrictive
  if (!available.length && (options.areaCode || options.region)) {
    console.log(`[telnyx] Retrying without area code / region for ${countryCode}`);
    try {
      const result = await telnyx.availablePhoneNumbers.list({
        filter: { country_code: countryCode, features: ["sms"], limit: 5 },
      });
      available = result.data || [];
    } catch (err) {
      console.log(`[telnyx] Fallback search also failed:`, err.message);
    }
  }

  if (!available.length) {
    throw new Error(
      `No available phone numbers found for country ${countryCode}. Please try again or contact support.`
    );
  }

  // Order the phone number and assign it to the user's messaging profile
  const order = await telnyx.numberOrders.create({
    phone_numbers: [{ phone_number: available[0].phone_number }],
    messaging_profile_id: messagingProfileId,
  });

  const phoneNumber =
    order.data.phone_numbers?.[0]?.phone_number || available[0].phone_number;
  // phoneSid is the Telnyx phone number record ID (used for release/update)
  const phoneSid = order.data.phone_numbers?.[0]?.id || order.data.id;

  return { phoneNumber, phoneSid };
}

/**
 * Release a user's phone number and delete their Messaging Profile.
 * Called when a SWFT user deletes their account.
 *
 * @param {string} messagingProfileId
 * @param {string} [phoneSid] - Telnyx phone number record ID
 */
async function closeMessagingProfile(messagingProfileId, phoneSid) {
  const telnyx = getClient();

  // Release the phone number first
  if (phoneSid) {
    try {
      await telnyx.phoneNumbers.delete(phoneSid);
      console.log(`[telnyx] Released phone number (id: ${phoneSid})`);
    } catch (err) {
      console.log(`[telnyx] Failed to release phone number ${phoneSid}:`, err.message);
    }
  }

  // Delete the messaging profile
  if (messagingProfileId) {
    try {
      await telnyx.messagingProfiles.delete(messagingProfileId);
      console.log(`[telnyx] Deleted messaging profile ${messagingProfileId}`);
    } catch (err) {
      console.log(`[telnyx] Failed to delete messaging profile ${messagingProfileId}:`, err.message);
    }
  }
}

/**
 * Send an SMS. Uses the user's assigned Telnyx number when available,
 * otherwise falls back to the shared TELNYX_PHONE_NUMBER env var.
 *
 * @param {string} to - Recipient phone number (E.164)
 * @param {string} body - Message text
 * @param {{ telnyxPhoneNumber?: string, telnyxMessagingProfileId?: string }} [userTelnyx]
 *   Per-user Telnyx config from Firestore
 */
async function sendSms(to, body, userTelnyx) {
  const telnyx = getClient();
  const from = userTelnyx?.telnyxPhoneNumber || TELNYX_PHONE;

  if (!from) {
    throw new Error(
      "No Telnyx phone number configured. Set TELNYX_PHONE_NUMBER or provision a user number."
    );
  }

  const params = { from, to, text: body };
  if (userTelnyx?.telnyxMessagingProfileId) {
    params.messaging_profile_id = userTelnyx.telnyxMessagingProfileId;
  }

  const message = await telnyx.messages.send(params);
  return {
    sid: message.data.id,
    status: message.data.to?.[0]?.status || "sent",
  };
}

/**
 * Extract Telnyx config from a user data object (Firestore).
 * Returns the config to pass to sendSms, or null if not provisioned.
 */
function getUserTelnyxConfig(userData) {
  if (userData?.telnyxPhoneNumber) {
    return {
      telnyxPhoneNumber: userData.telnyxPhoneNumber,
      telnyxMessagingProfileId: userData.telnyxMessagingProfileId || null,
    };
  }
  return null;
}

module.exports = {
  sendSms,
  createMessagingProfile,
  buyPhoneNumber,
  closeMessagingProfile,
  getUserTelnyxConfig,
};
