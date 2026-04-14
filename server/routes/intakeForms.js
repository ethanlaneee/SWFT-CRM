/**
 * Intake Forms — per-org configuration for the public customer intake form.
 *
 * Authenticated endpoints:
 *   GET  /api/intake-forms          — get org's intake form config
 *   PUT  /api/intake-forms          — save/update intake form config
 *   GET  /api/intake-forms/qr-url   — get the public URL for this org's intake form
 */

const router = require("express").Router();
const { db } = require("../firebase");

const col = () => db.collection("intakeForms");

/**
 * GET /api/intake-forms
 * Returns the intake form config for the authenticated org.
 */
router.get("/", async (req, res, next) => {
  try {
    const doc = await col().doc(req.orgId).get();
    if (!doc.exists) {
      // Return sensible defaults if no config has been saved yet
      return res.json({
        orgId:        req.orgId,
        active:       false,
        formTitle:    "Request a Service",
        formSubtitle: "Fill out the form below and we'll be in touch shortly.",
        services:     [],
        quoteEnabled: false,
        requirePhotos: false,
        createdAt:    null,
        updatedAt:    null,
      });
    }
    res.json({ orgId: req.orgId, ...doc.data() });
  } catch (err) { next(err); }
});

/**
 * PUT /api/intake-forms
 * Create or update the intake form config.
 * Body: {
 *   active, formTitle, formSubtitle,
 *   services: [{ name, ratePerSqft }],
 *   quoteEnabled, requirePhotos
 * }
 */
router.put("/", async (req, res, next) => {
  try {
    const body = req.body;

    // Validate services array
    const services = Array.isArray(body.services)
      ? body.services.map(s => ({
          name:       (s.name || "").trim(),
          ratePerSqft: s.ratePerSqft != null ? parseFloat(s.ratePerSqft) || 0 : null,
        })).filter(s => s.name)
      : [];

    const data = {
      orgId:        req.orgId,
      active:       body.active === true || body.active === "true",
      formTitle:    (body.formTitle    || "Request a Service").trim(),
      formSubtitle: (body.formSubtitle || "").trim(),
      services,
      quoteEnabled:  body.quoteEnabled  === true || body.quoteEnabled  === "true",
      requirePhotos: body.requirePhotos === true || body.requirePhotos === "true",
      updatedAt:    Date.now(),
    };

    const doc = await col().doc(req.orgId).get();
    if (!doc.exists) {
      data.createdAt = Date.now();
      await col().doc(req.orgId).set(data);
    } else {
      await col().doc(req.orgId).update(data);
    }

    res.json({ success: true, ...data });
  } catch (err) { next(err); }
});

/**
 * GET /api/intake-forms/qr-url
 * Returns the public URL that the QR code should point to.
 * The frontend uses this URL to generate the QR code image.
 */
router.get("/qr-url", async (req, res, next) => {
  try {
    const appUrl = process.env.APP_URL || "https://goswft.com";
    const url = `${appUrl}/swft-intake?org=${req.orgId}`;
    res.json({ url, orgId: req.orgId });
  } catch (err) { next(err); }
});

module.exports = router;
