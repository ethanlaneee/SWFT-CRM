/**
 * SWFT — Meta (Facebook + Instagram) Routes
 *
 * GET  /api/meta/status          — connection status for this user
 * GET  /api/meta/connect         — redirect to Facebook OAuth
 * GET  /api/meta/callback        — OAuth callback, store tokens, subscribe webhook
 * GET  /api/meta/pages           — list pages after OAuth (for multi-page selection)
 * POST /api/meta/select-page     — finalise connection with a chosen page
 * POST /api/meta/disconnect      — unsubscribe webhook + clear tokens
 * POST /api/meta/send            — send a FB Messenger or IG DM reply
 *
 * GET  /api/webhooks/meta        — Meta webhook verification (no auth)
 * POST /api/webhooks/meta        — Incoming FB/IG messages (no auth, verified by hub)
 */

const router = require("express").Router();
const { db } = require("../firebase");
const meta = require("../meta");
const { handleInboundMeta } = require("../ai/auto-reply");
const { notifyInboundMessage } = require("../utils/notifications");

const col = () => db.collection("users");

// ── Helper: find SWFT user by Facebook page ID ──────────────────────────────
async function findUserByPageId(pageId) {
  const snap = await db.collection("users")
    .where("facebookPageId", "==", pageId)
    .limit(1).get();
  if (!snap.empty) return { uid: snap.docs[0].id, ...snap.docs[0].data() };
  return null;
}

// ── Helper: find SWFT user by Instagram user ID ──────────────────────────────
async function findUserByIgId(igUserId) {
  const snap = await db.collection("users")
    .where("instagramUserId", "==", igUserId)
    .limit(1).get();
  if (!snap.empty) return { uid: snap.docs[0].id, ...snap.docs[0].data() };
  return null;
}

// GET /api/meta/status
router.get("/status", async (req, res, next) => {
  try {
    const doc = await col().doc(req.uid).get();
    const d = doc.exists ? doc.data() : {};
    res.json({
      configured: meta.isConfigured(),
      facebook: d.facebookPageId ? {
        connected: true,
        pageName: d.facebookPageName || "",
        pageId: d.facebookPageId,
      } : { connected: false },
      instagram: d.instagramUserId ? {
        connected: true,
        username: d.instagramUsername || "",
        userId: d.instagramUserId,
      } : { connected: false },
    });
  } catch (err) { next(err); }
});

// GET /api/meta/connect — kick off Facebook OAuth
router.get("/connect", (req, res) => {
  if (!meta.isConfigured()) {
    return res.status(503).json({ error: "Meta app not configured. Contact SWFT support." });
  }
  const state = Buffer.from(JSON.stringify({ uid: req.uid })).toString("base64url");
  res.json({ url: meta.getOAuthUrl(state) });
});

