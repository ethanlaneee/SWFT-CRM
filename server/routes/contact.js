const router = require("express").Router();
const {
  SESv2Client,
  SendEmailCommand,
} = require("@aws-sdk/client-sesv2");

let _ses = null;
function getSES() {
  if (_ses) return _ses;
  _ses = new SESv2Client({ region: process.env.SES_REGION || process.env.AWS_REGION || "us-east-1" });
  return _ses;
}

// POST /api/contact/enterprise — no auth required
router.post("/enterprise", async (req, res) => {
  const { firstName, lastName, email, company, teamSize, message } = req.body || {};
  if (!firstName || !email || !company) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const body = [
    `Name: ${firstName} ${lastName}`,
    `Email: ${email}`,
    `Company: ${company}`,
    `Team size: ${teamSize || "not specified"}`,
    `Message:\n${message || "(none)"}`,
  ].join("\n");

  try {
    const ses = getSES();
    await ses.send(new SendEmailCommand({
      FromEmailAddress: "noreply@goswft.com",
      Destination: { ToAddresses: ["sales@goswft.com"] },
      Content: {
        Simple: {
          Subject: { Data: `Enterprise inquiry — ${company}` },
          Body: { Text: { Data: body } },
        },
      },
    }));
  } catch (err) {
    // Log but don't surface error — show success to user regardless
    console.error("[contact] SES send failed:", err.message);
  }

  res.json({ ok: true });
});

module.exports = router;
