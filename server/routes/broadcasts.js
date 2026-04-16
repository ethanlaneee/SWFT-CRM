const router = require("express").Router();
const { db } = require("../firebase");
const { sendBroadcastEmail, isConfigured, generateUnsubToken, verifyUnsubToken } = require("../utils/broadcastEmail");
const { isSuppressed } = require("./sesWebhook");
const { resolveTemplate } = require("../utils/templates");

/**
 * POST /api/broadcasts — create and send a broadcast to multiple customers
 *
 * Body:
 *   channel: "email"
 *   subject: string
 *   message: string (template with {firstName}, {customerName}, etc.)
 *   recipientFilter: "all" | "tagged"
 *   tags: string[] (when recipientFilter === "tagged")
 */
router.post("/", async (req, res, next) => {
  try {
    const { subject, message, recipientFilter, tags } = req.body;
    const channel = "email";
    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }
    if (!subject) {
      return res.status(400).json({ error: "subject is required for email broadcasts" });
    }

    if (!isConfigured()) {
      return res.status(400).json({ error: "Broadcasting is not configured. Contact support." });
    }

    // Fetch org user for sending
    const userDoc = await db.collection("users").doc(req.uid).get();
    if (!userDoc.exists) return res.status(400).json({ error: "User not found" });
    const orgUser = userDoc.data();
    orgUser._uid = req.uid;

    // Fetch customers
    const custSnap = await db.collection("customers").where("orgId", "==", req.orgId).get();
    let customers = custSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Filter by tags if needed
    if (recipientFilter === "tagged" && Array.isArray(tags) && tags.length > 0) {
      const tagSet = new Set(tags.map(t => t.toLowerCase()));
      customers = customers.filter(c => {
        const custTags = (c.tags || []).map(t => t.toLowerCase());
        return custTags.some(t => tagSet.has(t));
      });
    }

    // Filter to those with valid email
    customers = customers.filter(c => c.email);

    if (customers.length === 0) {
      return res.status(400).json({ error: "No customers match the selected criteria" });
    }

    const senderName = orgUser.name || "";
    const senderFirstName = senderName.split(" ")[0] || "";
    const companyName = orgUser.company || orgUser.name || "SWFT";

    // Use the org's verified custom domain if set up, otherwise fall back to shared sender
    const customFromEmail = (orgUser.sendingDomain && orgUser.sendingDomainVerified)
      ? `${orgUser.sendingDomainLocalPart || "broadcasts"}@${orgUser.sendingDomain}`
      : null;

    // Create the broadcast record
    const broadcastData = {
      orgId: req.orgId,
      userId: req.uid,
      channel,
      subject: subject || "",
      message,
      recipientFilter: recipientFilter || "all",
      tags: tags || [],
      totalRecipients: customers.length,
      sentCount: 0,
      failedCount: 0,
      status: "sending",
      createdAt: Date.now(),
    };
    const broadcastRef = await db.collection("broadcasts").add(broadcastData);

    // Send immediately in background, respond fast
    res.json({
      id: broadcastRef.id,
      totalRecipients: customers.length,
      status: "sending",
    });

    // Process sends in background
    let sentCount = 0;
    let failedCount = 0;

    for (const cust of customers) {
      try {
        // Check if customer has unsubscribed
        const unsubSnap = await db.collection("unsubscribes")
          .where("orgId", "==", req.orgId)
          .where("email", "==", cust.email)
          .limit(1)
          .get();
        if (!unsubSnap.empty) {
          console.log(`[broadcast] Skipping unsubscribed recipient: ${cust.email}`);
          continue;
        }

        // Check global SES suppression list (bounces + complaints)
        if (await isSuppressed(cust.email)) {
          console.log(`[broadcast] Skipping suppressed recipient: ${cust.email}`);
          failedCount++;
          continue;
        }

        const vars = {
          customer_name: cust.name || "",
          customerName: cust.name || "",
          firstName: (cust.name || "").split(" ")[0] || "",
          customerFirstName: (cust.name || "").split(" ")[0] || "",
          customerFullName: cust.name || "",
          company_name: companyName,
          companyName: companyName,
          your_name: senderName,
          yourName: senderName,
          your_first_name: senderFirstName,
          yourFirstName: senderFirstName,
          senderName: senderName,
          service: cust.service || "",
          total: "",
          address: cust.address || "",
        };

        const resolvedMessage = resolveTemplate(message, vars);
        const resolvedSubject = subject ? resolveTemplate(subject, vars) : "";

        const unsubToken = generateUnsubToken(cust.email);
        const unsubscribeUrl = `https://goswft.com/api/broadcasts/unsubscribe?token=${encodeURIComponent(unsubToken)}&org=${encodeURIComponent(req.orgId)}`;

        await sendBroadcastEmail(cust.email, resolvedSubject, resolvedMessage, {
          companyName,
          companyAddress: orgUser.address || "",
          companyPhone: orgUser.phone || "",
          companyEmail: orgUser.email || "",
          fromName: companyName,
          fromEmail: customFromEmail,
          replyTo: orgUser.gmailAddress || orgUser.email,
          unsubscribeUrl,
        });

        // Record in messages collection
        await db.collection("messages").add({
          userId: req.uid,
          orgId: req.orgId,
          to: cust.email,
          subject: resolvedSubject,
          body: resolvedMessage,
          customerId: cust.id,
          customerName: cust.name || "",
          type: "email",
          status: "sent",
          sentVia: "swft",
          broadcastId: broadcastRef.id,
          sentAt: Date.now(),
        });

        sentCount++;
      } catch (err) {
        console.error(`[broadcast] Failed to send to ${cust.name || cust.id}:`, err.message);
        failedCount++;
      }

      // Small delay between sends to avoid rate limits
      await new Promise(r => setTimeout(r, 500));
    }

    // Update broadcast record with final counts
    await broadcastRef.update({
      sentCount,
      failedCount,
      status: failedCount === customers.length ? "failed" : "sent",
      completedAt: Date.now(),
    });

    console.log(`[broadcast] ${broadcastRef.id} complete: ${sentCount} sent, ${failedCount} failed of ${customers.length}`);
  } catch (err) {
    console.error("[broadcast] Error:", err.message);
    next(err);
  }
});

