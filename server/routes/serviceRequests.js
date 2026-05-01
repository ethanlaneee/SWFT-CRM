/**
 * Service Requests — intake form submissions that flow into SWFT as pending jobs.
 *
 * Public (no auth):
 *   GET  /api/public/intake/:orgId/config  — form config (company name, services, quote automation)
 *   POST /api/public/intake/:orgId         — submit intake form (creates a serviceRequest doc)
 *   POST /api/public/intake/:orgId/photos  — upload photos during form fill (returns URLs)
 *
 * Authenticated (org members):
 *   GET    /api/service-requests           — list all service requests for org
 *   GET    /api/service-requests/:id       — get single service request
 *   POST   /api/service-requests/:id/approve — approve → creates a customer + job
 *   POST   /api/service-requests/:id/deny    — deny request
 *   DELETE /api/service-requests/:id         — delete service request
 */

const express = require("express");
const router      = express.Router(); // authenticated routes
const publicRouter = express.Router(); // no-auth intake submission routes
const multer = require("multer");
const path   = require("path");
const { db, bucket } = require("../firebase");

const col = () => db.collection("serviceRequests");

// ── Multer config for public photo uploads ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith("image/");
    cb(ok ? null : new Error("Only images are allowed"), ok);
  },
});

// ════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS — mounted on publicRouter (no auth)
// Accessed at: /api/public/intake/:orgId/...
// ════════════════════════════════════════════════════════════

/**
 * GET /api/public/intake/:orgId/config
 * Returns the intake form config for a given org (company name, services, quote settings).
 * No auth required — used by the public intake form page.
 */
publicRouter.get("/:orgId/config", async (req, res) => {
  try {
    const { orgId } = req.params;
    if (!orgId) return res.status(400).json({ error: "orgId required" });

    // Load org user info for company name
    const userDoc = await db.collection("users").doc(orgId).get();
    if (!userDoc.exists) return res.status(404).json({ error: "Organization not found" });

    const userData = userDoc.data();
    if (userData.accountStatus === "suspended") {
      return res.status(403).json({ error: "This form is currently unavailable" });
    }

    // Load intake form config
    const cfgDoc = await db.collection("intakeForms").doc(orgId).get();
    const cfg = cfgDoc.exists ? cfgDoc.data() : {};

    // Build services list: pull names from company Service Types setting,
    // then layer in any per-service rates saved in the intake form config.
    const serviceTypeNames = (userData.serviceTypes || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    const rateMap = {};
    (cfg.services || []).forEach(svc => { if (svc.name) rateMap[svc.name] = svc.ratePerSqft || null; });

    const services = serviceTypeNames.length > 0
      ? serviceTypeNames.map(name => ({ name, ratePerSqft: rateMap[name] || null }))
      : cfg.services || [];

    res.json({
      companyName:      userData.company || userData.name || "SWFT Business",
      logoUrl:          userData.companyLogo || userData.logoUrl || null,
      services,
      quoteEnabled:     cfg.quoteEnabled || false,
      formTitle:        cfg.formTitle  || "Request a Quote",
      formSubtitle:     cfg.formSubtitle || "Fill out the form below and we'll be in touch shortly.",
      requirePhotos:    cfg.requirePhotos || false,
      hearAboutOptions: cfg.hearAboutOptions || "",
      active:           cfg.active !== false, // default true
    });
  } catch (err) {
    console.error("[intake/config]", err.message);
    res.status(500).json({ error: "Failed to load form configuration" });
  }
});

/**
 * POST /api/public/intake/:orgId/photos
 * Upload photos from the intake form. Returns an array of public URLs.
 * No auth required.
 */
publicRouter.post("/:orgId/photos", upload.array("photos", 10), async (req, res) => {
  try {
    const { orgId } = req.params;
    if (!orgId) return res.status(400).json({ error: "orgId required" });

    // Verify the org exists
    const userDoc = await db.collection("users").doc(orgId).get();
    if (!userDoc.exists) return res.status(404).json({ error: "Organization not found" });

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const urls = [];
    for (const file of req.files) {
      const ext = path.extname(file.originalname) || ".jpg";
      const filename = `intake/${orgId}/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
      const fileRef = bucket.file(filename);

      await fileRef.save(file.buffer, { metadata: { contentType: file.mimetype } });

      let url;
      try {
        await fileRef.makePublic();
        url = `https://storage.googleapis.com/${bucket.name}/${filename}`;
      } catch (_) {
        const [signedUrl] = await fileRef.getSignedUrl({
          action:  "read",
          expires: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
        });
        url = signedUrl;
      }
      urls.push(url);
    }

    res.json({ urls });
  } catch (err) {
    console.error("[intake/photos]", err.message);
    res.status(500).json({ error: "Photo upload failed" });
  }
});

