/**
 * SWFT CRM — Plan definitions and usage limits.
 *
 * Each plan defines monthly caps for metered features (AI messages).
 * "Business" plan gets unlimited usage (Infinity).
 * Annual billing = 20% discount.
 */

const PLANS = {
  starter: {
    name: "Starter",
    monthlyPrice: 89,
    annualPrice: 71,           // ~20% off ($852/yr)
    aiMessageLimit: 75,        // AI chat messages per month
  },
  pro: {
    name: "Pro",
    monthlyPrice: 179,
    annualPrice: 143,          // ~20% off ($1,716/yr)
    aiMessageLimit: 1000,
  },
  business: {
    name: "Business",
    monthlyPrice: 349,
    annualPrice: 279,          // ~20% off ($3,348/yr)
    aiMessageLimit: Infinity,  // uncapped
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
