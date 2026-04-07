const router = require("express").Router();
const { db } = require("../firebase");
const { getStripe } = require("../utils/stripe");
const { createSubAccount, buyPhoneNumber, closeSubAccount } = require("../twilio");

const { PLANS, OVERAGE_PACKS } = require("../plans");
const { addSmsCredits, addAiCredits } = require("../usage");

const ADMIN_EMAIL = "ethan@goswft.com";
const users = () => db.collection("users");

// Stripe Price IDs — monthly and annual for each plan
const PRICE_IDS = {
  starter:          "price_1TIc1URNPpAjdxw0uscz7ouv",
  pro:              "price_1TIc1VRNPpAjdxw0fwN1bfEH",
  business:         "price_1TIc1VRNPpAjdxw05e9i863i",
  starter_annual:   "price_starter_annual",   // TODO: replace with real Stripe price ID after creating in dashboard
  pro_annual:       "price_pro_annual",       // TODO: replace with real Stripe price ID after creating in dashboard
  business_annual:  "price_business_annual",  // TODO: replace with real Stripe price ID after creating in dashboard
};

/**
 * After checkout completes, pull the billing address from Stripe, store it on
 * the user profile, and (re-)provision a Twilio phone number that matches the
 * user's billing country so they get a local number.
 */
async function syncBillingAddress(uid, stripeCustomerId) {
  try {
    const stripe = getStripe();
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    const addr = customer.address;
    if (!addr) return;

    const billingAddress = {
      billingAddress: {
        line1:       addr.line1 || "",
        line2:       addr.line2 || "",
        city:        addr.city || "",
        state:       addr.state || "",
        postal_code: addr.postal_code || "",
        country:     addr.country || "",       // ISO 3166-1 alpha-2
      },
      country: addr.country || "",
    };
    await users().doc(uid).set(billingAddress, { merge: true });
    console.log(`[billing] Saved billing address for ${uid}: ${addr.city}, ${addr.state} ${addr.country}`);

    // Provision or re-provision Twilio with the billing country/region
    const userDoc = await users().doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    const billingCountry = addr.country || "US";
    const currentPhone = userData.twilioPhoneNumber || "";

    // Check if current phone already matches the billing country.
    // Country calling codes: US/CA = +1, GB = +44, AU = +61, etc.
    const COUNTRY_PREFIXES = {
      US: "+1", CA: "+1", GB: "+44", AU: "+61", NZ: "+64", IE: "+353",
      DE: "+49", FR: "+33", ES: "+34", IT: "+39", NL: "+31", MX: "+52",
      BR: "+55", IN: "+91", ZA: "+27",
    };
    const expectedPrefix = COUNTRY_PREFIXES[billingCountry];
    const alreadyMatches = expectedPrefix && currentPhone.startsWith(expectedPrefix);

    if (!userData.twilioSubAccountSid || !alreadyMatches) {
      // Close old sub-account if one exists but doesn't match
      if (userData.twilioSubAccountSid && !alreadyMatches) {
        try {
          await closeSubAccount(userData.twilioSubAccountSid);
          console.log(`[billing] Closed old Twilio sub-account ${userData.twilioSubAccountSid} (country mismatch)`);
        } catch (e) {
          console.error("[billing] Failed to close old sub-account:", e.message);
        }
      }

      const friendlyName = `SWFT - ${userData.email || uid}`;
      const webhookUrl = `${process.env.APP_URL || "https://goswft.com"}/api/webhooks/twilio/sms`;

      // For US/CA, use the billing state to get a regionally local number
      const region = (billingCountry === "US" || billingCountry === "CA")
        ? (addr.state || undefined)
        : undefined;

      const { subAccountSid, subAccountAuthToken } = await createSubAccount(friendlyName);
      const { phoneNumber, phoneSid } = await buyPhoneNumber(
        subAccountSid, subAccountAuthToken, webhookUrl,
        { countryCode: billingCountry, region }
      );

      await users().doc(uid).set({
        twilioSubAccountSid: subAccountSid,
        twilioSubAccountAuthToken: subAccountAuthToken,
        twilioPhoneNumber: phoneNumber,
        twilioPhoneSid: phoneSid,
      }, { merge: true });

      console.log(`[billing] Twilio provisioned for ${uid} in ${billingCountry}: ${phoneNumber}`);
    }
  } catch (err) {
    console.error("[billing] syncBillingAddress failed:", err.message);
  }
}

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
    const { plan, billing } = req.body;
    const basePlan = (plan || "starter").replace(/_annual$/, "");
    const planKey = PRICE_IDS[basePlan] ? basePlan : "starter";
    const isAnnual = billing === "annual";
    const priceId = isAnnual ? PRICE_IDS[`${planKey}_annual`] : PRICE_IDS[planKey];

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
      billing_address_collection: "required",
      customer_update: { address: "auto" },
      subscription_data: {
        trial_period_days: 14,
        metadata: { firebaseUid: req.uid, plan: planKey, billing: isAnnual ? "annual" : "monthly" },
      },
      return_url: `${process.env.APP_URL}/swft-checkout?session_id={CHECKOUT_SESSION_ID}&plan=${planKey}`,
      metadata:   { firebaseUid: req.uid, plan: planKey, billing: isAnnual ? "annual" : "monthly" },
    });

    res.json({ clientSecret: session.client_secret });
  } catch (err) { next(err); }
});

