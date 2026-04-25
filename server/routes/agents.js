const router = require("express").Router();
const { db } = require("../firebase");
const { generateEstimate } = require("../ai/estimator-agent");
const { convKey } = require("../ai/auto-reply");

// ── Firestore path helper ──
function agentsRef(orgId) {
  return db.collection("orgs").doc(orgId).collection("agentConfigs");
}

// Default configs for each agent type
const DEFAULTS = {
  estimator: {
    enabled: false,
    inputTypes: "photos_text",
    basePriceMin: 9,
    basePriceMax: 17,
    markupPct: 22,
    autoSend: false,
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
