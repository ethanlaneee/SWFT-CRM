const router = require("express").Router();
const { db } = require("../firebase");
const { generateEstimate } = require("../ai/estimator-agent");
const { convKey } = require("../ai/auto-reply");

// ── Firestore path helper ──
function agentsRef(orgId) {
  return db.collection("orgs").doc(orgId).collection("agentConfigs");
}

// Default configs for each agent type. Each proactive agent runs
// autonomously when enabled — when an agent is on, it scans your data
// and sends emails on your behalf. No drafts-for-approval queue: if
// you've turned it on, you've handed it the wheel. Default off so new
// orgs explicitly opt in.
const DEFAULTS = {
  ceo: {
    enabled: false,
    description: "The autonomous CEO that runs your AI team. Each hour it scans your business, decides what's worth doing, and dispatches the Admin / Sales / Customer Service specialists. Turn this on and it acts on its own — no approval queue.",
    label: "CEO Agent",
  },
  estimator: {
    enabled: false,
    inputTypes: "photos_text",
    basePriceMin: 9,
    basePriceMax: 17,
    markupPct: 22,
    autoSend: false,
  },
  quote_followup: {
    enabled: false,
    thresholdDays: 3,
    description: "Watches every sent quote. If the customer hasn't replied after the threshold, sends a warm follow-up email.",
    label: "Quote Follow-up",
  },
  invoice_followup: {
    enabled: false,
    thresholdDays: 7,
    description: "Watches every open invoice. If it's been unpaid past the threshold, sends a polite payment reminder.",
    label: "Payment Reminder",
  },
  review_request: {
    enabled: false,
    thresholdDays: 1,
    description: "Watches every completed job. After the threshold, sends a thank-you that asks for a Google review.",
    label: "Review Request",
  },
  lead_followup: {
    enabled: false,
    thresholdDays: 1,
    description: "Watches new leads from your intake form and customers tagged as leads who haven't gotten a quote. Sends a personalized follow-up so warm interest doesn't go cold.",
    label: "Lead Follow-up",
  },
  auto_reply: {
    enabled: false,
    thresholdDays: 0,
    description: "Replies to incoming SMS, email, Facebook, and Instagram messages from customers. Trained on your business info.",
    label: "Auto-Reply",
  },
};

const VALID_AGENTS = Object.keys(DEFAULTS);

// GET /api/agents — list all agent configs for this org
router.get("/", async (req, res, next) => {
  try {
    const snap = await agentsRef(req.orgId).get();
    const configs = {};
    snap.forEach((doc) => {
      configs[doc.id] = doc.data();
    });
    // Fill in defaults for any agents not yet configured
    for (const id of VALID_AGENTS) {
      if (!configs[id]) configs[id] = { ...DEFAULTS[id] };
    }
    res.json(configs);
  } catch (err) { next(err); }
});

// GET /api/agents/_activity — global recent activity across every agent.
// Underscore prefix keeps it from colliding with the /:agentId route.
router.get("/_activity", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const snap = await db.collection("orgs").doc(req.orgId)
      .collection("agentActivity")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) { next(err); }
});

// POST /api/agents/_scan — manually trigger the proactive agent for this org.
// Surfaces in the UI as a "Run scan now" button.
router.post("/_scan", async (req, res, next) => {
  try {
    const { scanAndDraft } = require("../ai/proactive-agent");
    const drafted = await scanAndDraft(req.orgId, req.uid);
    res.json({ drafted });
  } catch (err) { next(err); }
});