/**
 * POST /api/public/intake/:orgId
 * Submit an intake form. Creates a serviceRequest document.
 * No auth required.
 */
publicRouter.post("/:orgId", async (req, res) => {
  try {
    const { orgId } = req.params;
    if (!orgId) return res.status(400).json({ error: "orgId required" });

    // Verify org exists
    const userDoc = await db.collection("users").doc(orgId).get();
    if (!userDoc.exists) return res.status(404).json({ error: "Organization not found" });

    const cfg = await db.collection("intakeForms").doc(orgId).get();
    const formCfg = cfg.exists ? cfg.data() : {};
    if (formCfg.active === false) {
      return res.status(403).json({ error: "This form is currently not accepting submissions" });
    }

    const body = req.body;

    // Basic validation
    const name = (body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name is required" });

    // Calculate estimate if quote automation is enabled
    let estimatedQuote = null;
    if (formCfg.quoteEnabled && body.service && body.squareFootage) {
      const sqft = parseFloat(body.squareFootage) || 0;
      const services = formCfg.services || [];
      const svc = services.find(s => s.name === body.service);
      if (svc && svc.ratePerSqft) {
        estimatedQuote = Math.round(sqft * parseFloat(svc.ratePerSqft) * 100) / 100;
      }
    }

    const data = {
      orgId,
      status:        "pending",
      // Contact info
      name:          name,
      phone:         (body.phone || "").trim(),
      email:         (body.email || "").trim(),
      address:       (body.address || "").trim(),
      // Service info
      service:       (body.service || "").trim(),
      squareFootage: body.squareFootage ? parseFloat(body.squareFootage) : null,
      notes:         (body.notes || "").trim(),
      hearAbout:     (body.hearAbout || "").trim(),
      // Photos uploaded separately, URLs passed in body
      photos:        Array.isArray(body.photos) ? body.photos : [],
      // Computed quote
      estimatedQuote,
      // Meta
      submittedAt:   Date.now(),
      createdAt:     Date.now(),
      // For tracking
      source:        "intake_form",
      ipAddress:     req.ip || null,
    };

    const ref = await col().add(data);

    // Create a notification for the org owner
    try {
      await db.collection("notifications").add({
        orgId,
        userId: orgId,
        type:    "service_request",
        title:   `New Service Request from ${name}`,
        message: `${body.service || "Service"} request${data.address ? ` at ${data.address}` : ""}${estimatedQuote ? ` — Est. $${estimatedQuote.toLocaleString()}` : ""}`,
        read:    false,
        serviceRequestId: ref.id,
        createdAt: Date.now(),
      });
    } catch (e) {
      console.warn("[intake] Notification create failed:", e.message);
    }

    res.status(201).json({
      success: true,
      id: ref.id,
      estimatedQuote,
    });
  } catch (err) {
    console.error("[intake/submit]", err.message);
    res.status(500).json({ error: "Submission failed. Please try again." });
  }
});

// ════════════════════════════════════════════════════════════
// AUTHENTICATED ENDPOINTS (org members)
// ════════════════════════════════════════════════════════════

/**
 * GET /api/service-requests
 * List service requests for the org. Supports ?status= filter.
 */
router.get("/", async (req, res, next) => {
  try {
    const snap = await col().where("orgId", "==", req.orgId).get();
    let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (req.query.status) {
      results = results.filter(r => r.status === req.query.status);
    }

    results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(results);
  } catch (err) { next(err); }
});

/**
 * GET /api/service-requests/:id
 * Get a single service request.
 */
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Service request not found" });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) { next(err); }
});

