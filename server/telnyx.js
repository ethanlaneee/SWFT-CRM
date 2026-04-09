const Telnyx = require("telnyx");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_PHONE = process.env.TELNYX_PHONE_NUMBER || "";
// Shared messaging profile created once in the Telnyx portal.
// All SWFT users share this profile — avoids per-user profile creation.
const SHARED_MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID || "";

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
    whitelisted_destinations: ["CA", "US"],
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

  // Build the most specific filter first.
  // best_effort: true tells Telnyx to return actual specific numbers rather
  // than wildcard/pattern numbers (e.g. "+18252------") for CA/US searches.
  const buildFilter = (overrides = {}) => ({
    country_code: countryCode,
    features: ["sms"],
    limit,
    best_effort: true,
    ...overrides,
  });

  // Try without best_effort first (returns real orderable numbers).
  // best_effort can return wildcard patterns (e.g. +18252------) for CA numbers
  // which look like numbers but cannot be ordered directly.
  const attempts = [];

  if (options.areaCode) {
    attempts.push(buildFilter({ best_effort: false, national_destination_code: options.areaCode }));
    attempts.push(buildFilter({ national_destination_code: options.areaCode }));
  }
  if (options.region && (countryCode === "US" || countryCode === "CA" || countryCode === "GB")) {
    attempts.push(buildFilter({ best_effort: false, administrative_area: options.region }));
    attempts.push(buildFilter({ administrative_area: options.region }));
  }
  attempts.push(buildFilter({ best_effort: false }));
  attempts.push(buildFilter());

  for (const filter of attempts) {
    try {
      const result = await telnyx.availablePhoneNumbers.list({ filter });
      // Filter out wildcard/pattern results — they cannot be ordered
      const numbers = (result.data || []).filter(n => n.phone_number && !n.phone_number.includes("-"));
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

  // Build a cascade of search attempts: most local first.
  // For each geo filter, try: no features → sms features → best_effort.
  // Canadian numbers often aren't tagged with SMS in the search API but still support it.
  const attempts = [];

  if (areaCode) {
    attempts.push({ country_code: countryCode, limit: 5, national_destination_code: areaCode });
    attempts.push({ country_code: countryCode, features: ["sms"], limit: 5, national_destination_code: areaCode });
    attempts.push({ country_code: countryCode, features: ["sms"], limit: 5, best_effort: true, national_destination_code: areaCode });
  }
  if (region && (countryCode === "US" || countryCode === "CA" || countryCode === "GB")) {
    attempts.push({ country_code: countryCode, limit: 5, administrative_area: region });
    attempts.push({ country_code: countryCode, features: ["sms"], limit: 5, administrative_area: region });
    attempts.push({ country_code: countryCode, features: ["sms"], limit: 5, best_effort: true, administrative_area: region });
  }
  attempts.push({ country_code: countryCode, limit: 5 });
  attempts.push({ country_code: countryCode, features: ["sms"], limit: 5 });
  attempts.push({ country_code: countryCode, features: ["sms"], limit: 5, best_effort: true });

  let chosen = null;
  for (const filter of attempts) {
    try {
      const result = await telnyx.availablePhoneNumbers.list({ filter });
      // Prefer real (non-wildcard) numbers
      const real = (result.data || []).filter(n => n.phone_number && !n.phone_number.includes("-"));
      if (real.length > 0) {
        chosen = real[0].phone_number;
        console.log(`[telnyx] Found orderable number ${chosen} with filter:`, JSON.stringify(filter));
        break;
      }
    } catch (err) {
      console.log(`[telnyx] Number search attempt failed:`, err.message);
    }
  }

  // Fallback for countries like Canada where Telnyx only returns wildcard patterns:
  // Accept a wildcard result, extract its NPA prefix, and try to order via that prefix.
  if (!chosen) {
    console.log(`[telnyx] No real numbers found, trying wildcard fallback for ${countryCode}`);
    for (const filter of attempts) {
      try {
        const result = await telnyx.availablePhoneNumbers.list({ filter });
        const any = (result.data || []).filter(n => n.phone_number);
        if (any.length > 0) {
          // Extract the concrete digits from the wildcard (e.g. "+14035------" → "4035")
          const raw = any[0].phone_number;
          const prefix = raw.replace(/[^0-9+]/g, "").replace(/^(\+?1)/, "+1");
          console.log(`[telnyx] Wildcard found: ${raw}, trying to order with prefix search`);

          // Search one more time using starts_with on the concrete prefix digits
          const digits = raw.replace(/[^0-9]/g, "");
          const npa = digits.length >= 4 ? digits.slice(1, 4) : null;
          if (npa) {
            const prefixResult = await telnyx.availablePhoneNumbers.list({
              filter: { country_code: countryCode, national_destination_code: npa, limit: 1 }
            });
            const prefixNums = (prefixResult.data || []).filter(n => n.phone_number && !n.phone_number.includes("-"));
            if (prefixNums.length > 0) {
              chosen = prefixNums[0].phone_number;
              console.log(`[telnyx] Prefix search found orderable number: ${chosen}`);
              break;
            }
          }

          // Last resort: try ordering the wildcard directly — Telnyx may resolve it
          try {
            console.log(`[telnyx] Attempting direct order of wildcard pattern: ${raw}`);
            return await orderPhoneNumber(raw, messagingProfileId);
          } catch (orderErr) {
            console.log(`[telnyx] Direct wildcard order failed: ${orderErr.message}`);
            // Continue to next attempt
          }
        }
      } catch (err) {
        console.log(`[telnyx] Wildcard fallback search failed:`, err.message);
      }
    }
  }

  if (!chosen) {
    throw new Error(
      `No available phone numbers found for ${countryCode}${areaCode ? " (" + areaCode + ")" : ""}. This may be a temporary issue — please try again in a few minutes or try a different area.`
    );
  }

  return orderPhoneNumber(chosen, messagingProfileId);
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
  SHARED_MESSAGING_PROFILE_ID,
};
