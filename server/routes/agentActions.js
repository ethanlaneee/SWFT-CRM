const router = require("express").Router();
const { db } = require("../firebase");
const { sendSimpleGmail } = require("../utils/email");
const { scanAndDraft } = require("../ai/proactive-agent");

// GET /api/agent-actions — list actions for this org
router.get("/", async (req, res) => {
  try {
    const status = req.query.status || "pending";
    const snap = await db.collection("pendingAgentActions")
      .where("orgId", "==", req.orgId)
      .where("status", "==", status)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    const actions = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ actions });
  } catch (e) {
    console.error("[agent-actions] GET error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/agent-actions/scan — manually trigger scan
router.post("/scan", async (req, res) => {
  try {
    const drafted = await scanAndDraft(req.orgId, req.uid);
    res.json({ drafted });
  } catch (e) {
    console.error("[agent-actions] scan error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/agent-actions/:id/approve — send the drafted message
router.post("/:id/approve", async (req, res) => {
  try {
    const ref = db.collection("pendingAgentActions").doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Action not found" });
    }
    const action = doc.data();
    if (action.status !== "pending") {
      return res.status(400).json({ error: "Action already processed" });
    }

    // Load owner user doc for Gmail credentials
    const userDoc = await db.collection("users").doc(req.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });
    const user = { ...userDoc.data(), _uid: req.uid };

    if (!user.gmailConnected || !user.gmailTokens) {
      return res.status(400).json({ error: "Gmail not connected. Connect Gmail in Settings to send emails." });
    }

    const htmlBody = action.draftMessage.replace(/\n/g, "<br>");
    await sendSimpleGmail(
      user,
      action.recipientEmail,
      action.draftSubject,
      action.draftMessage,
      htmlBody
    );

    await ref.update({ status: "approved", approvedAt: Date.now(), approvedBy: req.uid });
    res.json({ ok: true });
  } catch (e) {
    console.error("[agent-actions] approve error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/agent-actions/:id — dismiss action
router.delete("/:id", async (req, res) => {
  try {
    const ref = db.collection("pendingAgentActions").doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Action not found" });
    }
    await ref.update({ status: "dismissed", dismissedAt: Date.now() });
    res.json({ ok: true });
  } catch (e) {
    console.error("[agent-actions] dismiss error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
