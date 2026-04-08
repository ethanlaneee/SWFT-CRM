// ════════════════════════════════════════════════
// Unified Social Messaging — Facebook Messenger, Instagram DMs, WhatsApp Business
// Webhook receivers (no auth) + send/connect/status endpoints (auth required)
// ════════════════════════════════════════════════

const router = require("express").Router();
const { admin, db } = require("../firebase");
const FieldValue = admin.firestore.FieldValue;

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";
const LOG = "[social-msg]";

// ─────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────

/** Strip non-digit characters for phone number comparison. */
function digitsOnly(phone) {
  return (phone || "").replace(/\D/g, "");
}

/**
 * Compare two phone numbers by their digit sequences.
 * Handles country-code mismatches (e.g. "15551234567" vs "5551234567").
 */
function phonesMatch(a, b) {
  const da = digitsOnly(a);
  const db_ = digitsOnly(b);
  if (!da || !db_) return false;
  return da === db_ || da === db_.slice(1) || "1" + da === db_ || db_ === da.slice(1) || "1" + db_ === da;
}

/**
 * Look up an org that owns a social integration by checking the users collection.
 * @param {string} field  - dot-path under integrations, e.g. "facebook.pageId"
 * @param {string} value  - value to match
 * @returns {{ uid: string, orgId: string, user: object } | null}
 */
async function findOrgByIntegration(field, value) {
  if (!value) return null;
  // Firestore cannot query nested map fields with dot-path "integrations.facebook.pageId"
  // directly, so we pull all users that have social integrations and check in-app.
  // For production scale you would denormalize into a lookup collection.
  const snap = await db.collection("users").get();
  for (const doc of snap.docs) {
    const data = doc.data();
    const parts = field.split(".");
    let ref = data.integrations;
    for (const p of parts) {
      if (!ref) break;
      ref = ref[p];
    }
    if (ref && String(ref) === String(value)) {
      return { uid: doc.id, orgId: data.orgId || doc.id, user: data };
    }
  }
  return null;
}

/**
 * Match a customer within an org by a given field/value.
 * @param {string} orgId
 * @param {string} field   - Firestore field to match ("facebookPsid", "instagramId", phone comparison)
 * @param {string} value
 * @param {"exact"|"phone"} mode
 * @returns {{ customerId: string, customerName: string } | null}
 */
async function matchCustomer(orgId, field, value, mode = "exact") {
  if (!orgId || !value) return null;
  const custSnap = await db.collection("customers").where("orgId", "==", orgId).get();
  for (const doc of custSnap.docs) {
    const data = doc.data();
    if (mode === "phone") {
      if (phonesMatch(data.phone, value)) {
        return { customerId: doc.id, customerName: data.name || "" };
      }
    } else {
      if (data[field] && String(data[field]) === String(value)) {
        return { customerId: doc.id, customerName: data.name || "" };
      }
    }
  }
  return null;
}

/**
 * Retrieve the page/business access token for a platform from the user's integrations.
 */
function getAccessToken(user, platform) {
  return user?.integrations?.[platform]?.accessToken || null;
}

/**
 * Get the page ID / phone number ID for a platform from the user's integrations.
 */
function getPlatformId(user, platform) {
  const map = {
    facebook: "pageId",
    instagram: "igBusinessId",
    whatsapp: "phoneNumberId",
  };
  return user?.integrations?.[platform]?.[map[platform]] || null;
}

// ─────────────────────────────────────────────────
// Facebook Messenger
// ─────────────────────────────────────────────────

/** GET /webhook/facebook — Meta verification handshake */
async function facebookVerifyWebhook(req, res) {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.FB_VERIFY_TOKEN) {
      console.log(`${LOG} Facebook webhook verified`);
      return res.status(200).send(challenge);
    }
    console.warn(`${LOG} Facebook webhook verification failed — token mismatch`);
    return res.sendStatus(403);
  } catch (err) {
    console.error(`${LOG} Facebook verify error:`, err);
    return res.sendStatus(500);
  }
}