// GET /api/billing/plans — return plan info and Stripe price IDs (public-ish)
router.get("/plans", (req, res) => {
  res.json({
    starter: {
      name: "Starter", monthlyPrice: 89, annualPrice: 71,
      smsLimit: 150, aiMessageLimit: 75,
      priceId: PRICE_IDS.starter, annualPriceId: PRICE_IDS.starter_annual,
    },
    pro: {
      name: "Pro", monthlyPrice: 179, annualPrice: 143,
      smsLimit: 2000, aiMessageLimit: 1000,
      priceId: PRICE_IDS.pro, annualPriceId: PRICE_IDS.pro_annual,
    },
    business: {
      name: "Business", monthlyPrice: 349, annualPrice: 279,
      smsLimit: "Unlimited", aiMessageLimit: "Unlimited",
      priceId: PRICE_IDS.business, annualPriceId: PRICE_IDS.business_annual,
    },
    overagePacks: OVERAGE_PACKS,
  });
});

// POST /api/billing/portal — Create Stripe Customer Portal session
router.post("/portal", async (req, res, next) => {
  try {
    const stripe = getStripe();
    const userDoc = await users().doc(req.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    if (!userData.stripeCustomerId) {
      return res.status(400).json({ error: "No billing account found. Please subscribe to a plan first." });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: userData.stripeCustomerId,
      return_url: `${req.headers.origin || "https://goswft.com"}/swft-settings`,
    });
    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/billing/purchase-pack
//
// Purchases a one-time overage pack (SMS or AI credits).
// Creates a Stripe checkout session for a one-time payment.
// Body: { pack: "sms"|"ai" }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/purchase-pack", async (req, res, next) => {
  try {
    const { pack } = req.body;
    if (!pack || !OVERAGE_PACKS[pack]) {
      return res.status(400).json({ error: "Invalid pack type. Use 'sms' or 'ai'." });
    }

    const packInfo = OVERAGE_PACKS[pack];
    const stripe = getStripe();

    const doc  = await users().doc(req.uid).get();
    const data = doc.exists ? doc.data() : {};
    let customerId = data.stripeCustomerId || null;

    if (!customerId) {
      return res.status(400).json({ error: "No billing account found. Please subscribe to a plan first." });
    }

    const session = await stripe.checkout.sessions.create({
      ui_mode:  "embedded",
      customer: customerId,
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: `SWFT ${packInfo.name} — ${packInfo.units} credits` },
          unit_amount: packInfo.price * 100,
        },
        quantity: 1,
      }],
      mode: "payment",
      return_url: `${process.env.APP_URL}/swft-billing?pack_session_id={CHECKOUT_SESSION_ID}&pack=${pack}`,
      metadata: { firebaseUid: req.uid, packType: pack, packUnits: String(packInfo.units) },
    });

    res.json({ clientSecret: session.client_secret });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/billing/verify-pack?pack_session_id=cs_xxx&pack=sms|ai
//
// Verifies a pack purchase and credits the user's account.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/verify-pack", async (req, res, next) => {
  try {
    const { pack_session_id, pack } = req.query;
    if (!pack_session_id || !pack) {
      return res.status(400).json({ error: "pack_session_id and pack are required." });
    }

    const stripe  = getStripe();
    const session = await stripe.checkout.sessions.retrieve(pack_session_id);

    if (session.payment_status !== "paid") {
      return res.status(402).json({ error: "Payment not completed." });
    }

    const packInfo = OVERAGE_PACKS[pack];
    if (!packInfo) {
      return res.status(400).json({ error: "Invalid pack type." });
    }

    if (pack === "sms") {
      await addSmsCredits(req.uid, packInfo.units);
    } else {
      await addAiCredits(req.uid, packInfo.units);
    }

    res.json({ success: true, pack, units: packInfo.units });
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
      billingCycle:         session.metadata?.billing || "monthly",
      stripeSubscriptionId: session.subscription,
    }, { merge: true });

    // Sync billing address and provision a location-matched Twilio number
    if (session.customer) {
      syncBillingAddress(req.uid, session.customer).catch(err =>
        console.error("[verify-session] syncBillingAddress error:", err.message)
      );
    }

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
          billingCycle:         session.metadata?.billing || "monthly",
          stripeCustomerId:     session.customer,
          stripeSubscriptionId: session.subscription,
        }, { merge: true });

        // Sync billing address and provision a location-matched Twilio number
        if (session.customer) {
          syncBillingAddress(uid, session.customer).catch(err =>
            console.error("[billing-webhook] syncBillingAddress error:", err.message)
          );
        }
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