/**
 * POST /api/service-requests/:id/approve
 * Approve a service request → creates (or finds) a customer + creates a job.
 * Body: { scheduledDate?, startTime?, assignedTo?, notes? }
 */
router.post("/:id/approve", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Service request not found" });
    }
    const sr = doc.data();
    if (sr.status === "approved") {
      return res.status(400).json({ error: "Already approved" });
    }

    // 1. Find or create customer
    let customerId = null;
    let customerName = sr.name;

    if (sr.email || sr.phone) {
      // Try to find existing customer by email or phone
      const custSnap = await db.collection("customers")
        .where("orgId", "==", req.orgId)
        .get();
      const all = custSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const existing = all.find(c =>
        (sr.email && c.email && c.email.toLowerCase() === sr.email.toLowerCase()) ||
        (sr.phone && c.phone && c.phone.replace(/\D/g, "") === sr.phone.replace(/\D/g, ""))
      );
      if (existing) {
        customerId = existing.id;
        customerName = existing.name;
      }
    }

    if (!customerId) {
      // Create new customer
      const custData = {
        orgId:     req.orgId,
        userId:    req.uid,
        name:      sr.name || "",
        email:     sr.email || "",
        phone:     sr.phone || "",
        address:   sr.address || "",
        notes:     sr.notes ? `From intake form: ${sr.notes}` : "",
        tags:      ["intake-form"],
        createdAt: Date.now(),
      };
      const custRef = await db.collection("customers").add(custData);
      customerId = custRef.id;
    }

    // 2. Create the job
    const jobData = {
      orgId:        req.orgId,
      userId:       req.uid,
      customerId,
      customerName,
      title:        sr.service ? `${sr.service} — ${sr.name}` : `Service for ${sr.name}`,
      description:  sr.notes || "",
      service:      sr.service || "",
      status:       "scheduled",
      scheduledDate: req.body.scheduledDate || null,
      startTime:    req.body.startTime || "",
      cost:         sr.estimatedQuote || 0,
      address:      sr.address || "",
      sqft:         sr.squareFootage ? String(sr.squareFootage) : "",
      assignedTo:   req.body.assignedTo || null,
      crew:         "Unassigned",
      photos:       sr.photos || [],
      sourceType:   "service_request",
      sourceId:     doc.id,
      createdAt:    Date.now(),
    };
    const jobRef = await db.collection("jobs").add(jobData);

    // 3. Update the service request status
    await col().doc(req.params.id).update({
      status:     "approved",
      approvedAt: Date.now(),
      approvedBy: req.uid,
      jobId:      jobRef.id,
      customerId,
    });

    res.json({
      success: true,
      jobId: jobRef.id,
      customerId,
      job: { id: jobRef.id, ...jobData },
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/service-requests/:id/deny
 * Deny a service request. Body: { reason? }
 */
router.post("/:id/deny", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Service request not found" });
    }
    if (doc.data().status === "approved") {
      return res.status(400).json({ error: "Cannot deny an already-approved request" });
    }

    await col().doc(req.params.id).update({
      status:    "denied",
      deniedAt:  Date.now(),
      deniedBy:  req.uid,
      denyReason: (req.body.reason || "").trim(),
    });

    res.json({ success: true, status: "denied" });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/service-requests/:id
 * Permanently delete a service request.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Service request not found" });
    }
    await col().doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = { router, publicRouter };
