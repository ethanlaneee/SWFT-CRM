// ════════════════════════════════════════════════
// Team Chat — internal messaging between team members
// ════════════════════════════════════════════════

const router = require("express").Router();
const { db } = require("../firebase");

const chatsCol = () => db.collection("teamChats");
const msgsCol = (chatId) => db.collection("teamChats").doc(chatId).collection("messages");

// ── List all chats for this org ──
router.get("/", async (req, res, next) => {
  try {
    const snap = await chatsCol().where("orgId", "==", req.orgId).orderBy("updatedAt", "desc").get();
    const chats = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ chats });
  } catch (err) { next(err); }
});

// ── Create a new chat (direct or group) ──
router.post("/", async (req, res, next) => {
  try {
    const { name, memberIds } = req.body;
    if (!memberIds || !Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({ error: "memberIds required" });
    }

    // Ensure creator is included
    const allMembers = [...new Set([req.uid, ...memberIds])];
    const isDirect = allMembers.length === 2 && !name;

    // For direct chats, check if one already exists between these two users
    if (isDirect) {
      const existing = await chatsCol()
        .where("orgId", "==", req.orgId)
        .where("isDirect", "==", true)
        .get();
      const found = existing.docs.find(d => {
        const m = d.data().memberIds || [];
        return m.length === 2 && allMembers.every(id => m.includes(id));
      });
      if (found) {
        return res.json({ id: found.id, ...found.data() });
      }
    }

    const data = {
      orgId: req.orgId,
      name: name || "",
      isDirect,
      memberIds: allMembers,
      createdBy: req.uid,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastMessage: null,
    };

    const ref = await chatsCol().add(data);
    res.status(201).json({ id: ref.id, ...data });
  } catch (err) { next(err); }
});

// ── Get messages for a chat ──
router.get("/:chatId/messages", async (req, res, next) => {
  try {
    // Verify the chat belongs to this org and user is a member
    const chatDoc = await chatsCol().doc(req.params.chatId).get();
    if (!chatDoc.exists || chatDoc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Chat not found" });
    }
    if (!chatDoc.data().memberIds.includes(req.uid)) {
      return res.status(403).json({ error: "Not a member of this chat" });
    }

    const snap = await msgsCol(req.params.chatId).orderBy("createdAt", "asc").get();
    const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ messages });
  } catch (err) { next(err); }
});

// ── Send a message to a chat ──
router.post("/:chatId/messages", async (req, res, next) => {
  try {
    const chatDoc = await chatsCol().doc(req.params.chatId).get();
    if (!chatDoc.exists || chatDoc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Chat not found" });
    }
    if (!chatDoc.data().memberIds.includes(req.uid)) {
      return res.status(403).json({ error: "Not a member of this chat" });
    }

    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Message text required" });
    }

    const msg = {
      senderId: req.uid,
      senderName: req.body.senderName || "",
      text: text.trim(),
      createdAt: Date.now(),
    };

    const ref = await msgsCol(req.params.chatId).add(msg);

    // Update chat's last message preview
    await chatsCol().doc(req.params.chatId).update({
      lastMessage: { text: msg.text.slice(0, 100), senderName: msg.senderName, createdAt: msg.createdAt },
      updatedAt: Date.now(),
    });

    res.status(201).json({ id: ref.id, ...msg });
  } catch (err) { next(err); }
});

// ── Delete a chat ──
router.delete("/:chatId", async (req, res, next) => {
  try {
    const chatDoc = await chatsCol().doc(req.params.chatId).get();
    if (!chatDoc.exists || chatDoc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Chat not found" });
    }

    // Delete all messages in subcollection
    const msgSnap = await msgsCol(req.params.chatId).get();
    const batch = db.batch();
    msgSnap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(chatsCol().doc(req.params.chatId));
    await batch.commit();

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
