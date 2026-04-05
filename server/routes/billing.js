const router = require("express").Router();
const { db } = require("../firebase");
const { google } = require("googleapis");

// Initialize lazily so a missing STRIPE_SECRET_KEY env var doesn't crash
// the server at startup — the error surfaces only when a billing route is hit.
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY environment variable is not set.");
  }
  return require("stripe")(process.env.STRIPE_SECRET_KEY);
}

const ADMIN_EMAIL = "ethan@goswft.com";
const users = () => db.collection("users");

// Stripe Price IDs for each plan
const PRICE_IDS = {
  starter:  "price_1TIc1URNPpAjdxw0uscz7ouv",
  pro:      "price_1TIc1VRNPpAjdxw0fwN1bfEH",
  business: "price_1TIc1VRNPpAjdxw05e9i863i",
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/billing/create-checkout-session
//
// Creates a Stripe Checkout Session and returns the hosted URL.
// The frontend redirects the browser there directly.
//
// Body: { plan: "starter"|"pro"|"business" }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/create-checkout-session", async (req, res, next) => {
  try {
    const { plan } = req.body;
    const planKey = plan && PRICE_IDS[plan] ? plan : "starter";
    const priceId = PRICE_IDS[planKey];

    // Fetch Firestore profile to reuse existing Stripe customer ID
    const doc  = await users().doc(req.uid).get();
    const data = doc.exists ? doc.data() : {};

    let customerId = data.stripeCustomerId || null;

    const stripe = getStripe();

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: data.email || req.user.email,
        metadata: { firebaseUid: req.uid },
      });
      customerId = customer.id;
      await users().doc(req.uid).set({ stripeCustomerId: customerId }, { merge: true });
    }

    const session = await stripe.checkout.sessions.create({
      ui_mode:              "embedded",
      customer:             customerId,
      line_items:           [{ price: priceId, quantity: 1 }],
      mode:                 "subscription",
      allow_promotion_codes: true,
      subscription_data: {
        trial_period_days: 14,
        metadata: { firebaseUid: req.uid, plan: planKey },
      },
      return_url: `${process.env.APP_URL}/swft-checkout?session_id={CHECKOUT_SESSION_ID}&plan=${planKey}`,
      metadata:   { firebaseUid: req.uid, plan: planKey },
    });

    res.json({ clientSecret: session.client_secret });
  } catch (err) { next(err); }
});

// GET /api/billing/plans — return plan info and Stripe price IDs (public-ish)
router.get("/plans", (req, res) => {
  res.json({
    starter:  { name: "Starter",  price: 49,  priceId: PRICE_IDS.starter },
    pro:      { name: "Pro",      price: 99,  priceId: PRICE_IDS.pro },
    business: { name: "Business", price: 149, priceId: PRICE_IDS.business },
  });
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

    const stripe  = getStripe();
    const session = await stripe.checkout.sessions.retrieve(session_id);

    // Guard: session must belong to this user's Stripe customer
    const userDoc  = await users().doc(req.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    if (session.customer !== userData.stripeCustomerId) {
      return res.status(403).json({ error: "Session does not belong to this account." });
    }

    if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
      return res.status(402).json({ error: "Payment not completed.", paymentStatus: session.payment_status });
    }

    // Flip account to active immediately (webhook is the durable update,
    // but this makes the UI responsive without waiting for the webhook)
    await users().doc(req.uid).set({
      accountStatus:        "active",
      isSubscribed:         true,
      plan:                 session.metadata?.plan || "starter",
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
    const stripe = getStripe();
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
          plan:                 session.metadata?.plan || "starter",
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

    // Payment failed — notify the user via email
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      const snap    = await users().where("stripeCustomerId", "==", invoice.customer).limit(1).get();
      if (!snap.empty && snap.docs[0].data().email !== ADMIN_EMAIL) {
        const userData = snap.docs[0].data();
        const userEmail = userData.email;
        const userName = userData.name || "";
        const billingUrl = `${process.env.APP_URL || "https://goswft.com"}/swft-billing`;

        // Send via admin Gmail if tokens available
        try {
          const adminSnap = await users().where("email", "==", ADMIN_EMAIL).limit(1).get();
          if (!adminSnap.empty) {
            const admin = adminSnap.data ? adminSnap.data() : adminSnap.docs[0].data();
            if (admin.gmailConnected && admin.gmailTokens) {
              const oauth2Client = new google.auth.OAuth2(
                process.env.GOOGLE_CLIENT_ID,
                process.env.GOOGLE_CLIENT_SECRET,
                process.env.GOOGLE_REDIRECT_URI || "https://goswft.com/api/auth/google/callback"
              );
              oauth2Client.setCredentials(admin.gmailTokens);
              const gmail = google.gmail({ version: "v1", auth: oauth2Client });

              const subject = "SWFT — Payment Failed";
              const htmlBody = `
                <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;">
                  <h2 style="color:#0a0a0a;">Payment Failed</h2>
                  <p>Hi${userName ? " " + userName : ""},</p>
                  <p>We were unable to process your latest payment for your SWFT subscription. Please update your payment method to keep your account active.</p>
                  <p><a href="${billingUrl}" style="display:inline-block;padding:12px 24px;background:#0a0a0a;color:#c8f135;text-decoration:none;border-radius:6px;font-weight:600;">Update Payment Method</a></p>
                  <p style="color:#888;font-size:13px;">If you believe this is an error, please reply to this email.</p>
                  <p style="color:#888;font-size:12px;">— The SWFT Team</p>
                </div>`;

              const boundary = "swft_billing_" + Date.now();
              let mime = `From: SWFT <${admin.gmailAddress || ADMIN_EMAIL}>\r\n`;
              mime += `To: ${userEmail}\r\n`;
              mime += `Subject: ${subject}\r\n`;
              mime += `MIME-Version: 1.0\r\n`;
              mime += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
              mime += htmlBody;

              const encoded = Buffer.from(mime).toString("base64")
                .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

              await gmail.users.messages.send({ userId: "me", requestBody: { raw: encoded } });
              console.log("Payment-failed email sent successfully");
            }
          }
        } catch (emailErr) {
          console.error("Failed to send payment-failed email:", emailErr.message);
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.status(500).json({ error: "Webhook processing failed." });
  }
}

module.exports = { router, webhookHandler };
