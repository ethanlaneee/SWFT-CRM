/**
 * SWFT Phone AI — API routes
 *
 * Add-on subscription ($39/mo) that provisions an AI voice receptionist for
 * each org via Vapi.ai. Missed / inbound calls are answered by Claude, the
 * transcript is saved to Firestore, and leads can be converted to customers
 * + jobs with a single click.
 *
 * Public route (no auth):
 *   POST /api/phone/vapi-webhook  ← Vapi fires this after every call
 *
 * Authenticated routes (require auth + checkAccess via index.js):
 *   GET    /api/phone/status
 *   POST   /api/phone/subscribe
 *   GET    /api/phone/verify-session
 *   POST   /api/phone/provision
 *   PUT    /api/phone/settings
 *   GET    /api/phone/calls
 *   GET    /api/phone/calls/:id
 *   POST   /api/phone/calls/:id/lead
 *   DELETE /api/phone/cancel
 */

const router  = require("express").Router();
const { db }  = require("../firebase");
const { getStripe } = require("../utils/stripe");
const {
  getOrCreateVapiAssistant,
  provisionPhoneNumber,
  releasePhoneNumber,
} = require("../ai/phone-agent");

// Stripe Price ID for the phone add-on (create this in Stripe dashboard)
const PHONE_ADDON_PRICE_ID = process.env.PHONE_ADDON_PRICE_ID || "price_phone_addon_monthly";
const PHONE_ADDON_PRICE    = 39; // dollars/month (display only)

const phoneSettings = () => db.collection("phoneSettings");
const callLogs      = () => db.collection("callLogs");
const users         = () => db.collection("users");
const customers     = () => db.collection("customers");
const jobs          = () => db.collection("jobs");

// ── Default phone settings ────────────────────────────────────────────────────

const DEFAULTS = {
  greeting:           "",
  customInstructions: "",
  voiceId:            "jennifer",
  collectName:        true,
  collectEmail:       false,
  collectAddress:     false,
  collectJobDetails:  true,
  enabled:            true,
};

function withDefaults(stored = {}) {
  return { ...DEFAULTS, ...stored };
}

// ── GET /api/phone/status ─────────────────────────────────────────────────────