// GET /api/broadcasts — list past broadcasts
router.get("/", async (req, res, next) => {
  try {
    const snap = await db.collection("broadcasts").where("orgId", "==", req.orgId).get();
    let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    results = results.slice(0, 50);
    res.json(results);
  } catch (err) { next(err); }
});

// GET /api/broadcasts/:id — get single broadcast
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await db.collection("broadcasts").doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Broadcast not found" });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) { next(err); }
});

/**
 * Public unsubscribe handler — mounted separately in index.js BEFORE
 * auth middleware so it's accessible without authentication.
 *
 * GET /api/broadcasts/unsubscribe?token=...&org=...
 */
async function unsubscribeHandler(req, res) {
  const { token, org } = req.query;

  if (!token || !org) {
    return res.status(400).send("Invalid unsubscribe link.");
  }

  const email = verifyUnsubToken(token);
  if (!email) {
    return res.status(400).send("Invalid or expired unsubscribe link.");
  }

  try {
    // Check if already unsubscribed to avoid duplicates
    const existing = await db.collection("unsubscribes")
      .where("orgId", "==", org)
      .where("email", "==", email)
      .limit(1)
      .get();

    if (existing.empty) {
      await db.collection("unsubscribes").add({
        orgId: org,
        email,
        unsubscribedAt: Date.now(),
      });
    }

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Unsubscribed - SWFT</title>
<style>
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    background: #0a0a0a;
    color: #f0f0f0;
  }
  .container {
    text-align: center;
    max-width: 440px;
    padding: 48px 32px;
  }
  .check {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: rgba(200, 241, 53, 0.12);
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 20px;
    font-size: 26px;
    color: #c8f135;
  }
  h2 {
    margin: 0 0 10px;
    font-size: 22px;
    font-weight: 600;
    color: #f0f0f0;
  }
  p {
    color: #7a7a7a;
    font-size: 15px;
    line-height: 1.6;
    margin: 0;
  }
  .brand {
    margin-top: 32px;
    font-size: 12px;
    color: #444;
    letter-spacing: 2px;
    text-transform: uppercase;
  }
  .resub {
    display: inline-block;
    margin-top: 20px;
    padding: 10px 20px;
    background: transparent;
    border: 1px solid #333;
    border-radius: 8px;
    color: #c8f135;
    font-size: 14px;
    text-decoration: none;
    cursor: pointer;
    font-family: inherit;
  }
  .resub:hover { border-color: #c8f135; }
</style>
</head>
<body>
  <div class="container">
    <div class="check">&#10003;</div>
    <h2>You've been unsubscribed</h2>
    <p>You won't receive any more broadcast emails from this sender.</p>
    <a class="resub" href="/api/broadcasts/resubscribe?token=${encodeURIComponent(token)}&org=${encodeURIComponent(org)}">Unsubscribed by mistake? Resubscribe</a>
    <div class="brand">SWFT</div>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error("[broadcast-unsubscribe] Error:", err.message);
    res.status(500).send("Something went wrong. Please try again or contact support.");
  }
}

