/**
 * Public pay-redirect route.
 *
 *   GET /api/pay/quote/:id
 *   GET /api/pay/invoice/:id
 *
 * The pay button embedded in quote/invoice emails links here. On click we
 * create a fresh Stripe Checkout Session attached to the pre-existing
 * Stripe Customer on the owner's connected account, then 302 to the Stripe
 * checkout URL. This solves the limitation that stripe.paymentLinks.create()
 * has no `customer:` field — Checkout Sessions do, so payments roll up under
 * the right Stripe Customer record in the owner's dashboard.
 *
 * No auth: this URL is in customer-facing emails. Validation is by document
 * existence + matching connected account. The redirect is the only thing
 * the customer sees; sensitive data never leaves the server.
 */
const router = require("express").Router();
const { db } = require("../firebase");
const { getStripe, ensureStripeCustomer } = require("../utils/stripe");

const APP_URL = process.env.APP_URL || "https://goswft.com";

function htmlError(res, status, message) {
  res.status(status).send(
    `<!doctype html><meta charset="utf-8"><title>Payment Unavailable</title>` +
    `<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0a0a0a;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center;}h1{font-size:22px;margin:0 0 8px;}p{color:#888;font-size:14px;max-width:420px;line-height:1.5;}a{color:#c8f135;text-decoration:none;}</style>` +
    `<div><h1>Payment Unavailable</h1><p>${message}</p><p>Please contact the business that sent you this link, or <a href="${APP_URL}">visit goswft.com</a>.</p></div>`
  );
}

async function buildSession(kind, id) {
  const docRef = db.collection(kind === "quote" ? "quotes" : "invoices").doc(id);
  const docSnap = await docRef.get();
  if (!docSnap.exists) return { error: "not_found", message: `This ${kind} no longer exists.` };
  const doc = docSnap.data();

  if (doc.status === "paid") {
    return { error: "already_paid", message: `This ${kind} has already been paid in full. Thank you.` };
  }

  if (!doc.orgId) return { error: "missing_org", message: "This payment link is missing org information." };
  const ownerDoc = await db.collection("users").doc(doc.orgId).get();
  const ownerStripe = ownerDoc.exists ? ownerDoc.data()?.integrations?.stripe : null;
  const connectedAccountId = ownerStripe?.accountId;
  if (!connectedAccountId) {
    return { error: "not_connected", message: "Online payments aren't set up for this business yet." };
  }

  const amountCents = Math.round((doc.total || 0) * 100);
  if (amountCents < 50) return { error: "amount_too_small", message: "Amount must be at least $0.50." };

  // Make sure the Stripe Customer exists on the connected account so the
  // Checkout Session can attach to it. Cached in customers/{id}.stripeCustomers.
  let stripeCustomerId = null;
  if (doc.customerId) {
    try {
      stripeCustomerId = await ensureStripeCustomer({
        db, customerId: doc.customerId, orgId: doc.orgId, connectedAccountId,
      });
    } catch (e) {
      console.warn(`[pay-redirect] ensureStripeCustomer failed for ${doc.customerId}:`, e.message);
    }
  }

  const stripe = getStripe();
  const stripeOpts = { stripeAccount: connectedAccountId };

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{
      price_data: {
        currency: "usd",
        unit_amount: amountCents,
        product_data: {
          name: `${kind === "quote" ? "Quote" : "Invoice"} — ${doc.customerName || "Customer"}${doc.service ? ` (${doc.service})` : ""}`,
        },
      },
      quantity: 1,
    }],
    customer: stripeCustomerId || undefined,
    customer_creation: stripeCustomerId ? undefined : "always",
    metadata: {
      [kind === "quote" ? "quoteId" : "invoiceId"]: id,
      orgId: doc.orgId,
      customerId: doc.customerId || "",
    },
    success_url: `${APP_URL}/api/pay/${kind}/${id}/success`,
    cancel_url: `${APP_URL}/api/pay/${kind}/${id}/cancelled`,
  }, stripeOpts);

  // Cache the connect account ID on the doc so the webhook can verify it.
  await docRef.update({
    stripeConnectAccountId: connectedAccountId,
    updatedAt: Date.now(),
  });

  return { url: session.url };
}

function payHandler(kind) {
  return async (req, res) => {
    try {
      const result = await buildSession(kind, req.params.id);
      if (result.error) return htmlError(res, result.error === "not_found" ? 404 : 400, result.message);
      return res.redirect(302, result.url);
    } catch (err) {
      console.error(`[pay-redirect/${kind}]`, err);
      return htmlError(res, 500, "Couldn't start checkout. Please try again in a moment.");
    }
  };
}

router.get("/quote/:id", payHandler("quote"));
router.get("/invoice/:id", payHandler("invoice"));

// Friendly success / cancelled landing pages — no app login required.
router.get("/quote/:id/success",   (_req, res) => htmlError(res, 200, "Payment received. Thank you!"));
router.get("/invoice/:id/success", (_req, res) => htmlError(res, 200, "Payment received. Thank you!"));
router.get("/quote/:id/cancelled",   (_req, res) => htmlError(res, 200, "Payment cancelled. You can come back any time."));
router.get("/invoice/:id/cancelled", (_req, res) => htmlError(res, 200, "Payment cancelled. You can come back any time."));

module.exports = router;
