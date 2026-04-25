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

/**
 * Lazily create (or reuse) a Stripe Customer on the owner's connected account
 * for a given SWFT customer. Used by recurring invoicing where Stripe needs
 * a Customer object to bill. The ID is cached on the customer doc under
 * stripeCustomers[connectedAccountId] so we don't create duplicates if the
 * owner reconnects a different Stripe account later.
 */
async function ensureStripeCustomer({ db, customerId, orgId, connectedAccountId }) {
  const custRef = db.collection("customers").doc(customerId);
  const custSnap = await custRef.get();
  if (!custSnap.exists || custSnap.data().orgId !== orgId) {
    throw new Error("Customer not found");
  }
  const cust = custSnap.data();

  const cached = cust.stripeCustomers?.[connectedAccountId];
  if (cached) return cached;

  const stripe = getStripe();
  const created = await stripe.customers.create({
    name: cust.name || undefined,
    email: cust.email || undefined,
    phone: cust.phone || undefined,
    metadata: { swftCustomerId: customerId, swftOrgId: orgId },
  }, { stripeAccount: connectedAccountId });

  await custRef.update({
    [`stripeCustomers.${connectedAccountId}`]: created.id,
    updatedAt: Date.now(),
  });

  return created.id;
}

module.exports = { getStripe, ensureStripeCustomer };
