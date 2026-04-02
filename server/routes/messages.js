const router = require("express").Router();
const { db } = require("../firebase");
const postmark = require("postmark");

const client = new postmark.ServerClient(process.env.POSTMARK_API_TOKEN || "32a85e4b-55e5-45e2-950e-6c120b001007");

// POST /api/messages/send — send email via Postmark
router.post("/send", async (req, res, next) => {
  try {
    const { to, subject, body, customerId, customerName, type } = req.body;
    if (!to || !subject) {
      return res.status(400).json({ error: "Recipient email and subject are required" });
    }

    // Get user's settings for sender info
    const userDoc = await db.collection("users").doc(req.uid).get();
    const user = userDoc.exists ? userDoc.data() : {};
    const fromEmail = user.email || "noreply@swft-crm.com";
    const fromName = user.company || user.name || "SWFT";

    const result = await client.sendEmail({
      From: `${fromName} <${fromEmail}>`,
      To: to,
      Subject: subject,
      HtmlBody: body || "<p>No content</p>",
      TextBody: body ? body.replace(/<[^>]*>/g, "") : "No content",
      MessageStream: "outbound",
    });

    // Save message to Firestore
    await db.collection("messages").add({
      userId: req.uid,
      to,
      subject,
      body: body || "",
      customerId: customerId || "",
      customerName: customerName || "",
      type: type || "email",
      status: "sent",
      postmarkId: result.MessageID,
      sentAt: Date.now(),
    });

    res.json({ success: true, messageId: result.MessageID });
  } catch (err) {
    console.error("Postmark error:", err);
    res.status(500).json({ error: err.message || "Failed to send email" });
  }
});

// GET /api/messages — list sent messages
router.get("/", async (req, res, next) => {
  try {
    const snap = await db.collection("messages").where("userId", "==", req.uid).get();
    let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    results.sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));
    res.json(results);
  } catch (err) { next(err); }
});

// DELETE /api/messages/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await db.collection("messages").doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.uid) {
      return res.status(404).json({ error: "Message not found" });
    }
    await db.collection("messages").doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
