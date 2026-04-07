const router = require("express").Router();
const { db } = require("../firebase");

const col = () => db.collection("notifications");

// GET /api/notifications — list notifications for current user (most recent 50)
router.get("/", async (req, res, next) => {
  try {
    // Query by userId only, sort in code (avoids needing a composite index)
    const snap = await col()
      .where("userId", "==", req.uid)
      .get();
    let notifications = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    notifications.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    notifications = notifications.slice(0, 50);
    res.json(notifications);
  } catch (err) { next(err); }
});

// POST /api/notifications/read-all — mark all as read
router.post("/read-all", async (req, res, next) => {
  try {
    const snap = await col()
      .where("userId", "==", req.uid)
      .where("read", "==", false)
      .get();
    const batch = db.batch();
    snap.docs.forEach(doc => batch.update(doc.ref, { read: true }));
    if (snap.docs.length > 0) await batch.commit();
    res.json({ success: true, marked: snap.docs.length });
  } catch (err) { next(err); }
});

// POST /api/notifications/:id/read — mark single notification as read
router.post("/:id/read", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Not found" });
    }
    await col().doc(req.params.id).update({ read: true });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/notifications/:id — delete a notification
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Not found" });
    }
    await col().doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Helper — called by other routes to push a notification to a user
async function pushNotification(userId, { type, title, body, link }) {
  try {
    await db.collection("notifications").add({
      userId,
      type: type || "info",
      title: title || "",
      body: body || "",
      link: link || null,
      read: false,
      createdAt: Date.now(),
    });
  } catch (e) {
    console.error("pushNotification failed:", e.message);
  }
}

module.exports = { router, pushNotification };