/**
 * Public resubscribe handler — pairs with the unsubscribe flow.
 *
 * GET /api/broadcasts/resubscribe?token=...&org=...
 */
async function resubscribeHandler(req, res) {
  const { token, org } = req.query;

  if (!token || !org) {
    return res.status(400).send("Invalid link.");
  }

  const email = verifyUnsubToken(token);
  if (!email) {
    return res.status(400).send("Invalid or expired link.");
  }

  try {
    const existing = await db.collection("unsubscribes")
      .where("orgId", "==", org)
      .where("email", "==", email)
      .get();

    for (const doc of existing.docs) await doc.ref.delete();

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Resubscribed - SWFT</title>
<style>
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    background: #0a0a0a;
    color: #f0f0f0;
  }
  .container {
    text-align: center;
    max-width: 440px;
    padding: 48px 32px;
  }
  .check {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: rgba(200, 241, 53, 0.12);
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 20px;
    font-size: 26px;
    color: #c8f135;
  }
  h2 {
    margin: 0 0 10px;
    font-size: 22px;
    font-weight: 600;
    color: #f0f0f0;
  }
  p {
    color: #7a7a7a;
    font-size: 15px;
    line-height: 1.6;
    margin: 0;
  }
  .brand {
    margin-top: 32px;
    font-size: 12px;
    color: #444;
    letter-spacing: 2px;
    text-transform: uppercase;
  }
  .resub {
    display: inline-block;
    margin-top: 20px;
    padding: 10px 20px;
    background: transparent;
    border: 1px solid #333;
    border-radius: 8px;
    color: #7a7a7a;
    font-size: 14px;
    text-decoration: none;
    cursor: pointer;
    font-family: inherit;
  }
  .resub:hover { border-color: #7a7a7a; color: #f0f0f0; }
</style>
</head>
<body>
  <div class="container">
    <div class="check">&#10003;</div>
    <h2>You're resubscribed</h2>
    <p>Welcome back — you'll continue receiving broadcast emails from this sender.</p>
    <a class="resub" href="/api/broadcasts/unsubscribe?token=${encodeURIComponent(token)}&org=${encodeURIComponent(org)}">Change your mind? Unsubscribe</a>
    <div class="brand">SWFT</div>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error("[broadcast-resubscribe] Error:", err.message);
    res.status(500).send("Something went wrong. Please try again or contact support.");
  }
}

module.exports = router;
module.exports.unsubscribeHandler = unsubscribeHandler;
module.exports.resubscribeHandler = resubscribeHandler;