/** POST /webhook/facebook — Receive Messenger messages */
async function facebookIncomingHandler(req, res) {
  try {
    // Always ACK quickly to avoid Meta retries
    res.sendStatus(200);

    const body = req.body;
    if (body.object !== "page") return;

    for (const entry of body.entry || []) {
      const pageId = entry.id;
      for (const event of entry.messaging || []) {
        const senderId = event.sender?.id;
        const messageText = event.message?.text;
        const messageId = event.message?.mid;
        const timestamp = event.timestamp || Date.now();

        if (!senderId || !messageText) continue;

        console.log(`${LOG} FB incoming from PSID ${senderId} on page ${pageId}: ${messageText.slice(0, 80)}`);

        // Find which org owns this page
        const owner = await findOrgByIntegration("facebook.pageId", pageId);
        if (!owner) {
          console.warn(`${LOG} No org found for Facebook page ${pageId}`);
          continue;
        }

        // Try to match sender to a customer
        const customer = await matchCustomer(owner.orgId, "facebookPsid", senderId);

        await db.collection("messages").add({
          userId: owner.uid,
          orgId: owner.orgId,
          customerId: customer?.customerId || "",
          customerName: customer?.customerName || senderId,
          from: senderId,
          to: "inbound",
          body: messageText,
          type: "facebook",
          platform: "facebook",
          direction: "inbound",
          status: "received",
          platformMessageId: messageId || "",
          sentAt: timestamp,
        });

        console.log(`${LOG} FB message stored for org ${owner.orgId}`);
      }
    }
  } catch (err) {
    console.error(`${LOG} Facebook incoming error:`, err);
    // Already sent 200 above
  }
}

/** POST /send/facebook — Send a message via Facebook Messenger (auth required) */
router.post("/send/facebook", async (req, res) => {
  try {
    const { to, body, customerId, customerName } = req.body;
    if (!to) return res.status(400).json({ error: "Recipient PSID (to) is required" });
    if (!body) return res.status(400).json({ error: "Message body is required" });

    const userDoc = await db.collection("users").doc(req.uid).get();
    const user = userDoc.exists ? userDoc.data() : {};

    const accessToken = getAccessToken(user, "facebook");
    const pageId = getPlatformId(user, "facebook");
    if (!accessToken || !pageId) {
      return res.status(400).json({ error: "Facebook Messenger not connected. Connect in Settings." });
    }

    // Send via Graph API
    const graphRes = await fetch(`${GRAPH_API_BASE}/${pageId}/messages?access_token=${accessToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: to },
        message: { text: body },
        messaging_type: "RESPONSE",
      }),
    });

    const graphData = await graphRes.json();
    if (graphData.error) {
      console.error(`${LOG} FB send error:`, graphData.error);
      return res.status(502).json({ error: graphData.error.message || "Facebook API error" });
    }

    const msgRecord = {
      userId: req.uid,
      orgId: req.orgId,
      customerId: customerId || "",
      customerName: customerName || "",
      from: pageId,
      to,
      body,
      type: "facebook",
      platform: "facebook",
      direction: "outbound",
      status: "sent",
      platformMessageId: graphData.message_id || "",
      sentAt: Date.now(),
    };

    const docRef = await db.collection("messages").add(msgRecord);
    console.log(`${LOG} FB message sent to ${to}, doc ${docRef.id}`);
    res.json({ success: true, id: docRef.id, messageId: graphData.message_id });
  } catch (err) {
    console.error(`${LOG} FB send error:`, err);
    res.status(500).json({ error: err.message || "Failed to send Facebook message" });
  }
});

// ─────────────────────────────────────────────────
// Instagram DMs
// ─────────────────────────────────────────────────

/** GET /webhook/instagram — Meta verification handshake for Instagram */
async function instagramVerifyWebhook(req, res) {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.IG_VERIFY_TOKEN) {
      console.log(`${LOG} Instagram webhook verified`);
      return res.status(200).send(challenge);
    }
    console.warn(`${LOG} Instagram webhook verification failed — token mismatch`);
    return res.sendStatus(403);
  } catch (err) {
    console.error(`${LOG} Instagram verify error:`, err);
    return res.sendStatus(500);
  }
}

/** POST /webhook/instagram — Receive Instagram DMs */
async function instagramIncomingHandler(req, res) {
  try {
    res.sendStatus(200);

    const body = req.body;
    if (body.object !== "instagram") return;

    for (const entry of body.entry || []) {
      const igBusinessId = entry.id;
      for (const event of entry.messaging || []) {
        const senderId = event.sender?.id; // IGSID
        const messageText = event.message?.text;
        const messageId = event.message?.mid;
        const timestamp = event.timestamp || Date.now();

        if (!senderId || !messageText) continue;

        console.log(`${LOG} IG incoming from IGSID ${senderId} on account ${igBusinessId}: ${messageText.slice(0, 80)}`);

        // Find which org owns this Instagram business account
        const owner = await findOrgByIntegration("instagram.igBusinessId", igBusinessId);
        if (!owner) {
          console.warn(`${LOG} No org found for Instagram account ${igBusinessId}`);
          continue;
        }

        // Try to match sender to a customer
        const customer = await matchCustomer(owner.orgId, "instagramId", senderId);

        await db.collection("messages").add({
          userId: owner.uid,
          orgId: owner.orgId,
          customerId: customer?.customerId || "",
          customerName: customer?.customerName || senderId,
          from: senderId,
          to: "inbound",
          body: messageText,
          type: "instagram",
          platform: "instagram",
          direction: "inbound",
          status: "received",
          platformMessageId: messageId || "",
          sentAt: timestamp,
        });

        console.log(`${LOG} IG message stored for org ${owner.orgId}`);
      }
    }
  } catch (err) {
    console.error(`${LOG} Instagram incoming error:`, err);
  }
}

/** POST /send/instagram — Send a message via Instagram DMs (auth required) */
router.post("/send/instagram", async (req, res) => {
  try {
    const { to, body, customerId, customerName } = req.body;
    if (!to) return res.status(400).json({ error: "Recipient IGSID (to) is required" });
    if (!body) return res.status(400).json({ error: "Message body is required" });

    const userDoc = await db.collection("users").doc(req.uid).get();
    const user = userDoc.exists ? userDoc.data() : {};

    const accessToken = getAccessToken(user, "instagram");
    const igBusinessId = getPlatformId(user, "instagram");
    if (!accessToken || !igBusinessId) {
      return res.status(400).json({ error: "Instagram not connected. Connect in Settings." });
    }

    // Send via Graph API (Instagram uses the same messages endpoint pattern)
    const graphRes = await fetch(`${GRAPH_API_BASE}/${igBusinessId}/messages?access_token=${accessToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: to },
        message: { text: body },
      }),
    });

    const graphData = await graphRes.json();
    if (graphData.error) {
      console.error(`${LOG} IG send error:`, graphData.error);
      return res.status(502).json({ error: graphData.error.message || "Instagram API error" });
    }

    const msgRecord = {
      userId: req.uid,
      orgId: req.orgId,
      customerId: customerId || "",
      customerName: customerName || "",
      from: igBusinessId,
      to,
      body,
      type: "instagram",
      platform: "instagram",
      direction: "outbound",
      status: "sent",
      platformMessageId: graphData.message_id || "",
      sentAt: Date.now(),
    };

    const docRef = await db.collection("messages").add(msgRecord);
    console.log(`${LOG} IG message sent to ${to}, doc ${docRef.id}`);
    res.json({ success: true, id: docRef.id, messageId: graphData.message_id });
  } catch (err) {
    console.error(`${LOG} IG send error:`, err);
    res.status(500).json({ error: err.message || "Failed to send Instagram message" });
  }
});

