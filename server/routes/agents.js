const router = require("express").Router();
const { db } = require("../firebase");
const { generateEstimate } = require("../ai/estimator-agent");

// ── Firestore path helper ──
function agentsRef(orgId) {
  return db.collection("orgs").doc(orgId).collection("agentConfigs");
}

// Default configs for each agent type
const DEFAULTS = {
  receptionist: {
    enabled: false,
    businessHours: "24/7",
    channels: "voice_sms",
    escalateRule: "if_confused",
    tone: "friendly_professional",
    greeting: `Hi, thanks for calling! I'm the SWFT assistant. I can help you get a free estimate or answer questions. What are you looking for today?`,
  },
  estimator: {
    enabled: false,
    inputTypes: "photos_text",
    basePriceMin: 9,
    basePriceMax: 17,
    markupPct: 22,
    autoSend: false,
  },
  followup: {
    enabled: false,
    unsignedQuoteDays: [1, 3, 7],
    overdueInvoiceDays: [1, 3, 7],
    reviewRequestDelay: 24,
    reEngagementMonths: 12,
    channel: "sms",
    reviewMessage: `Hey {firstName}! It was great working on your {service} at {address}. If you're happy with how it turned out, a quick Google review would mean a lot to us. {reviewLink}`,
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
    // When follow-up agent is disabled, cancel all its pending followups
    if (!newEnabled && agentId === "followup") {
      const pendingSnap = await db.collection("followups")
        .where("orgId", "==", req.orgId)
        .where("status", "==", "pending")
        .get();
      if (!pendingSnap.empty) {
        const batch = db.batch();
        pendingSnap.docs.forEach(d => batch.update(d.ref, { status: "skipped", reason: "agent_disabled", updatedAt: Date.now() }));
        await batch.commit();
        console.log(`[agents] Cancelled ${pendingSnap.docs.length} pending followups for disabled follow-up agent`);
      }
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

// GET /api/agents/followup/stats — follow-up agent stats (real data)
router.get("/followup/stats", async (req, res, next) => {
  try {
    const orgId = req.orgId;
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthMs = monthStart.getTime();

    // Count follow-ups sent this month from followups collection
    const sentSnap = await db.collection("followups")
      .where("orgId", "==", orgId)
      .where("status", "==", "sent")
      .where("sentAt", ">=", monthMs)
      .get();

    let invoicesCollected = 0;
    let reviewsSent = 0;
    let quoteFollowups = 0;

    for (const doc of sentSnap.docs) {
      const f = doc.data();
      if (f.type === "overdue_invoice") invoicesCollected += (f.total || 0);
      if (f.type === "review_request") reviewsSent++;
      if (f.type === "unsigned_quote") quoteFollowups++;
    }

    // Also count sent scheduled messages from automations this month
    const schedSentSnap = await db.collection("scheduledMessages")
      .where("orgId", "==", orgId)
      .where("status", "==", "sent")
      .where("sentAt", ">=", monthMs)
      .get();

    const automationsSentMTD = schedSentSnap.size;

    // Count pending follow-ups
    const pendingSnap = await db.collection("followups")
      .where("orgId", "==", orgId)
      .where("status", "==", "pending")
      .get();

    // Count pending scheduled messages
    const schedPendingSnap = await db.collection("scheduledMessages")
      .where("orgId", "==", orgId)
      .where("status", "==", "pending")
      .get();

    res.json({
      invoicesCollected,
      reviewsSent,
      quoteFollowups,
      pendingCount: pendingSnap.size + schedPendingSnap.size,
      totalSentMTD: sentSnap.size + automationsSentMTD,
    });
  } catch (err) { next(err); }
});

// POST /api/agents/estimator/estimate — generate a quote estimate via AI
router.post("/estimator/estimate", async (req, res, next) => {
  try {
    const { description, service, sqft, finish, customerId, customerName, address } = req.body;
    if (!description && !service) {
      return res.status(400).json({ error: "Provide a description or service type" });
    }
    const estimate = await generateEstimate(req.orgId, {
      description, service, sqft, finish, customerId, customerName, address,
    });
    res.json(estimate);
  } catch (err) { next(err); }
});

module.exports = router;