// GET /api/meta/callback — Facebook OAuth callback (no auth middleware — FB redirects here)
// Note: registered on the raw express app in index.js without the auth middleware
router.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.redirect(`/swft-connect?error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return res.redirect("/swft-connect?error=missing_code");
  }

  let uid, integration;
  try {
    const decoded = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    uid = decoded.uid;
    integration = decoded.integration || "facebook";
  } catch {
    return res.redirect("/swft-connect?error=invalid_state");
  }

  try {
    // Exchange code → short-lived token → long-lived token
    const shortToken = await meta.exchangeCodeForToken(code);
    const longToken = await meta.getLongLivedToken(shortToken);

    // ── Meta Lead Ads flow ──
    if (integration === "meta_lead_ads") {
      const pages = await meta.getUserPages(longToken);
      if (!pages.length) {
        return res.redirect("/swft-connect?error=no_pages_found_for_lead_ads");
      }
      // Store all pages for lead ads (subscribe webhooks for leadgen events)
      const leadPages = pages.map(p => ({
        id: p.id,
        name: p.name,
        accessToken: p.access_token,
      }));
      await db.collection("users").doc(uid).set({
        metaLeadAdsConnected: true,
        metaLeadAdsPages: leadPages,
        metaLeadAdsUserToken: longToken,
        metaLeadAdsConnectedAt: Date.now(),
      }, { merge: true });
      // Subscribe each page to leadgen webhooks
      for (const page of pages) {
        try {
          await meta.subscribePageWebhook(page.id, page.access_token);
        } catch (_) { /* non-fatal */ }
      }
      return res.redirect("/swft-connect?connected=meta_lead_ads");
    }

    // ── Facebook / Instagram / WhatsApp flow ──
    const pages = await meta.getUserPages(longToken);
    if (!pages.length) {
      return res.redirect("/swft-connect?error=no_facebook_pages_select_a_page_during_login_or_create_one_at_facebook.com");
    }

    // Store temp data for page selection
    await db.collection("metaConnectTemp").doc(uid).set({
      userAccessToken: longToken,
      pages: pages.map(p => ({
        id: p.id,
        name: p.name,
        accessToken: p.access_token,
        igUserId: p.instagram_business_account?.id || null,
      })),
      createdAt: Date.now(),
    });

    // Auto-select if only one page
    if (pages.length === 1) {
      await connectPage(uid, {
        id: pages[0].id,
        name: pages[0].name,
        accessToken: pages[0].access_token,
        igUserId: pages[0].instagram_business_account?.id || null,
      });
      return res.redirect("/swft-connect?connected=facebook");
    }

    // Multiple pages — let user pick in Settings
    return res.redirect("/swft-settings?meta_select=1");
  } catch (err) {
    console.error("[meta] OAuth callback error:", err.message);
    return res.redirect(`/swft-connect?error=${encodeURIComponent(err.message)}`);
  }
});

// GET /api/meta/pages — fetch pages stored during OAuth for selection UI
router.get("/pages", async (req, res, next) => {
  try {
    const doc = await db.collection("metaConnectTemp").doc(req.uid).get();
    if (!doc.exists) return res.json({ pages: [] });
    const data = doc.data();
    // Clean up old temp docs (> 30 min)
    if (Date.now() - data.createdAt > 30 * 60 * 1000) {
      await doc.ref.delete();
      return res.json({ pages: [] });
    }
    res.json({ pages: data.pages });
  } catch (err) { next(err); }
});

// POST /api/meta/select-page — finalise connection with a chosen page
router.post("/select-page", async (req, res, next) => {
  try {
    const { pageId } = req.body;
    if (!pageId) return res.status(400).json({ error: "pageId required" });

    const tempDoc = await db.collection("metaConnectTemp").doc(req.uid).get();
    if (!tempDoc.exists) return res.status(400).json({ error: "No pending connection. Please reconnect." });

    const { pages } = tempDoc.data();
    const page = pages.find(p => p.id === pageId);
    if (!page) return res.status(404).json({ error: "Page not found" });

    await connectPage(req.uid, page);
    await tempDoc.ref.delete();

    res.json({ ok: true, pageName: page.name });
  } catch (err) { next(err); }
});

// Internal: finalise page connection (subscribe webhook, save to Firestore)
async function connectPage(uid, page) {
  // Subscribe the page to SWFT's webhook
  try {
    await meta.subscribePageWebhook(page.id, page.accessToken);
  } catch (err) {
    console.error(`[meta] Webhook subscription failed for page ${page.id}:`, err.message);
    // Don't block — webhook may already be subscribed
  }

  // Fetch IG username if connected
  let igUsername = null;
  if (page.igUserId) {
    try {
      const igRes = await fetch(`https://graph.facebook.com/v19.0/${page.igUserId}?fields=username&access_token=${page.accessToken}`);
      const igData = await igRes.json();
      igUsername = igData.username || null;
    } catch { /* ignore */ }
  }

  await db.collection("users").doc(uid).set({
    facebookPageId: page.id,
    facebookPageName: page.name,
    facebookPageAccessToken: page.accessToken,
    instagramUserId: page.igUserId || null,
    instagramUsername: igUsername,
    metaConnectedAt: Date.now(),
  }, { merge: true });

  console.log(`[meta] Connected page "${page.name}" (${page.id}) for user ${uid}${page.igUserId ? ` + IG ${page.igUserId}` : ""}`);
}

