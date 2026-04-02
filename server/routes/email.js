const router = require("express").Router();
const nodemailer = require("nodemailer");
const { db } = require("../firebase");

// POST /api/email/send — send a quote or invoice via email
router.post("/send", async (req, res, next) => {
  try {
    const { to, subject, html, type, documentId } = req.body;

    if (!to || !subject) {
      return res.status(400).json({ error: "Recipient email and subject are required" });
    }

    // Get user's Gmail credentials from Firestore
    const userDoc = await db.collection("users").doc(req.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    const gmailUser = userData.gmailAddress || userData.email;
    const gmailAppPassword = userData.gmailAppPassword;

    if (!gmailAppPassword) {
      return res.status(400).json({
        error: "Gmail not configured. Go to Settings and add your Gmail App Password.",
        code: "GMAIL_NOT_CONFIGURED",
      });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: gmailUser,
        pass: gmailAppPassword,
      },
    });

    const mailOptions = {
      from: `"${userData.company || userData.name || "SWFT"}" <${gmailUser}>`,
      to,
      subject,
      html: html || `<p>Please find your ${type || "document"} attached.</p>`,
    };

    await transporter.sendMail(mailOptions);

    // Update document status if applicable — only if user owns it and it's still in a sendable state
    if (documentId && type) {
      const collection = type === "quote" ? "quotes" : "invoices";
      const docRef = db.collection(collection).doc(documentId);
      const docSnap = await docRef.get();
      if (docSnap.exists && docSnap.data().userId === req.uid) {
        const currentStatus = docSnap.data().status;
        const terminalStates = type === "quote" ? ["approved"] : ["paid"];
        if (!terminalStates.includes(currentStatus)) {
          await docRef.update({ status: "sent", sentAt: Date.now() });
        }
      }
    }

    res.json({ success: true, message: `Email sent to ${to}` });
  } catch (err) {
    if (err.code === "EAUTH") {
      return res.status(401).json({
        error: "Gmail authentication failed. Check your App Password.",
        code: "GMAIL_AUTH_FAILED",
      });
    }
    next(err);
  }
});

// POST /api/email/configure — save Gmail credentials
router.post("/configure", async (req, res, next) => {
  try {
    const { gmailAddress, gmailAppPassword } = req.body;
    if (!gmailAddress || !gmailAppPassword) {
      return res.status(400).json({ error: "Gmail address and App Password are required" });
    }

    await db.collection("users").doc(req.uid).set(
      { gmailAddress, gmailAppPassword, updatedAt: Date.now() },
      { merge: true }
    );

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
