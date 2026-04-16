// ════════════════════════════════════════════════
// Team Chat — internal messaging between team members
// ════════════════════════════════════════════════

const router = require("express").Router();
const multer = require("multer");
const path = require("path");
const { db, bucket } = require("../firebase");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
});

const chatsCol = () => db.collection("teamChats");
const msgsCol = (chatId) => db.collection("teamChats").doc(chatId).collection("messages");

// ── List all chats for this org ──
router.get("/", async (req, res, next) => {
  try {
    const snap = await chatsCol().where("orgId", "==", req.orgId).get();
    const chats = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
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
        .get();
      const found = existing.docs.find(d => {
        const data = d.data();
        if (!data.isDirect) return false;
        const m = data.memberIds || [];
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

// ── Send a message to a chat (text or file) ──
router.post("/:chatId/messages", upload.array("files", 5), async (req, res, next) => {
  try {
    const chatDoc = await chatsCol().doc(req.params.chatId).get();
    if (!chatDoc.exists || chatDoc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Chat not found" });
    }
    if (!chatDoc.data().memberIds.includes(req.uid)) {
      return res.status(403).json({ error: "Not a member of this chat" });
    }

    const text = (req.body.text || "").trim();
    const files = req.files || [];

    if (!text && files.length === 0) {
      return res.status(400).json({ error: "Message text or file required" });
    }

    // Upload files to Firebase Storage
    const attachments = [];
    for (const file of files) {
      const ext = path.extname(file.originalname) || "";
      const filename = `team-chat/${req.params.chatId}/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
      const fileRef = bucket.file(filename);
      await fileRef.save(file.buffer, { metadata: { contentType: file.mimetype } });

      let url;
      try {
        await fileRef.makePublic();
        url = `https://storage.googleapis.com/${bucket.name}/${filename}`;
      } catch (_) {
        const [signedUrl] = await fileRef.getSignedUrl({ action: "read", expires: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000 });
        url = signedUrl;
      }

      attachments.push({
        url,
        name: file.originalname,
        type: file.mimetype,
        size: file.size,
      });
    }

    const msg = {
      senderId: req.uid,
      senderName: req.body.senderName || "",
      text,
      attachments: attachments.length ? attachments : null,
      createdAt: Date.now(),
    };

    const ref = await msgsCol(req.params.chatId).add(msg);

    // Update chat's last message preview
    const preview = text || (attachments.length === 1 ? attachments[0].name : `${attachments.length} files`);
    await chatsCol().doc(req.params.chatId).update({
      lastMessage: { text: preview.slice(0, 100), senderName: msg.senderName, createdAt: msg.createdAt },
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