// POST /api/meta/disconnect
router.post("/disconnect", async (req, res, next) => {
  try {
    const doc = await col().doc(req.uid).get();
    const d = doc.exists ? doc.data() : {};

    if (d.facebookPageId && d.facebookPageAccessToken) {
      try {
        await meta.unsubscribePageWebhook(d.facebookPageId, d.facebookPageAccessToken);
      } catch (err) {
        console.error("[meta] Unsubscribe failed:", err.message);
      }
    }

    await col().doc(req.uid).set({
      facebookPageId: null,
      facebookPageName: null,
      facebookPageAccessToken: null,
      instagramUserId: null,
      instagramUsername: null,
      metaConnectedAt: null,
    }, { merge: true });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/meta/send — send a reply to a FB Messenger or IG DM thread
router.post("/send", async (req, res, next) => {
  try {
    const { recipientId, text, channel } = req.body; // channel: 'facebook' | 'instagram'
    if (!recipientId || !text) return res.status(400).json({ error: "recipientId and text required" });

    const doc = await col().doc(req.uid).get();
    const d = doc.exists ? doc.data() : {};

    if (!d.facebookPageAccessToken) {
      return res.status(400).json({ error: "Facebook not connected" });
    }

    let result;
    if (channel === "instagram" && d.instagramUserId) {
      result = await meta.sendInstagramMessage(
        d.facebookPageAccessToken, d.instagramUserId, recipientId, text
      );
    } else {
      result = await meta.sendFacebookMessage(d.facebookPageAccessToken, recipientId, text);
    }

    // Log to messages collection
    await db.collection("messages").add({
      userId: req.uid,
      orgId: req.orgId,
      to: recipientId,
      body: text,
      type: channel || "facebook",
      direction: "outbound",
      status: "sent",
      sentVia: channel || "facebook",
      metaMessageId: result.messageId,
      sentAt: Date.now(),
    });

    res.json({ ok: true, messageId: result.messageId });
  } catch (err) { next(err); }
});

// ── Webhook endpoints (no auth middleware) ───────────────────────────────────
// These are registered directly on the Express app in index.js

/**
 * GET /api/webhooks/meta — Meta webhook verification challenge
 */
function webhookVerify(req, res) {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === meta.cfg().verifyToken) {
    console.log("[meta] Webhook verified");
    return res.send(challenge);
  }
  res.sendStatus(403);
}

/**
 * POST /api/webhooks/meta — Incoming Facebook / Instagram messages
 */
async function webhookReceive(req, res) {
  // Acknowledge immediately
  res.sendStatus(200);

  const body = req.body;
  if (!body || (body.object !== "page" && body.object !== "instagram")) return;

  for (const entry of body.entry || []) {
    // Meta sends events in entry.messaging (Messenger Platform) OR
    // entry.changes[].value (some Instagram webhook subscriptions).
    // Normalise both into a single list of events.
    let events = entry.messaging || [];
    if (!events.length && Array.isArray(entry.changes)) {
      events = entry.changes
        .filter(c => c.field === "messages" && c.value)
        .map(c => c.value);
    }

    for (const event of events) {
      if (!event.message || event.message.is_echo) continue;

      const senderId = event.sender?.id;
      const recipientId = event.recipient?.id;
      const text = event.message?.text;
      if (!senderId || !text) continue;

      try {
        // ── Owner lookup with fallback ──────────────────────────────────────
        // Meta can deliver Instagram DMs with object="instagram" (recipientId = IG user ID)
        // or with object="page" (recipientId may still be the IG user ID, not the page ID).
        // Try the "natural" lookup first, then fall back to the other.
        let isInstagram = body.object === "instagram";
        let owner = isInstagram
          ? await findUserByIgId(recipientId)
          : await findUserByPageId(recipientId);

        if (!owner) {
          // Fallback: try the opposite lookup
          if (isInstagram) {
            owner = await findUserByPageId(recipientId);
          } else {
            owner = await findUserByIgId(recipientId);
            if (owner) isInstagram = true; // Instagram DM delivered via page webhook
          }
        }

        if (!owner) {
          console.log(`[meta] No SWFT user found for account ${recipientId} (object=${body.object})`);
          continue;
        }

        const channel = isInstagram ? "instagram" : "facebook";

        // Look up the sender's display name
        let senderName = null;
        try {
          senderName = isInstagram
            ? await meta.getInstagramUserName(senderId, owner.facebookPageAccessToken)
            : await meta.getFacebookUserName(senderId, owner.facebookPageAccessToken);
        } catch { /* non-fatal */ }

        // Find matching customer by name (best effort)
        let customerId = "";
        let customerName = senderName || senderId;
        if (senderName) {
          const custSnap = await db.collection("customers")
            .where("orgId", "==", owner.orgId || owner.uid)
            .where("name", "==", senderName)
            .limit(1).get();
          if (!custSnap.empty) {
            customerId = custSnap.docs[0].id;
            customerName = custSnap.docs[0].data().name;
          }
        }

        const orgId = owner.orgId || owner.uid;

        // Save to messages collection (unified inbox)
        await db.collection("messages").add({
          userId: owner.uid,
          orgId,
          from: senderId,
          to: recipientId,
          body: text,
          customerName,
          customerId,
          type: channel,
          direction: "inbound",
          sentVia: channel,
          metaSenderId: senderId,
          sentAt: Date.now(),
        });

        notifyInboundMessage({
          orgId,
          channel,
          from: customerName || senderId,
          body: text,
          customerId,
        });

        console.log(`[meta] ${channel} message from ${customerName} (${senderId}) → org ${orgId}`);

        // Auto-reply via AI unless thread is in manual mode
        const matched = customerId ? { customerId, customerName } : null;
        const metaSendFn = async (replyText) => {
          if (isInstagram) {
            await meta.sendInstagramMessage(owner.facebookPageAccessToken, owner.instagramUserId, senderId, replyText);
          } else {
            await meta.sendFacebookMessage(owner.facebookPageAccessToken, senderId, replyText);
          }
        };
        handleInboundMeta(orgId, owner.uid, owner, senderId, text, channel, matched, metaSendFn)
          .catch(err => console.error("[meta] auto-reply error:", err.message));
      } catch (err) {
        console.error("[meta] Error processing webhook message:", err.message);
      }
    }
  }
}

// Export the callback handler separately so it can be registered without auth middleware
async function oauthCallback(req, res) {
  // Delegate to the router's /callback handler by re-invoking it
  req.url = "/callback";
  router.handle(req, res, () => res.redirect("/swft-settings?meta_error=not_found"));
}

module.exports = { router, webhookVerify, webhookReceive, oauthCallback };
