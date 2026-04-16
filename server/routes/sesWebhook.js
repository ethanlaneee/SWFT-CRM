const { db } = require("../firebase");
const https = require("https");
const crypto = require("crypto");

const EXPECTED_TOPIC_ARN = process.env.SES_SNS_TOPIC_ARN || null;
const CERT_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

const certCache = new Map();

function fetchCert(url) {
  if (certCache.has(url)) return Promise.resolve(certCache.get(url));
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "https:" || !CERT_HOST_RE.test(u.hostname)) {
      return reject(new Error("Invalid SNS cert host"));
    }
    https.get(url, (resp) => {
      if (resp.statusCode !== 200) return reject(new Error("Cert fetch " + resp.statusCode));
      let data = "";
      resp.on("data", (chunk) => { data += chunk; });
      resp.on("end", () => {
        certCache.set(url, data);
        resolve(data);
      });
    }).on("error", reject);
  });
}

function buildStringToSign(msg) {
  const fields = msg.Type === "Notification"
    ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
    : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  let s = "";
  for (const f of fields) {
    if (msg[f] != null) s += f + "\n" + msg[f] + "\n";
  }
  return s;
}

async function verifySignature(msg) {
  if (!msg.SigningCertURL || !msg.Signature) return false;
  const algo = msg.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  const cert = await fetchCert(msg.SigningCertURL);
  const verifier = crypto.createVerify(algo);
  verifier.update(buildStringToSign(msg), "utf8");
  return verifier.verify(cert, msg.Signature, "base64");
}

function autoConfirm(subscribeUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(subscribeUrl);
    if (u.protocol !== "https:" || !/amazonaws\.com$/.test(u.hostname)) {
      return reject(new Error("Bad SubscribeURL"));
    }
    https.get(subscribeUrl, (resp) => {
      if (resp.statusCode >= 200 && resp.statusCode < 300) resolve();
      else reject(new Error("Confirm " + resp.statusCode));
      resp.resume();
    }).on("error", reject);
  });
}

async function suppress(email, reason, detail) {
  if (!email) return;
  const normalized = String(email).trim().toLowerCase();
  const id = Buffer.from(normalized).toString("hex").slice(0, 80);
  await db.collection("ses_suppressions").doc(id).set({
    email: normalized,
    reason,
    detail: detail || null,
    suppressedAt: Date.now(),
  }, { merge: true });
}

async function handleNotification(body) {
  let payload;
  try { payload = JSON.parse(body.Message); } catch { return; }

  const type = payload.notificationType || payload.eventType;

  if (type === "Bounce") {
    const bounceType = payload.bounce?.bounceType;
    const isPermanent = bounceType === "Permanent";
    for (const r of payload.bounce?.bouncedRecipients || []) {
      if (isPermanent) await suppress(r.emailAddress, "bounce", bounceType);
    }
  } else if (type === "Complaint") {
    for (const r of payload.complaint?.complainedRecipients || []) {
      await suppress(r.emailAddress, "complaint", payload.complaint?.complaintFeedbackType || null);
    }
  }
}

async function sesWebhookHandler(req, res) {
  const msg = req.body;
  console.log("[ses-webhook] received:", {
    type: msg?.Type,
    topicArn: msg?.TopicArn,
    messageId: msg?.MessageId,
    hasSignature: !!msg?.Signature,
    bodyIsObject: typeof msg === "object",
    bodyKeys: msg && typeof msg === "object" ? Object.keys(msg) : null,
  });

  if (!msg || typeof msg !== "object") {
    console.error("[ses-webhook] rejected: body not an object");
    return res.status(400).send("bad");
  }

  if (EXPECTED_TOPIC_ARN && msg.TopicArn !== EXPECTED_TOPIC_ARN) {
    console.error("[ses-webhook] rejected: topic ARN mismatch", { got: msg.TopicArn, expected: EXPECTED_TOPIC_ARN });
    return res.status(403).send("forbidden");
  }

  try {
    const ok = await verifySignature(msg);
    if (!ok) {
      console.error("[ses-webhook] rejected: signature verification returned false");
      return res.status(403).send("bad signature");
    }
  } catch (err) {
    console.error("[ses-webhook] signature error:", err.message);
    return res.status(403).send("bad signature");
  }

  if (msg.Type === "SubscriptionConfirmation") {
    console.log("[ses-webhook] confirming subscription, calling SubscribeURL...");
    try {
      await autoConfirm(msg.SubscribeURL);
      console.log("[ses-webhook] subscription confirmed:", msg.TopicArn);
      return res.status(200).send("ok");
    } catch (err) {
      console.error("[ses-webhook] confirm error:", err.message);
      return res.status(500).send("confirm failed");
    }
  }

  if (msg.Type === "Notification") {
    try {
      await handleNotification(msg);
    } catch (err) {
      console.error("[ses-webhook] handler error:", err.message);
    }
    return res.status(200).send("ok");
  }

  res.status(200).send("ignored");
}

async function isSuppressed(email) {
  if (!email) return false;
  const normalized = String(email).trim().toLowerCase();
  const id = Buffer.from(normalized).toString("hex").slice(0, 80);
  const doc = await db.collection("ses_suppressions").doc(id).get();
  return doc.exists;
}

module.exports = { sesWebhookHandler, isSuppressed };
