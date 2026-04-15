// ════════════════════════════════════════════════
// Team Messages — internal in-app DMs between team members
// No phone numbers required. Messages stored in Firestore.
// ════════════════════════════════════════════════

const router = require("express").Router();
const { db } = require("../firebase");

// Build a consistent conversation ID from two UIDs (sorted so both sides share one ID)
function makeConvId(uid1, uid2) {
  return [uid1, uid2].sort().join("_");
}

// GET /api/team-messages — list all conversations for the current user (latest message per thread)
// Uses a single-field query to avoid requiring a composite Firestore index.
router.get("/", async (req, res, next) => {
  try {
    // Fetch recent messages for the org and filter to ones involving req.uid in JS
    const snap = await db.collection("teamMessages")
      .where("orgId", "==", req.orgId)
      .limit(500)
      .get();

    const myUid = req.uid;
    const convMap = new Map();

    for (const doc of snap.docs) {
      const msg = { id: doc.id, ...doc.data() };
      // Only include conversations this user is part of
      if (msg.fromUid !== myUid && msg.toUid !== myUid) continue;
      const prev = convMap.get(msg.conversationId);
      if (!prev || msg.sentAt > prev.sentAt) convMap.set(msg.conversationId, msg);
    }

    const conversations = Array.from(convMap.values())
      .sort((a, b) => b.sentAt - a.sentAt);

    res.json({ conversations });
  } catch (err) { next(err); }
});

// GET /api/team-messages/:conversationId — get messages in a conversation
// Uses a single-field query (conversationId only) — no composite index needed.
router.get("/:conversationId", async (req, res, next) => {
  try {
    const convId = req.params.conversationId;

    // Security: make sure this user is a participant (convId = sorted UIDs joined by _)
    const [uid1, uid2] = convId.split("_");
    if (req.uid !== uid1 && req.uid !== uid2) {
      return res.status(403).json({ error: "Access denied" });
    }

    const snap = await db.collection("teamMessages")
      .where("conversationId", "==", convId)
      .limit(100)
      .get();

    const messages = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0));

    res.json({ messages });
  } catch (err) { next(err); }
});

// POST /api/team-messages — send a message to a team member
router.post("/", async (req, res, next) => {
  try {
    const { toUid, body } = req.body;
    if (!toUid || !body?.trim()) {
      return res.status(400).json({ error: "toUid and body are required" });
    }
    if (toUid === req.uid) {
      return res.status(400).json({ error: "Cannot message yourself" });
    }

    // Verify recipient is in the same org (two equality filters — no composite index needed)
    const teamSnap = await db.collection("team")
      .where("orgId", "==", req.orgId)
      .where("uid", "==", toUid)
      .limit(1)
      .get();

    const isOrgOwner = toUid === req.orgId;
    if (teamSnap.empty && !isOrgOwner) {
      return res.status(404).json({ error: "Recipient is not in your organization" });
    }

    // Get sender display name
    const senderDoc = await db.collection("users").doc(req.uid).get();
    const fromName = senderDoc.exists
      ? (senderDoc.data().name || senderDoc.data().email || "Team Member")
      : "Team Member";

    const conversationId = makeConvId(req.uid, toUid);
    const msgData = {
      orgId: req.orgId,
      conversationId,
      fromUid: req.uid,
      fromName,
      toUid,
      body: body.trim(),
      sentAt: Date.now(),
      readBy: [req.uid],
    };

    const ref = await db.collection("teamMessages").add(msgData);
    const msg = { id: ref.id, ...msgData };

    // Push to recipient in real-time if they're connected via WebSocket
    try {
      const { broadcastToUser } = require("../wsClients");
      broadcastToUser(toUid, { type: "team_message", data: msg });
    } catch (_) {}

    res.json({ success: true, message: msg });
  } catch (err) { next(err); }
});

// POST /api/team-messages/:conversationId/read — mark unread messages as read
router.post("/:conversationId/read", async (req, res, next) => {
  try {
    const convId = req.params.conversationId;
    const [uid1, uid2] = convId.split("_");
    if (req.uid !== uid1 && req.uid !== uid2) {
      return res.status(403).json({ error: "Access denied" });
    }

    const { FieldValue } = require("firebase-admin/firestore");
    const snap = await db.collection("teamMessages")
      .where("conversationId", "==", convId)
      .where("toUid", "==", req.uid)
      .limit(50)
      .get();

    const batch = db.batch();
    let count = 0;
    snap.docs.forEach(doc => {
      if (!(doc.data().readBy || []).includes(req.uid)) {
        batch.update(doc.ref, { readBy: FieldValue.arrayUnion(req.uid) });
        count++;
      }
    });
    if (count > 0) await batch.commit();

    res.json({ success: true, marked: count });
  } catch (err) { next(err); }
});

module.exports = router;
