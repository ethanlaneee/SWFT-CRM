/**
 * Twilio inbound SMS webhook — POST /api/sms/inbound
 *
 * Twilio sends a form-encoded POST whenever a message arrives on the
 * SWFT number.  We:
 *   1. Validate the Twilio signature (skipped in dev if no secret set)
 *   2. Match the sender's phone number to a customer in Firestore
 *   3. Store the message
 *   4. Fire the AI auto-reply pipeline
 *   5. Respond with empty TwiML (Twilio requires a 200 with valid XML)
 */

const router = require("express").Router();
const { db } = require("../firebase");
const { validateWebhook, sendSms } = require("../utils/twilio");
const { handleInboundMeta } = require("../ai/auto-reply");
const { notifyInboundMessage } = require("../utils/notifications");

// Twilio posts URL-encoded bodies
router.use(require("express").urlencoded({ extended: false }));

router.post("/inbound", async (req, res) => {
  // Validate signature in production
  if (process.env.NODE_ENV === "production" && !validateWebhook(req)) {
    return res.status(403).send("Forbidden");
  }

  const from  = req.body.From  || "";   // e.g. +15551234567
  const body  = req.body.Body  || "";
  const toNum = req.body.To    || "";   // our Twilio number

  if (!from || !body) {
    return res.status(200).set("Content-Type", "text/xml").send("<Response/>");
  }

  try {
    // Normalise phone: strip formatting so +1 (555) 123-4567 and +15551234567 both match
    const normalise = (p) => p.replace(/\D/g, "");
    const fromDigits = normalise(from);

    // Find the org that owns this Twilio number
    const userSnap = await db.collection("users")
      .where("twilioPhoneNumber", "==", toNum)
      .limit(1)
      .get();

    if (userSnap.empty) {
      console.warn("[sms/inbound] No user owns number", toNum);
      return res.status(200).set("Content-Type", "text/xml").send("<Response/>");
    }

    const userDoc  = userSnap.docs[0];
    const userId   = userDoc.id;
    const userData = userDoc.data();
    const orgId    = userData.orgId || userId;

    // Match sender to a customer
    const custSnap = await db.collection("customers")
      .where("userId", "==", userId)
      .get();

    let matchedCustomer = null;
    for (const d of custSnap.docs) {
      const phone = d.data().phone || "";
      if (normalise(phone) === fromDigits) {
        matchedCustomer = { id: d.id, ...d.data() };
        break;
      }
    }

    const msgRecord = {
      userId,
      orgId,
      from,
      to: "inbound",
      body,
      type: "sms",
      platform: "sms",
      direction: "inbound",
      status: "received",
      customerId:   matchedCustomer?.id   || "",
      customerName: matchedCustomer?.name || from,
      phone: from,
      sentAt: Date.now(),
    };

    await db.collection("messages").add(msgRecord);

    notifyInboundMessage({
      orgId,
      channel: "sms",
      from: matchedCustomer?.name || from,
      body,
      customerId: matchedCustomer?.id || "",
    });

    // AI auto-reply (non-blocking — don't hold up the 200 response)
    if (matchedCustomer) {
      const matched = { customerId: matchedCustomer.id, customerName: matchedCustomer.name || from };
      handleInboundMeta(orgId, userId, userData, from, body, "sms", matched, (replyBody) => sendSms(from, replyBody))
        .catch((e) => console.error("[sms/inbound] auto-reply error:", e.message));
    }

    res.status(200).set("Content-Type", "text/xml").send("<Response/>");
  } catch (err) {
    console.error("[sms/inbound] error:", err.message);
    res.status(200).set("Content-Type", "text/xml").send("<Response/>");
  }
});

module.exports = router;
