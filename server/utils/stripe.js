/**
 * Shared Stripe client initialization.
 * Lazy-loaded so missing STRIPE_SECRET_KEY doesn't crash at startup.
 */
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY environment variable is not set.");
  }
  return require("stripe")(process.env.STRIPE_SECRET_KEY);
}

module.exports = { getStripe };
