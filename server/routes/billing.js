const router = require("express").Router();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { db } = require("../firebase");

const ADMIN_EMAIL = "ethan@goswft.com";
const users = () => db.collection("users");

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/billing/create-checkout-session
//
// Creates a Stripe Checkout Session and returns the hosted URL.
// The frontend redirects the browser there directly.
//
// Body: { priceId: "price_xxx" }  ← your Stripe Price ID
// ─────────────────────────────────────────────────────────────────────────────
router.post("/create-checkout-session", async (req, res, next) => {
  try {
    const { priceId } = req.body;
    if (!priceId) {
      return res.status(400).json({ error: "priceId is required." });
    }

    // Fetch Firestore profile to reuse existing Stripe customer ID
    const doc  = await users().doc(req.uid).get();
    const data = doc.exists ? doc.data() : {};

    let customerId = data.stripeCustomerId || null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: data.email || req.user.email,
        metadata: { firebaseUid: req.uid },
      });
      customerId = customer.id;
      await users().doc(req.uid).set({ stripeCustomerId: customerId }, { merge: true });
    }

    const session = await stripe.checkout.sessions.create({
      customer:             customerId,
      payment_method_types: ["card"],
      line_items:           [{ price: priceId, quantity: 1 }],
      mode:                 "subscription",
      // session_id token in the success URL lets the dashboard verify payment immediately
      success_url: `${process.env.APP_URL}/swft-shell.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.APP_URL}/swft-billing.html?canceled=true`,
      metadata:    { firebaseUid: req.uid },
      subscription_data: { metadata: { firebaseUid: req.uid } },
    });

    res.json({ url: session.url });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/billing/verify-session?session_id=cs_xxx
//
// Called by the dashboard on load when ?session_id= is present in the URL.
// Retrieves the Checkout Session from Stripe, confirms payment_status is
// "paid", and immediately flips the user's accountStatus → "active" and
// isSubscribed → true so they can access the app right away.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/verify-session", async (req, res, next) => {
  try {
    const { session_id } = req.query;
    if (!session_id) {
      return res.status(400).json({ error: "session_id is required." });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);

    // Guard: session must belong to this user's Stripe customer
    const userDoc  = await users().doc(req.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    if (session.customer !== userData.stripeCustomerId) {
      return res.status(403).json({ error: "Session does not belong to this account." });
    }

    if (session.payment_status !== "paid") {
      return res.status(402).json({ error: "Payment not completed.", paymentStatus: session.payment_status });
    }

    // Flip account to active immediately (webhook is the durable update,
    // but this makes the UI responsive without waiting for the webhook)
    await users().doc(req.uid).set({
      accountStatus:        "active",
      isSubscribed:         true,
      stripeSubscriptionId: session.subscription,
    }, { merge: true });

    res.json({ success: true, accountStatus: "active" });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// webhookHandler  (exported separately — registered in index.js BEFORE
//                  express.json() so the raw body is preserved for Stripe
//                  signature verification)
//
// Handles:
//   checkout.session.completed   → activate subscription
//   customer.subscription.deleted → mark account canceled
// ─────────────────────────────────────────────────────────────────────────────
async function webhookHandler(req, res) {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const uid     = session.metadata?.firebaseUid;
      if (uid) {
        await users().doc(uid).set({
          accountStatus:        "active",
          isSubscribed:         true,
          stripeCustomerId:     session.customer,
          stripeSubscriptionId: session.subscription,
        }, { merge: true });
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      // Look up user by Stripe customer ID
      const snap = await users().where("stripeCustomerId", "==", subscription.customer).limit(1).get();
      if (!snap.empty) {
        await snap.docs[0].ref.set({
          accountStatus: "canceled",
          isSubscribed:  false,
        }, { merge: true });
      }
    }

    // Skip emails for the admin account
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      const snap    = await users().where("stripeCustomerId", "==", invoice.customer).limit(1).get();
      if (!snap.empty && snap.docs[0].data().email !== ADMIN_EMAIL) {
        // TODO: send payment-failed email notification here
        console.warn("Payment failed for customer:", invoice.customer);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.status(500).json({ error: "Webhook processing failed." });
  }
}

module.exports = { router, webhookHandler };
