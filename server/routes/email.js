const router = require("express").Router();
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { db } = require("../firebase");

const ENCRYPT_KEY = process.env.ENCRYPT_KEY || "swft_default_encrypt_key_change_me!";

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(ENCRYPT_KEY, "salt", 32);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decrypt(text) {
  const [ivHex, encrypted] = text.split(":");
  if (!ivHex || !encrypted) return text; // plaintext fallback for old data
  const iv = Buffer.from(ivHex, "hex");
  const key = crypto.scryptSync(ENCRYPT_KEY, "salt", 32);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// POST /api/email/send — send a quote or invoice via email
router.post("/send", async (req, res, next) => {
  try {
    const { to, subject, html, type, documentId } = req.body;

    if (!to || !subject) {
      return res.status(400).json({ error: "Recipient email and subject are required" });
    }

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
        pass: decrypt(gmailAppPassword),
      },
    });

    const mailOptions = {
      from: `"${userData.company || userData.name || "SWFT"}" <${gmailUser}>`,
      to,
      subject,
      html: html || `<p>Please find your ${type || "document"} attached.</p>`,
    };

    await transporter.sendMail(mailOptions);

    if (documentId && type) {
      const collection = type === "quote" ? "quotes" : "invoices";
      await db.collection(collection).doc(documentId).update({
        status: "sent",
        sentAt: Date.now(),
      });
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

// POST /api/email/configure — save Gmail credentials (encrypted)
router.post("/configure", async (req, res, next) => {
  try {
    const { gmailAddress, gmailAppPassword } = req.body;
    if (!gmailAddress || !gmailAppPassword) {
      return res.status(400).json({ error: "Gmail address and App Password are required" });
    }

    await db.collection("users").doc(req.uid).set(
      { gmailAddress, gmailAppPassword: encrypt(gmailAppPassword), updatedAt: Date.now() },
      { merge: true }
    );

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
