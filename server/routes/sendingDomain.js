const router = require("express").Router();
const { db } = require("../firebase");
const {
  createDomainIdentity,
  getDomainIdentity,
  deleteDomainIdentity,
  buildDkimRecords,
} = require("../utils/broadcastEmail");

const DOMAIN_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})+$/;

function normalizeDomain(raw) {
  if (!raw || typeof raw !== "string") return null;
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  return DOMAIN_RE.test(d) ? d : null;
}

// GET /api/sending-domain — current domain + DNS records + verification status
router.get("/", async (req, res, next) => {
  try {
    const userDoc = await db.collection("users").doc(req.orgId).get();
    const data = userDoc.exists ? userDoc.data() : {};
    const domain = data.sendingDomain;
    const fromLocalPart = data.sendingDomainLocalPart || "broadcasts";

    if (!domain) {
      return res.json({ domain: null });
    }

    // Query SES for live status
    let identity = null;
    try {
      identity = await getDomainIdentity(domain);
    } catch (err) {
      console.error("[sending-domain] SES lookup error:", err.message);
    }

    const verified = !!identity?.verifiedForSendingStatus;
    const tokens = identity?.dkimTokens || data.sendingDomainDkimTokens || [];
    const records = buildDkimRecords(domain, tokens);

    // Update cached status if changed
    if (verified !== !!data.sendingDomainVerified) {
      await db.collection("users").doc(req.orgId).update({
        sendingDomainVerified: verified,
        sendingDomainVerifiedAt: verified ? Date.now() : null,
      });
    }

    res.json({
      domain,
      fromLocalPart,
      fromEmail: `${fromLocalPart}@${domain}`,
      verified,
      dkimStatus: identity?.dkimStatus || "PENDING",
      records,
    });
  } catch (err) { next(err); }
});

// POST /api/sending-domain — create or replace the org's sending domain
router.post("/", async (req, res, next) => {
  try {
    const domain = normalizeDomain(req.body.domain);
    const localPart = (req.body.localPart || "broadcasts").trim().toLowerCase();

    if (!domain) {
      return res.status(400).json({ error: "Invalid domain. Use a format like acme.com or mail.acme.com." });
    }
    if (!/^[a-z0-9._-]+$/.test(localPart)) {
      return res.status(400).json({ error: "Invalid local part. Use letters, numbers, dots, or hyphens." });
    }

    // Remove old identity if different
    const existing = await db.collection("users").doc(req.orgId).get();
    const oldDomain = existing.exists ? existing.data().sendingDomain : null;
    if (oldDomain && oldDomain !== domain) {
      try { await deleteDomainIdentity(oldDomain); } catch (_) {}
    }

    // Create (or reuse) identity
    let identity;
    try {
      identity = await createDomainIdentity(domain);
    } catch (err) {
      // If already exists, fetch it
      if (err.name === "AlreadyExistsException") {
        identity = await getDomainIdentity(domain);
      } else {
        throw err;
      }
    }

    const tokens = identity?.dkimTokens || [];
    await db.collection("users").doc(req.orgId).update({
      sendingDomain: domain,
      sendingDomainLocalPart: localPart,
      sendingDomainDkimTokens: tokens,
      sendingDomainVerified: !!identity?.verifiedForSendingStatus,
      sendingDomainCreatedAt: Date.now(),
    });

    res.json({
      domain,
      fromLocalPart: localPart,
      fromEmail: `${localPart}@${domain}`,
      verified: !!identity?.verifiedForSendingStatus,
      records: buildDkimRecords(domain, tokens),
    });
  } catch (err) {
    console.error("[sending-domain] create error:", err);
    res.status(500).json({ error: err.message || "Failed to set up sending domain" });
  }
});

// DELETE /api/sending-domain — remove custom domain, fall back to shared sender
router.delete("/", async (req, res, next) => {
  try {
    const userDoc = await db.collection("users").doc(req.orgId).get();
    const domain = userDoc.exists ? userDoc.data().sendingDomain : null;
    if (domain) {
      try { await deleteDomainIdentity(domain); } catch (_) {}
    }
    await db.collection("users").doc(req.orgId).update({
      sendingDomain: null,
      sendingDomainLocalPart: null,
      sendingDomainDkimTokens: null,
      sendingDomainVerified: false,
      sendingDomainVerifiedAt: null,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
