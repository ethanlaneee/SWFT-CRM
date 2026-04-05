/**
 * Public survey endpoints — no auth required.
 * Customers access these via a unique token link.
 */
const router = require("express").Router();
const { db } = require("../firebase");
const { sendSms } = require("../twilio");

/**
 * Resolve template variables.
 */
function resolveTemplate(template, vars) {
  let msg = template || "";
  for (const [key, val] of Object.entries(vars)) {
    msg = msg.replace(new RegExp(`{{${key}}}`, "g"), val || "");
  }
  return msg;
}

/**
 * Send email using org user's configured sender.
 * Falls back to Postmark when Gmail tokens are absent.
 */
async function sendFollowUpEmail(orgUser, to, subject, body) {
  const fromName = orgUser.company || orgUser.name || "SWFT";
  const fromEmail = orgUser.email || "noreply@swft-crm.com";

  if (orgUser.gmailConnected && orgUser.gmailTokens) {
    const { google } = require("googleapis");
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || "https://goswft.com/api/auth/google/callback"
    );
    oauth2Client.setCredentials(orgUser.gmailTokens);
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const boundary = "swft_survey_" + Date.now();
    let mime = "";
    mime += `From: ${fromName} <${orgUser.gmailAddress || fromEmail}>\r\n`;
    mime += `To: ${to}\r\n`;
    mime += `Subject: ${subject}\r\n`;
    mime += `MIME-Version: 1.0\r\n`;
    mime += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`;
    mime += `--${boundary}\r\n`;
    mime += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
    mime += body + "\r\n\r\n";
    mime += `--${boundary}\r\n`;
    mime += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
    mime += `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;white-space:pre-wrap;">${body}</div>\r\n\r\n`;
    mime += `--${boundary}--`;

    const encoded = Buffer.from(mime)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await gmail.users.messages.send({ userId: "me", requestBody: { raw: encoded } });
    return;
  }

  // Gmail not connected — skip email
  console.warn("Survey follow-up email skipped: Gmail not connected for org", orgUser.email || "unknown");
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
              await sendSms(msg.phone, followUpMessage);
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