// ─────────────────────────────────────────────────
// WhatsApp Business
// ─────────────────────────────────────────────────

/** GET /webhook/whatsapp — Meta verification handshake for WhatsApp */
async function whatsappVerifyWebhook(req, res) {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.WA_VERIFY_TOKEN) {
      console.log(`${LOG} WhatsApp webhook verified`);
      return res.status(200).send(challenge);
    }
    console.warn(`${LOG} WhatsApp webhook verification failed — token mismatch`);
    return res.sendStatus(403);
  } catch (err) {
    console.error(`${LOG} WhatsApp verify error:`, err);
    return res.sendStatus(500);
  }
}

/** POST /webhook/whatsapp — Receive WhatsApp Cloud API messages */
async function whatsappIncomingHandler(req, res) {
  try {
    res.sendStatus(200);

    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;
        const messages = value.messages || [];

        for (const msg of messages) {
          const senderPhone = msg.from; // E.164 phone number without +
          const messageId = msg.id;
          const timestamp = msg.timestamp ? parseInt(msg.timestamp, 10) * 1000 : Date.now();
          const msgType = msg.type || "text";

          // Extract text content — support text and other types gracefully
          let messageText = "";
          if (msgType === "text") {
            messageText = msg.text?.body || "";
          } else if (msgType === "image" || msgType === "video" || msgType === "audio" || msgType === "document") {
            messageText = msg[msgType]?.caption || `[${msgType}]`;
          } else if (msgType === "location") {
            messageText = `[Location: ${msg.location?.latitude}, ${msg.location?.longitude}]`;
          } else if (msgType === "contacts") {
            messageText = `[Contact shared]`;
          } else if (msgType === "reaction") {
            messageText = msg.reaction?.emoji || "[reaction]";
          } else {
            messageText = `[${msgType}]`;
          }

          if (!senderPhone) continue;

          console.log(`${LOG} WA incoming from ${senderPhone} on ${phoneNumberId}: ${messageText.slice(0, 80)}`);

          // Find which org owns this WhatsApp phone number ID
          const owner = await findOrgByIntegration("whatsapp.phoneNumberId", phoneNumberId);
          if (!owner) {
            console.warn(`${LOG} No org found for WhatsApp phone number ID ${phoneNumberId}`);
            continue;
          }

          // Match customer by phone number (same digit-comparison logic as Telnyx)
          const customer = await matchCustomer(owner.orgId, "phone", senderPhone, "phone");

          await db.collection("messages").add({
            userId: owner.uid,
            orgId: owner.orgId,
            customerId: customer?.customerId || "",
            customerName: customer?.customerName || senderPhone,
            from: senderPhone,
            to: "inbound",
            body: messageText,
            type: "whatsapp",
            platform: "whatsapp",
            direction: "inbound",
            status: "received",
            platformMessageId: messageId || "",
            whatsappMessageType: msgType,
            sentAt: timestamp,
          });

          console.log(`${LOG} WA message stored for org ${owner.orgId}`);
        }
      }
    }
  } catch (err) {
    console.error(`${LOG} WhatsApp incoming error:`, err);
  }
}

