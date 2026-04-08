/**
 * Public survey endpoints — no auth required.
 * Customers access these via a unique token link.
 */
const router = require("express").Router();
const { db } = require("../firebase");
const { sendSms, getUserTelnyxConfig } = require("../telnyx");
const { sendSimpleGmail } = require("../utils/email");
const { resolveTemplate } = require("../utils/templates");

/**
 * Send follow-up email via Gmail.
 */
async function sendFollowUpEmail(orgUser, to, subject, body) {
  if (!orgUser.gmailConnected || !orgUser.gmailTokens) {
    console.warn("Survey follow-up email skipped: Gmail not connected for org");
    return;
  }
  const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;white-space:pre-wrap;">${body}</div>`;
  await sendSimpleGmail(orgUser, to, subject, body, htmlBody);
}

// GET /api/survey/:token — return survey metadata (customer name, company name)
router.get("/:token", async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ error: "Token required" });

    const snap = await db
      .collection("scheduledMessages")
      .where("surveyToken", "==", token)
      .limit(1)
      .get();

    if (snap.empty) return res.status(404).json({ error: "Survey not found" });

    const msg = snap.docs[0].data();

    // Fetch company name from org user
    let companyName = "";
    try {
      const usersSnap = await db
        .collection("users")
        .where("orgId", "==", msg.orgId)
        .where("role", "==", "owner")
        .limit(1)
        .get();
      if (!usersSnap.empty) {
        companyName = usersSnap.docs[0].data().company || usersSnap.docs[0].data().name || "";
      } else {
        const ownerDoc = await db.collection("users").doc(msg.orgId).get();
        if (ownerDoc.exists) {
          companyName = ownerDoc.data().company || ownerDoc.data().name || "";
        }
      }
    } catch (_) {}

    res.json({
      customerName: msg.customerName || "",
      companyName,
      alreadyCompleted: !!msg.surveyCompletedAt,
    });
  } catch (err) {
    console.error("Survey GET error:", err);
    res.status(500).json({ error: "Failed to load survey" });
  }
});

// POST /api/survey/:token — submit a rating (1–10)
router.post("/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { rating } = req.body;

    if (!token) return res.status(400).json({ error: "Token required" });
    if (typeof rating !== "number" || rating < 1 || rating > 10) {
      return res.status(400).json({ error: "Rating must be a number between 1 and 10" });
    }

    // Find the scheduled message by survey token
    const snap = await db
      .collection("scheduledMessages")
      .where("surveyToken", "==", token)
      .limit(1)
      .get();

    if (snap.empty) return res.status(404).json({ error: "Survey not found" });

    const msgDoc = snap.docs[0];
    const msg = msgDoc.data();

    if (msg.surveyCompletedAt) {
      return res.status(409).json({ error: "Survey already completed" });
    }

    const now = Date.now();
    await msgDoc.ref.update({
      surveyRating: rating,
      surveyCompletedAt: now,
    });

    // Determine whether to send a follow-up
    let showReviewRequest = false;
    let reviewUrl = null;

    if (msg.automationId) {
      let rule = null;
      try {
        const ruleDoc = await db.collection("automations").doc(msg.automationId).get();
        if (ruleDoc.exists) rule = ruleDoc.data();
      } catch (_) {}

      if (
        rule &&
        rule.followUpTemplate &&
        typeof rule.surveyThreshold === "number" &&
        rating >= rule.surveyThreshold
      ) {
        // Get org user for sending + GBP review URL
        let orgUser = {};
        try {
          const usersSnap = await db
            .collection("users")
            .where("orgId", "==", msg.orgId)
            .where("role", "==", "owner")
            .limit(1)
            .get();
          if (!usersSnap.empty) {
            orgUser = usersSnap.docs[0].data();
          } else {
            const ownerDoc = await db.collection("users").doc(msg.orgId).get();
            if (ownerDoc.exists) orgUser = ownerDoc.data();
          }
        } catch (_) {}

        reviewUrl =
          (orgUser.integrations &&
            orgUser.integrations.google_business &&
            orgUser.integrations.google_business.reviewUrl) ||
          null;

        const followUpMessage = resolveTemplate(rule.followUpTemplate, {
          customer_name: msg.customerName || "",
          company_name: orgUser.company || orgUser.name || "",
          review_link: reviewUrl || "",
        });

        const followUpType = rule.followUpType || "sms";

        try {
          if (followUpType === "sms") {
            if (msg.phone) {
              await sendSms(msg.phone, followUpMessage, getUserTelnyxConfig(orgUser));
            }
          } else {
            if (msg.email) {
              const companyName = orgUser.company || orgUser.name || "SWFT";
              await sendFollowUpEmail(
                orgUser,
                msg.email,
                `Thank you from ${companyName}`,
                followUpMessage
              );
            }
          }

          await msgDoc.ref.update({ followUpSent: true });
          showReviewRequest = true;
        } catch (sendErr) {
          console.error("Follow-up send error:", sendErr);
          // Still mark survey done, just log the follow-up failure
        }
      }
    }

    res.json({
      success: true,
      showReviewRequest,
      reviewUrl,
    });
  } catch (err) {
    console.error("Survey POST error:", err);
    res.status(500).json({ error: "Failed to submit survey" });
  }
});

module.exports = router;
