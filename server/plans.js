/**
 * SWFT CRM — Plan definitions and usage limits.
 *
 * Keys (starter / pro / business) are stored in Firestore and must not change.
 * Display names and pricing may be updated freely here.
 */

const PLANS = {
  starter: {
    name: "Starter",
    monthlyPrice: 149,
    annualPrice: 119,            // ~20% off ($1,428/yr)
    seatLimit: 5,
    aiMessageLimit: 250,         // AI chat messages per month
  },
  pro: {
    name: "Growth",
    monthlyPrice: 349,
    annualPrice: 279,            // ~20% off ($3,348/yr)
    seatLimit: 15,
    aiMessageLimit: 1000,
  },
  business: {
    name: "Scale",
    monthlyPrice: 599,
    annualPrice: 479,            // ~20% off ($5,748/yr)
    seatLimit: Infinity,         // unlimited
    aiMessageLimit: Infinity,    // uncapped
  },
};

/* ── Overage packs (one-time top-ups) ── */
const OVERAGE_PACKS = {
  ai:  { name: "AI Message Pack", units: 100, price: 10 },
};

const DEFAULT_PLAN = "starter";

/**
 * Returns the plan config for a given plan key. Falls back to starter.
 */
function getPlan(planKey) {
  return PLANS[planKey] || PLANS[DEFAULT_PLAN];
}

module.exports = { PLANS, DEFAULT_PLAN, getPlan, OVERAGE_PACKS };