router.get("/status", async (req, res, next) => {
  try {
    const doc  = await phoneSettings().doc(req.orgId).get();
    const data = doc.exists ? doc.data() : {};

    const userDoc  = await users().doc(req.orgId).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    // Compute call stats
    let totalCalls   = 0;
    let leadsCreated = 0;
    let totalSeconds = 0;

    if (data.provisioned) {
      const snap = await callLogs()
        .where("orgId", "==", req.orgId)
        .orderBy("startedAt", "desc")
        .limit(200)
        .get();
      totalCalls = snap.size;
      snap.forEach(d => {
        const c = d.data();
        if (c.leadCreated) leadsCreated++;
        if (c.durationSeconds) totalSeconds += c.durationSeconds;
      });
    }

    res.json({
      subscribed:    Boolean(data.subscribed),
      provisioned:   Boolean(data.provisioned),
      enabled:       data.enabled !== false,
      phoneNumber:   data.phoneNumber   || null,
      phoneNumberId: data.phoneNumberId || null,
      assistantId:   data.vapiAssistantId || null,
      settings:      withDefaults(data.settings || {}),
      stats: {
        totalCalls,
        leadsCreated,
        avgDurationSeconds: totalCalls ? Math.round(totalSeconds / totalCalls) : 0,
      },
      billing: {
        price: PHONE_ADDON_PRICE,
        stripeSubscriptionId: data.stripeSubscriptionId || null,
        subscribedAt: data.subscribedAt || null,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /api/phone/subscribe — create Stripe checkout for phone add-on ───────

router.post("/subscribe", async (req, res, next) => {
  try {
    const stripe  = getStripe();
    const userDoc = await users().doc(req.orgId).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    if (!userData.stripeCustomerId) {
      return res.status(400).json({ error: "No billing account found. Please subscribe to a SWFT plan first." });
    }

    // Check not already subscribed
    const phoneDoc = await phoneSettings().doc(req.orgId).get();
    if (phoneDoc.exists && phoneDoc.data().subscribed) {
      return res.status(409).json({ error: "Phone add-on is already active on this account." });
    }

    const appUrl = process.env.APP_URL || "https://goswft.com";

    const session = await stripe.checkout.sessions.create({
      customer:    userData.stripeCustomerId,
      line_items:  [{ price: PHONE_ADDON_PRICE_ID, quantity: 1 }],
      mode:        "subscription",
      allow_promotion_codes: true,
      success_url: `${appUrl}/swft-phone?phone_session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${appUrl}/swft-phone`,
      metadata:    { firebaseUid: req.orgId, addon: "phone" },
      subscription_data: {
        metadata: { firebaseUid: req.orgId, addon: "phone" },
      },
    });

    res.json({ url: session.url });
  } catch (err) { next(err); }
});

// ── GET /api/phone/verify-session?phone_session_id=cs_xxx ────────────────────

router.get("/verify-session", async (req, res, next) => {
  try {
    const { phone_session_id } = req.query;
    if (!phone_session_id) {
      return res.status(400).json({ error: "phone_session_id is required." });
    }

    const stripe  = getStripe();
    const session = await stripe.checkout.sessions.retrieve(phone_session_id);

    if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
      return res.status(402).json({ error: "Payment not completed." });
    }

    await phoneSettings().doc(req.orgId).set({
      subscribed:           true,
      provisioned:          false,
      stripeSubscriptionId: session.subscription,
      subscribedAt:         Date.now(),
    }, { merge: true });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/phone/provision — create Vapi assistant + buy phone number ──────

router.post("/provision", async (req, res, next) => {
  try {
    const phoneDoc  = await phoneSettings().doc(req.orgId).get();
    const phoneData = phoneDoc.exists ? phoneDoc.data() : {};

    if (!phoneData.subscribed) {
      return res.status(402).json({ error: "Phone add-on subscription required." });
    }
    if (phoneData.provisioned && phoneData.phoneNumber) {
      return res.status(409).json({ error: "A phone number is already provisioned for this account.", phoneNumber: phoneData.phoneNumber });
    }

    const userDoc  = await users().doc(req.orgId).get();
    const orgData  = userDoc.exists ? userDoc.data() : {};
    const settings = withDefaults(phoneData.settings || {});

    const { areaCode, country } = req.body;

    // Create or update Vapi assistant
    const vapiAssistantId = await getOrCreateVapiAssistant(req.orgId, orgData, settings);

    // Provision phone number
    const { phoneNumberId, phoneNumber } = await provisionPhoneNumber(vapiAssistantId, country, areaCode);

    await phoneSettings().doc(req.orgId).set({
      provisioned:    true,
      vapiAssistantId,
      phoneNumberId,
      phoneNumber,
      provisionedAt:  Date.now(),
    }, { merge: true });

    res.json({ success: true, phoneNumber, vapiAssistantId, phoneNumberId });
  } catch (err) { next(err); }
});

// ── PUT /api/phone/settings — update AI config ────────────────────────────────

router.put("/settings", async (req, res, next) => {
  try {
    const body = req.body || {};

    const settings = {
      greeting:           String(body.greeting           || "").slice(0, 500),
      customInstructions: String(body.customInstructions || "").slice(0, 2000),
      voiceId:            ["jennifer", "ryan", "natalie", "will"].includes(body.voiceId) ? body.voiceId : "jennifer",
      collectName:        body.collectName        !== false,
      collectEmail:       Boolean(body.collectEmail),
      collectAddress:     Boolean(body.collectAddress),
      collectJobDetails:  body.collectJobDetails  !== false,
      enabled:            body.enabled            !== false,
    };

    await phoneSettings().doc(req.orgId).set({ settings, updatedAt: Date.now() }, { merge: true });

    // Rebuild Vapi assistant if already provisioned
    const phoneDoc = await phoneSettings().doc(req.orgId).get();
    const phoneData = phoneDoc.data() || {};
    if (phoneData.provisioned && phoneData.vapiAssistantId) {
      const userDoc = await users().doc(req.orgId).get();
      const orgData = userDoc.exists ? userDoc.data() : {};
      await getOrCreateVapiAssistant(req.orgId, orgData, settings).catch(err =>
        console.error("[phone/settings] Vapi assistant update failed:", err.message)
      );
    }

    res.json({ success: true, settings });
  } catch (err) { next(err); }
});

// ── GET /api/phone/calls — list call log ──────────────────────────────────────

router.get("/calls", async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const snap   = await callLogs()
      .where("orgId", "==", req.orgId)
      .orderBy("startedAt", "desc")
      .limit(limit)
      .get();

    const calls = snap.docs.map(d => {
      const c = d.data();
      return {
        id:              d.id,
        callerNumber:    c.callerNumber    || "Unknown",
        callerName:      c.callerName      || null,
        startedAt:       c.startedAt       || null,
        endedAt:         c.endedAt         || null,
        durationSeconds: c.durationSeconds || 0,
        summary:         c.summary         || null,
        leadCreated:     Boolean(c.leadCreated),
        customerId:      c.customerId      || null,
        jobId:           c.jobId           || null,
        recordingUrl:    c.recordingUrl    || null,
      };
    });

    res.json({ calls });
  } catch (err) { next(err); }
});

// ── GET /api/phone/calls/:id — get call detail with transcript ────────────────

router.get("/calls/:id", async (req, res, next) => {
  try {
    const doc = await callLogs().doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Call not found." });

    const c = doc.data();
    if (c.orgId !== req.orgId) return res.status(403).json({ error: "Access denied." });

    res.json({
      id:              doc.id,
      callerNumber:    c.callerNumber    || "Unknown",
      callerName:      c.callerName      || null,
      callerEmail:     c.callerEmail     || null,
      callerAddress:   c.callerAddress   || null,
      jobDescription:  c.jobDescription  || null,
      startedAt:       c.startedAt       || null,
      endedAt:         c.endedAt         || null,
      durationSeconds: c.durationSeconds || 0,
      transcript:      c.transcript      || "",
      summary:         c.summary         || null,
      leadCreated:     Boolean(c.leadCreated),
      customerId:      c.customerId      || null,
      jobId:           c.jobId           || null,
      recordingUrl:    c.recordingUrl    || null,
      cost:            c.cost            || null,
    });
  } catch (err) { next(err); }
});

// ── POST /api/phone/calls/:id/lead — convert call to customer + job ───────────

router.post("/calls/:id/lead", async (req, res, next) => {
  try {
    const doc = await callLogs().doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Call not found." });

    const c = doc.data();
    if (c.orgId !== req.orgId) return res.status(403).json({ error: "Access denied." });
    if (c.leadCreated)         return res.status(409).json({ error: "Lead already created for this call.", customerId: c.customerId, jobId: c.jobId });

    const body = req.body || {};

    // Build customer data from call + optional overrides
    const firstName = body.firstName || (c.callerName || "").split(" ")[0] || "Unknown";
    const lastName  = body.lastName  || (c.callerName || "").split(" ").slice(1).join(" ") || "Caller";
    const phone     = body.phone     || c.callerNumber || "";
    const email     = body.email     || c.callerEmail  || "";
    const address   = body.address   || c.callerAddress || "";

    const now = Date.now();

    // Create customer
    const custRef = customers().doc();
    const custData = {
      orgId:     req.orgId,
      firstName,
      lastName,
      name:      `${firstName} ${lastName}`.trim(),
      phone,
      email,
      address,
      source:    "phone_ai",
      createdAt: now,
      updatedAt: now,
    };
    await custRef.set(custData);

    // Create job
    const jobRef  = jobs().doc();
    const jobData = {
      orgId:       req.orgId,
      customerId:  custRef.id,
      customerName: custData.name,
      title:       body.jobTitle       || `Call from ${custData.name}`,
      description: body.jobDescription || c.jobDescription || c.summary || "",
      service:     body.service        || "",
      status:      "lead",
      source:      "phone_ai",
      callId:      doc.id,
      createdAt:   now,
      updatedAt:   now,
    };
    await jobRef.set(jobData);

    // Mark call as converted
    await doc.ref.update({
      leadCreated: true,
      customerId:  custRef.id,
      jobId:       jobRef.id,
      convertedAt: now,
    });

    res.json({ success: true, customerId: custRef.id, jobId: jobRef.id });
  } catch (err) { next(err); }
});

// ── DELETE /api/phone/cancel — cancel subscription + release number ───────────

router.delete("/cancel", async (req, res, next) => {
  try {
    const phoneDoc  = await phoneSettings().doc(req.orgId).get();
    const phoneData = phoneDoc.exists ? phoneDoc.data() : {};

    if (!phoneData.subscribed) {
      return res.status(400).json({ error: "No active phone add-on subscription." });
    }

    // Cancel Stripe subscription
    if (phoneData.stripeSubscriptionId) {
      try {
        const stripe = getStripe();
        await stripe.subscriptions.cancel(phoneData.stripeSubscriptionId);
      } catch (err) {
        console.error("[phone/cancel] Stripe cancel failed:", err.message);
      }
    }

    // Release Vapi phone number
    if (phoneData.phoneNumberId) {
      await releasePhoneNumber(phoneData.phoneNumberId);
    }

    await phoneSettings().doc(req.orgId).set({
      subscribed:  false,
      provisioned: false,
      phoneNumber: null,
      canceledAt:  Date.now(),
    }, { merge: true });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: POST /api/phone/vapi-webhook
// Vapi fires this after every call ends. No Firebase auth — verified via
// x-vapi-secret header.
// ─────────────────────────────────────────────────────────────────────────────

async function vapiWebhookHandler(req, res) {
  // Verify shared secret (optional but strongly recommended)
  const expectedSecret = process.env.VAPI_WEBHOOK_SECRET;
  if (expectedSecret) {
    const incoming = req.headers["x-vapi-secret"] || "";
    if (incoming !== expectedSecret) {
      console.warn("[phone-webhook] Invalid x-vapi-secret");
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const msg = req.body?.message;
  if (!msg) return res.json({ received: true });

  // We only care about end-of-call reports
  if (msg.type !== "end-of-call-report") return res.json({ received: true });

  try {
    const call        = msg.call || {};
    const assistantId = call.assistantId || "";
    const analysis    = msg.analysis     || {};

    if (!assistantId) return res.json({ received: true });

    // Look up org by vapiAssistantId
    const snap = await db.collection("phoneSettings")
      .where("vapiAssistantId", "==", assistantId)
      .limit(1)
      .get();

    if (snap.empty) {
      console.warn("[phone-webhook] No org found for assistantId:", assistantId);
      return res.json({ received: true });
    }

    const orgId = snap.docs[0].id;

    // Parse timestamps + duration
    const startedAt   = call.startedAt  ? new Date(call.startedAt).getTime()  : Date.now();
    const endedAt     = call.endedAt    ? new Date(call.endedAt).getTime()    : Date.now();
    const durationSec = Math.round((endedAt - startedAt) / 1000);

    // Extract structured data from Vapi analysis if available
    const structuredData = analysis.structuredData || {};

    // Try to pull caller info from the transcript/analysis summary
    const summary        = analysis.summary        || msg.summary || "";
    const transcript     = msg.transcript          || "";
    const callerNumber   = call.customer?.number   || "Unknown";

    // Simple name extraction from structured data (Vapi can return this if configured)
    const callerName     = structuredData.callerName    || extractNameFromTranscript(transcript)  || null;
    const callerEmail    = structuredData.callerEmail   || null;
    const callerAddress  = structuredData.callerAddress || null;
    const jobDescription = structuredData.jobDescription || summary || null;

    await callLogs().add({
      orgId,
      vapiCallId:      call.id        || null,
      callerNumber,
      callerName,
      callerEmail,
      callerAddress,
      jobDescription,
      startedAt,
      endedAt,
      durationSeconds: durationSec,
      transcript,
      summary,
      recordingUrl:    msg.recordingUrl || call.recordingUrl || null,
      cost:            call.cost        || null,
      leadCreated:     false,
      createdAt:       Date.now(),
    });

    console.log(`[phone-webhook] Saved call log for org ${orgId}, caller ${callerNumber}, ${durationSec}s`);
  } catch (err) {
    console.error("[phone-webhook] Error saving call log:", err.message);
  }

  res.json({ received: true });
}

// Simple heuristic: look for "my name is X" or "I'm X" in the transcript
function extractNameFromTranscript(transcript) {
  if (!transcript) return null;
  const m = transcript.match(/(?:my name is|i(?:'|')m|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  return m ? m[1].trim() : null;
}

module.exports = { router, vapiWebhookHandler };
