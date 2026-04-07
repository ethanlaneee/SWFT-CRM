const router = require("express").Router();
const { db } = require("../firebase");
const { sendSimpleGmail } = require("../utils/email");
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

    // Fetch org user for sending
    const userDoc = await db.collection("users").doc(req.uid).get();
    if (!userDoc.exists) return res.status(400).json({ error: "User not found" });
    const orgUser = userDoc.data();
    orgUser._uid = req.uid;

    if (channel === "email" && (!orgUser.gmailConnected || !orgUser.gmailTokens)) {
      return res.status(400).json({ error: "Gmail not connected. Connect Gmail in Settings first." });
    }

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
        const vars = {
          customer_name: cust.name || "",
          customerName: cust.name || "",
          firstName: (cust.name || "").split(" ")[0] || "",
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

        const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;white-space:pre-wrap;">${resolvedMessage}</div>`;
        await sendSimpleGmail(orgUser, cust.email, resolvedSubject, resolvedMessage, htmlBody);

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
          sentVia: "gmail",
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

module.exports = router;