/** POST /send/whatsapp — Send a message via WhatsApp Cloud API (auth required) */
router.post("/send/whatsapp", async (req, res) => {
  try {
    const { to, body, customerId, customerName } = req.body;
    if (!to) return res.status(400).json({ error: "Recipient phone number (to) is required" });
    if (!body) return res.status(400).json({ error: "Message body is required" });

    const userDoc = await db.collection("users").doc(req.uid).get();
    const user = userDoc.exists ? userDoc.data() : {};

    const accessToken = getAccessToken(user, "whatsapp");
    const phoneNumberId = getPlatformId(user, "whatsapp");
    if (!accessToken || !phoneNumberId) {
      return res.status(400).json({ error: "WhatsApp Business not connected. Connect in Settings." });
    }

    // Send via WhatsApp Cloud API
    const graphRes = await fetch(`${GRAPH_API_BASE}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body },
      }),
    });

    const graphData = await graphRes.json();
    if (graphData.error) {
      console.error(`${LOG} WA send error:`, graphData.error);
      return res.status(502).json({ error: graphData.error.message || "WhatsApp API error" });
    }

    const waMessageId = graphData.messages?.[0]?.id || "";
    const msgRecord = {
      userId: req.uid,
      orgId: req.orgId,
      customerId: customerId || "",
      customerName: customerName || "",
      from: phoneNumberId,
      to,
      body,
      type: "whatsapp",
      platform: "whatsapp",
      direction: "outbound",
      status: "sent",
      platformMessageId: waMessageId,
      sentAt: Date.now(),
    };

    const docRef = await db.collection("messages").add(msgRecord);
    console.log(`${LOG} WA message sent to ${to}, doc ${docRef.id}`);
    res.json({ success: true, id: docRef.id, messageId: waMessageId });
  } catch (err) {
    console.error(`${LOG} WA send error:`, err);
    res.status(500).json({ error: err.message || "Failed to send WhatsApp message" });
  }
});

// ─────────────────────────────────────────────────
// Connection Status
// ─────────────────────────────────────────────────

/** GET /status — Which social platforms are connected for the current user */
router.get("/status", async (req, res) => {
  try {
    const userDoc = await db.collection("users").doc(req.uid).get();
    const user = userDoc.exists ? userDoc.data() : {};
    const integrations = user.integrations || {};

    const platforms = {
      facebook: {
        connected: !!(integrations.facebook?.accessToken && integrations.facebook?.pageId),
        pageId: integrations.facebook?.pageId || null,
        pageName: integrations.facebook?.pageName || null,
      },
      instagram: {
        connected: !!(integrations.instagram?.accessToken && integrations.instagram?.igBusinessId),
        igBusinessId: integrations.instagram?.igBusinessId || null,
        accountName: integrations.instagram?.accountName || null,
      },
      whatsapp: {
        connected: !!(integrations.whatsapp?.accessToken && integrations.whatsapp?.phoneNumberId),
        phoneNumberId: integrations.whatsapp?.phoneNumberId || null,
        displayPhone: integrations.whatsapp?.displayPhone || null,
      },
    };

    res.json({ platforms });
  } catch (err) {
    console.error(`${LOG} Status error:`, err);
    res.status(500).json({ error: err.message || "Failed to fetch social status" });
  }
});

// ─────────────────────────────────────────────────
// Connect / Disconnect
// ─────────────────────────────────────────────────

/** POST /connect/facebook — Store Facebook Page access token and page ID */
router.post("/connect/facebook", async (req, res) => {
  try {
    const { pageId, pageName, accessToken } = req.body;
    if (!pageId || !accessToken) {
      return res.status(400).json({ error: "pageId and accessToken are required" });
    }

    await db.collection("users").doc(req.uid).set({
      integrations: {
        facebook: {
          pageId,
          pageName: pageName || "",
          accessToken,
          connectedAt: Date.now(),
        },
      },
    }, { merge: true });

    console.log(`${LOG} Facebook connected for user ${req.uid}, page ${pageId}`);
    res.json({ success: true, pageId });
  } catch (err) {
    console.error(`${LOG} Facebook connect error:`, err);
    res.status(500).json({ error: err.message || "Failed to connect Facebook" });
  }
});

/** POST /connect/instagram — Store Instagram business account ID and token */
router.post("/connect/instagram", async (req, res) => {
  try {
    const { igBusinessId, accountName, accessToken } = req.body;
    if (!igBusinessId || !accessToken) {
      return res.status(400).json({ error: "igBusinessId and accessToken are required" });
    }

    await db.collection("users").doc(req.uid).set({
      integrations: {
        instagram: {
          igBusinessId,
          accountName: accountName || "",
          accessToken,
          connectedAt: Date.now(),
        },
      },
    }, { merge: true });

    console.log(`${LOG} Instagram connected for user ${req.uid}, account ${igBusinessId}`);
    res.json({ success: true, igBusinessId });
  } catch (err) {
    console.error(`${LOG} Instagram connect error:`, err);
    res.status(500).json({ error: err.message || "Failed to connect Instagram" });
  }
});

/** POST /connect/whatsapp — Store WhatsApp Business phone number ID and token */
router.post("/connect/whatsapp", async (req, res) => {
  try {
    const { phoneNumberId, displayPhone, accessToken } = req.body;
    if (!phoneNumberId || !accessToken) {
      return res.status(400).json({ error: "phoneNumberId and accessToken are required" });
    }

    await db.collection("users").doc(req.uid).set({
      integrations: {
        whatsapp: {
          phoneNumberId,
          displayPhone: displayPhone || "",
          accessToken,
          connectedAt: Date.now(),
        },
      },
    }, { merge: true });

    console.log(`${LOG} WhatsApp connected for user ${req.uid}, phone ${phoneNumberId}`);
    res.json({ success: true, phoneNumberId });
  } catch (err) {
    console.error(`${LOG} WhatsApp connect error:`, err);
    res.status(500).json({ error: err.message || "Failed to connect WhatsApp" });
  }
});

/** POST /disconnect/:platform — Remove a social integration */
router.post("/disconnect/:platform", async (req, res) => {
  try {
    const platform = req.params.platform;
    const validPlatforms = ["facebook", "instagram", "whatsapp"];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({ error: `Invalid platform: ${platform}. Must be one of: ${validPlatforms.join(", ")}` });
    }

    await db.collection("users").doc(req.uid).update({
      [`integrations.${platform}`]: FieldValue.delete(),
    });

    console.log(`${LOG} ${platform} disconnected for user ${req.uid}`);
    res.json({ success: true, platform });
  } catch (err) {
    console.error(`${LOG} Disconnect error for ${req.params.platform}:`, err);
    res.status(500).json({ error: err.message || "Failed to disconnect platform" });
  }
});

// ─────────────────────────────────────────────────
// Register webhook routes on the router (these are also exported standalone)
// ─────────────────────────────────────────────────

router.get("/webhook/facebook", facebookVerifyWebhook);
router.post("/webhook/facebook", facebookIncomingHandler);
router.get("/webhook/instagram", instagramVerifyWebhook);
router.post("/webhook/instagram", instagramIncomingHandler);
router.get("/webhook/whatsapp", whatsappVerifyWebhook);
router.post("/webhook/whatsapp", whatsappIncomingHandler);

// ─────────────────────────────────────────────────
// Exports — router + individual handlers (Telnyx pattern)
// ─────────────────────────────────────────────────

module.exports = {
  router,
  // Individual webhook handlers for mounting outside the auth middleware
  facebookVerifyWebhook,
  facebookIncomingHandler,
  instagramVerifyWebhook,
  instagramIncomingHandler,
  whatsappVerifyWebhook,
  whatsappIncomingHandler,
};
