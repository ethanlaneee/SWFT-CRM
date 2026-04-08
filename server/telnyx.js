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
 * Search available phone numbers without purchasing them.
 * Used by the number picker UI so users can choose their own number.
 *
 * @param {{ countryCode?, region?, areaCode?, city?, limit? }} options
 * @returns {Array<{ phoneNumber, locality, region, countryCode }>}
 */
async function searchAvailableNumbers(options = {}) {
  const telnyx = getClient();
  const countryCode = (options.countryCode || "US").toUpperCase();
  const limit = options.limit || 12;

  // Build the most specific filter first
  const buildFilter = (overrides = {}) => ({
    country_code: countryCode,
    features: ["sms"],
    limit,
    ...overrides,
  });

  const attempts = [];

  // Most specific: area code (city-level)
  if (options.areaCode) {
    attempts.push(buildFilter({ national_destination_code: options.areaCode }));
  }

  // Region only (province/state)
  if (options.region && (countryCode === "US" || countryCode === "CA" || countryCode === "GB")) {
    attempts.push(buildFilter({ administrative_area: options.region }));
  }

  // Country only (broadest fallback)
  attempts.push(buildFilter());

  for (const filter of attempts) {
    try {
      const result = await telnyx.availablePhoneNumbers.list({ filter });
      const numbers = result.data || [];
      if (numbers.length > 0) {
        return numbers.map(n => ({
          phoneNumber: n.phone_number,
          locality: n.region_information?.[0]?.locality || options.city || "",
          region: n.region_information?.[0]?.region_name || options.region || "",
          countryCode: n.country_code || countryCode,
        }));
      }
    } catch (err) {
      console.log(`[telnyx] searchAvailableNumbers attempt failed:`, err.message);
    }
  }

  return [];
}

/**
 * Order (purchase) a specific phone number and assign it to a messaging profile.
 *
 * @param {string} phoneNumber - E.164 phone number to order (e.g. "+14035551234")
 * @param {string} messagingProfileId
 * @returns {{ phoneNumber: string, phoneSid: string }}
 */
async function orderPhoneNumber(phoneNumber, messagingProfileId) {
  const telnyx = getClient();
  const order = await telnyx.numberOrders.create({
    phone_numbers: [{ phone_number: phoneNumber }],
    messaging_profile_id: messagingProfileId,
  });
  const phoneSid = order.data.phone_numbers?.[0]?.id || order.data.id;
  return { phoneNumber, phoneSid };
}

/**
 * Release a single phone number by its Telnyx record ID.
 *
 * @param {string} phoneSid - Telnyx phone number record ID
 */
async function releasePhoneNumber(phoneSid) {
  const telnyx = getClient();
  try {
    await telnyx.phoneNumbers.delete(phoneSid);
    console.log(`[telnyx] Released phone number (id: ${phoneSid})`);
  } catch (err) {
    console.log(`[telnyx] Failed to release phone number ${phoneSid}:`, err.message);
  }
}

/**
 * Search for and purchase the most local phone number available,
 * cascading from city-level → region → country.
 *
 * @param {string} messagingProfileId - User's Telnyx messaging profile ID
 * @param {string} webhookUrl - (Unused — webhook is on the profile, not the number)
 * @param {{ countryCode?, areaCode?, region?, city? }} [options]
 * @returns {{ phoneNumber: string, phoneSid: string }}
 */
