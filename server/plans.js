/**
 * SWFT CRM — Plan definitions and usage limits.
 *
 * Each plan defines monthly caps for metered features (SMS, AI messages).
 * "Business" plan gets unlimited usage (Infinity).
 */

const PLANS = {
  starter: {
    name: "Starter",
    price: 49, // $/month
    smsLimit: 200,       // outbound SMS per month
    aiMessageLimit: 100, // AI chat messages per month
  },
  pro: {
    name: "Pro",
    price: 99,
    smsLimit: 1000,
    aiMessageLimit: 500,
  },
  business: {
    name: "Business",
    price: 149,
    smsLimit: Infinity,       // uncapped
    aiMessageLimit: Infinity, // uncapped
  },
};

const DEFAULT_PLAN = "starter";

/**
 * Returns the plan config for a given plan key. Falls back to starter.
 */
function getPlan(planKey) {
  return PLANS[planKey] || PLANS[DEFAULT_PLAN];
}

module.exports = { PLANS, DEFAULT_PLAN, getPlan };