// POST /api/agents/_ceo_run — manually trigger the CEO agent for this org.
// Lets the user kick off a tick on demand to see what the CEO decides.
router.post("/_ceo_run", async (req, res, next) => {
  try {
    const { runCeo } = require("../ai/ceo-agent");
    const result = await runCeo(req.orgId, req.uid);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/agents/_seed_test — seed a customer + job + sent quote + open
// invoice with backdated timestamps so the autonomous agents have real
// targets to act on right away. Use once, then "Run CEO Now" on the
// hub. Body: { email: "..." }. Returns the created IDs so the user can
// clean up later.
router.post("/_seed_test", async (req, res, next) => {
  try {
    const email = (req.body?.email || "").trim();
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email required in body.email" });
    }
    const now = Date.now();
    const fiveDaysAgo = now - 5 * 86400000;
    const tenDaysAgo  = now - 10 * 86400000;
    const oneDayAgo   = now - 1 * 86400000;

    const customerData = {
      orgId: req.orgId,
      userId: req.uid,
      name: "Agent Test Customer",
      email,
      phone: "",
      address: "123 Test Street",
      notes: "Created by /api/agents/_seed_test for autonomous-agent testing. Safe to delete.",
      tags: ["test", "lead"],
      createdAt: oneDayAgo,
    };
    const custRef = await db.collection("customers").add(customerData);

    const quoteRef = await db.collection("quotes").add({
      orgId: req.orgId, userId: req.uid,
      customerId: custRef.id, customerName: customerData.name, customerEmail: email,
      service: "Test Service",
      items: [{ desc: "Test line item", qty: 1, rate: 500, total: 500 }],
      subtotal: 500, tax: 0, taxRate: 0, total: 500,
      status: "sent",
      sentAt: fiveDaysAgo, createdAt: fiveDaysAgo, updatedAt: fiveDaysAgo,
    });

    const invoiceRef = await db.collection("invoices").add({
      orgId: req.orgId, userId: req.uid,
      customerId: custRef.id, customerName: customerData.name, customerEmail: email,
      service: "Test Service",
      items: [{ desc: "Past-due test invoice", qty: 1, rate: 800, total: 800 }],
      subtotal: 800, tax: 0, taxRate: 0, total: 800,
      status: "open",
      createdAt: tenDaysAgo, updatedAt: tenDaysAgo,
    });

    const jobRef = await db.collection("jobs").add({
      orgId: req.orgId, userId: req.uid,
      customerId: custRef.id, customerName: customerData.name, customerEmail: email,
      title: "Agent Test Job", service: "Test Service",
      address: "123 Test Street", status: "scheduled",
      scheduledDate: new Date().toISOString().split("T")[0],
      createdAt: now, updatedAt: now,
    });

    res.json({
      success: true,
      customerId: custRef.id,
      jobId: jobRef.id,
      quoteId: quoteRef.id,
      invoiceId: invoiceRef.id,
      ageOfQuoteDays: 5,
      ageOfInvoiceDays: 10,
      next: "Open the Agents page, flip CEO Agent on, click Run CEO Now. The CEO should dispatch Admin to send a payment reminder + quote follow-up to " + email + ".",
    });
  } catch (err) { next(err); }
});

// GET /api/agents/:agentId — get single agent config
router.get("/:agentId", async (req, res, next) => {
  try {
    const { agentId } = req.params;
    if (!VALID_AGENTS.includes(agentId)) {
      return res.status(400).json({ error: "Invalid agent ID" });
    }
    const doc = await agentsRef(req.orgId).doc(agentId).get();
    res.json(doc.exists ? doc.data() : { ...DEFAULTS[agentId] });
  } catch (err) { next(err); }
});

// PUT /api/agents/:agentId — update agent config (partial merge)
router.put("/:agentId", async (req, res, next) => {
  try {
    const { agentId } = req.params;
    if (!VALID_AGENTS.includes(agentId)) {
      return res.status(400).json({ error: "Invalid agent ID" });
    }
    const updates = req.body;
    if (!updates || typeof updates !== "object") {
      return res.status(400).json({ error: "Body must be a JSON object" });
    }
    // Merge with defaults if doc doesn't exist yet
    const ref = agentsRef(req.orgId).doc(agentId);
    const doc = await ref.get();
    if (!doc.exists) {
      await ref.set({ ...DEFAULTS[agentId], ...updates, updatedAt: Date.now() });
    } else {
      await ref.update({ ...updates, updatedAt: Date.now() });
    }
    const updated = await ref.get();
    res.json(updated.data());
  } catch (err) { next(err); }
});

// POST /api/agents/:agentId/toggle — quick toggle enabled on/off
router.post("/:agentId/toggle", async (req, res, next) => {
  try {
    const { agentId } = req.params;
    if (!VALID_AGENTS.includes(agentId)) {
      return res.status(400).json({ error: "Invalid agent ID" });
    }
    const ref = agentsRef(req.orgId).doc(agentId);
    const doc = await ref.get();
    const current = doc.exists ? doc.data() : { ...DEFAULTS[agentId] };
    const newEnabled = !current.enabled;
    if (!doc.exists) {
      await ref.set({ ...DEFAULTS[agentId], enabled: newEnabled, updatedAt: Date.now() });
    } else {
      await ref.update({ enabled: newEnabled, updatedAt: Date.now() });
    }
    res.json({ enabled: newEnabled });
  } catch (err) { next(err); }
});

// GET /api/agents/:agentId/activity — recent activity log
router.get("/:agentId/activity", async (req, res, next) => {
  try {
    const { agentId } = req.params;
    if (!VALID_AGENTS.includes(agentId)) {
      return res.status(400).json({ error: "Invalid agent ID" });
    }
    const snap = await db.collection("orgs").doc(req.orgId)
      .collection("agentActivity")
      .where("agent", "==", agentId)
      .orderBy("createdAt", "desc")
      .limit(20)
      .get();
    const activity = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json(activity);
  } catch (err) { next(err); }
});

// ── Automation stats ──

// GET /api/agents/automations/stats — scheduled-message stats for this org
router.get("/automations/stats", async (req, res, next) => {
  try {
    const orgId = req.orgId;
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthMs = monthStart.getTime();

    const sentSnap = await db.collection("scheduledMessages")
      .where("orgId", "==", orgId)
      .where("status", "==", "sent")
      .get();
    const sentMTD = sentSnap.docs.filter(d => (d.data().sentAt || 0) >= monthMs);

    let emailsSentMTD = 0, smsSentMTD = 0, quoteTriggers = 0, invoiceTriggers = 0;
    for (const doc of sentMTD) {
      const d = doc.data();
      if (d.messageType === "email") emailsSentMTD++;
      if (d.messageType === "sms")   smsSentMTD++;
      if (d.trigger === "quote_sent") quoteTriggers++;
      if (d.trigger === "invoice_sent" || d.trigger === "invoice_paid") invoiceTriggers++;
    }

    const pendingSnap = await db.collection("scheduledMessages")
      .where("orgId", "==", orgId)
      .where("status", "==", "pending")
      .get();

    res.json({
      totalSentMTD: sentMTD.length,
      emailsSentMTD,
      smsSentMTD,
      quoteTriggers,
      invoiceTriggers,
      pendingCount: pendingSnap.size,
    });
  } catch (err) { next(err); }
});

// ── Conversation mode endpoints ──
// Used by the Messages UI to toggle per-thread auto / manual mode.
// Default is "auto" — AI replies to everything.  Switch to "manual" to
// take over a specific conversation yourself.

// GET /api/agents/conversations/:customerId/mode
router.get("/conversations/:customerId/mode", async (req, res, next) => {
  try {
    const key = `${req.orgId}_${req.params.customerId}`;
    const doc = await db.collection("conversationModes").doc(key).get();
    const mode = doc.exists ? (doc.data().mode || "auto") : "auto";
    res.json({ mode });
  } catch (err) { next(err); }
});

// PUT /api/agents/conversations/:customerId/mode
router.put("/conversations/:customerId/mode", async (req, res, next) => {
  try {
    const { mode } = req.body;
    if (!["auto", "manual"].includes(mode)) {
      return res.status(400).json({ error: "mode must be 'auto' or 'manual'" });
    }
    const key = `${req.orgId}_${req.params.customerId}`;
    await db.collection("conversationModes").doc(key).set({
      orgId: req.orgId,
      customerId: req.params.customerId,
      mode,
      updatedAt: Date.now(),
    }, { merge: true });
    res.json({ mode });
  } catch (err) { next(err); }
});

// POST /api/agents/estimator/estimate — generate a quote estimate via AI
// Body: { description, service, sqft, finish, customerId, customerName, address,
//         photos: [{ data: base64, mediaType: "image/jpeg" }] }
router.post("/estimator/estimate", async (req, res, next) => {
  try {
    const { description, service, sqft, finish, customerId, customerName, address, photos } = req.body;
    if (!description && !service && (!photos || photos.length === 0)) {
      return res.status(400).json({ error: "Provide a description, service type, or photos" });
    }
    const estimate = await generateEstimate(req.orgId, {
      description, service, sqft, finish, customerId, customerName, address, photos,
    });
    res.json(estimate);
  } catch (err) { next(err); }
});

module.exports = router;