async function buyPhoneNumber(messagingProfileId, webhookUrl, options = {}) {
  const telnyx = getClient();
  const countryCode = (options.countryCode || "US").toUpperCase();

  // Derive area code from city if not provided
  const areaCode = options.areaCode || (options.city ? cityToAreaCode(options.city) : null);
  const region = options.region || null;

  // Build a cascade of search attempts: most local first
  const attempts = [];

  if (areaCode) {
    attempts.push({ country_code: countryCode, features: ["sms"], limit: 5, national_destination_code: areaCode });
  }
  if (region && (countryCode === "US" || countryCode === "CA" || countryCode === "GB")) {
    attempts.push({ country_code: countryCode, features: ["sms"], limit: 5, administrative_area: region });
  }
  attempts.push({ country_code: countryCode, features: ["sms"], limit: 5 });

  let available = [];
  for (const filter of attempts) {
    try {
      const result = await telnyx.availablePhoneNumbers.list({ filter });
      available = result.data || [];
      if (available.length > 0) {
        console.log(`[telnyx] Found ${available.length} number(s) with filter:`, JSON.stringify(filter));
        break;
      }
    } catch (err) {
      console.log(`[telnyx] Number search attempt failed:`, err.message);
    }
  }

  if (!available.length) {
    throw new Error(
      `No available phone numbers found for country ${countryCode}. Please try again or contact support.`
    );
  }

  return orderPhoneNumber(available[0].phone_number, messagingProfileId);
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

  if (phoneSid) {
    await releasePhoneNumber(phoneSid);
  }

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
 * @param {{ telnyxPhoneNumber?, telnyxMessagingProfileId? }} [userTelnyx]
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

// ── Geo helpers ─────────────────────────────────────────────────────────────

/**
 * Map a Cloudflare cf-ipregion value (may be full name like "Alberta" or
 * abbreviation like "AB") to a 2-letter code suitable for Telnyx's
 * administrative_area filter.
 */
function normalizeRegion(region, countryCode) {
  if (!region) return null;
  const s = region.trim();
  // Already a 2-letter code?
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();

  const lower = s.toLowerCase();

  if (countryCode === "CA") {
    const CA = {
      "alberta": "AB", "british columbia": "BC", "manitoba": "MB",
      "new brunswick": "NB", "newfoundland": "NL", "newfoundland and labrador": "NL",
      "northwest territories": "NT", "nova scotia": "NS", "nunavut": "NU",
      "ontario": "ON", "prince edward island": "PE", "quebec": "QC",
      "saskatchewan": "SK", "yukon": "YT", "yukon territory": "YT",
    };
    return CA[lower] || null;
  }

  if (countryCode === "US") {
    const US = {
      "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA",
      "colorado":"CO","connecticut":"CT","delaware":"DE","florida":"FL","georgia":"GA",
      "hawaii":"HI","idaho":"ID","illinois":"IL","indiana":"IN","iowa":"IA",
      "kansas":"KS","kentucky":"KY","louisiana":"LA","maine":"ME","maryland":"MD",
      "massachusetts":"MA","michigan":"MI","minnesota":"MN","mississippi":"MS",
      "missouri":"MO","montana":"MT","nebraska":"NE","nevada":"NV","new hampshire":"NH",
      "new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC",
      "north dakota":"ND","ohio":"OH","oklahoma":"OK","oregon":"OR","pennsylvania":"PA",
      "rhode island":"RI","south carolina":"SC","south dakota":"SD","tennessee":"TN",
      "texas":"TX","utah":"UT","vermont":"VT","virginia":"VA","washington":"WA",
      "west virginia":"WV","wisconsin":"WI","wyoming":"WY",
    };
    return US[lower] || null;
  }

  return null;
}

/**
 * Map a city name to its primary area code (NPA/NXX) for local number search.
 * Covers major Canadian and US cities. Returns null if unknown.
 */
function cityToAreaCode(city) {
  if (!city) return null;
  const lower = city.toLowerCase().trim();

  const MAP = {
    // Alberta
    "calgary": "403", "red deer": "403", "lethbridge": "403", "medicine hat": "403",
    "airdrie": "403", "okotoks": "403", "brooks": "403", "strathmore": "403",
    "edmonton": "780", "fort mcmurray": "780", "grande prairie": "780",
    "lloydminster": "780", "spruce grove": "780", "leduc": "780", "st. albert": "780",
    // British Columbia
    "vancouver": "604", "surrey": "604", "burnaby": "604", "richmond": "604",
    "abbotsford": "604", "delta": "604", "langley": "604", "coquitlam": "604",
    "victoria": "250", "kelowna": "250", "kamloops": "250", "nanaimo": "250",
    "prince george": "250", "chilliwack": "604",
    // Ontario
    "toronto": "416", "scarborough": "416", "etobicoke": "416",
    "mississauga": "905", "brampton": "905", "hamilton": "905", "oakville": "905",
    "burlington": "905", "vaughan": "905", "markham": "905", "richmond hill": "905",
    "barrie": "705", "sudbury": "705", "thunder bay": "807",
    "ottawa": "613", "kanata": "613", "nepean": "613",
    "london": "519", "waterloo": "519", "kitchener": "519", "cambridge": "519",
    "windsor": "519", "guelph": "519",
    // Quebec
    "montreal": "514", "laval": "450", "longueuil": "450", "gatineau": "819",
    "sherbrooke": "819", "trois-rivieres": "819", "quebec city": "418",
    "quebec": "418",
    // Saskatchewan
    "saskatoon": "306", "regina": "306", "prince albert": "306",
    // Manitoba
    "winnipeg": "204", "brandon": "204",
    // Nova Scotia
    "halifax": "902", "dartmouth": "902", "sydney": "902",
    // New Brunswick
    "moncton": "506", "saint john": "506", "fredericton": "506",
    // US — major metros
    "new york": "212", "brooklyn": "718", "bronx": "718", "queens": "718",
    "los angeles": "213", "hollywood": "323", "beverly hills": "310", "santa monica": "310",
    "chicago": "312", "houston": "713", "phoenix": "602", "philadelphia": "215",
    "san antonio": "210", "san diego": "619", "dallas": "214", "san jose": "408",
    "austin": "512", "jacksonville": "904", "fort worth": "817", "columbus": "614",
    "charlotte": "704", "indianapolis": "317", "san francisco": "415",
    "seattle": "206", "denver": "303", "washington": "202", "nashville": "615",
    "oklahoma city": "405", "el paso": "915", "boston": "617", "portland": "503",
    "las vegas": "702", "memphis": "901", "louisville": "502", "baltimore": "410",
    "milwaukee": "414", "albuquerque": "505", "tucson": "520", "fresno": "559",
    "mesa": "480", "sacramento": "916", "atlanta": "404", "kansas city": "816",
    "omaha": "402", "colorado springs": "719", "raleigh": "919", "miami": "305",
    "long beach": "562", "virginia beach": "757", "minneapolis": "612",
  };

  return MAP[lower] || null;
}

module.exports = {
  sendSms,
  createMessagingProfile,
  searchAvailableNumbers,
  orderPhoneNumber,
  releasePhoneNumber,
  buyPhoneNumber,
  closeMessagingProfile,
  getUserTelnyxConfig,
  normalizeRegion,
  cityToAreaCode,
};
