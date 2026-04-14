const router = require("express").Router();
const multer = require("multer");
const { db, bucket } = require("../firebase");
const path = require("path");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith("image/") ||
               file.mimetype === "video/mp4"       ||
               file.mimetype === "video/quicktime";
    cb(ok ? null : new Error("Only images and videos are allowed"), ok);
  },
});

// POST /api/photos/job/:jobId — upload one or more photos to a job
router.post("/job/:jobId", upload.array("photos", 20), async (req, res, next) => {
  try {
    const jobDoc = await db.collection("jobs").doc(req.params.jobId).get();
    if (!jobDoc.exists || jobDoc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const uploaded = [];
    for (const file of req.files) {
      const ext = path.extname(file.originalname) || ".jpg";
      const filename = `jobs/${req.params.jobId}/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
      const fileRef = bucket.file(filename);

      await fileRef.save(file.buffer, { metadata: { contentType: file.mimetype } });

      // Try public URL first, fall back to signed URL
      let url;
      try {
        await fileRef.makePublic();
        url = `https://storage.googleapis.com/${bucket.name}/${filename}`;
      } catch (_) {
        const [signedUrl] = await fileRef.getSignedUrl({
          action:  "read",
          expires: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000, // 10 years
        });
        url = signedUrl;
      }

      const photoData = {
        orgId:        req.orgId,
        jobId:        req.params.jobId,
        url,
        filename,
        originalName: file.originalname,
        mimeType:     file.mimetype,
        size:         file.size,
        uploadedBy:   req.uid,
        createdAt:    Date.now(),
      };
      const ref = await db.collection("jobPhotos").add(photoData);
      uploaded.push({ id: ref.id, ...photoData });
    }

    res.status(201).json({ uploaded });
  } catch (err) { next(err); }
});

// GET /api/photos/job/:jobId — list all photos for a job
router.get("/job/:jobId", async (req, res, next) => {
  try {
    const jobDoc = await db.collection("jobs").doc(req.params.jobId).get();
    if (!jobDoc.exists || jobDoc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Job not found" });
    }
    const snap = await db.collection("jobPhotos")
      .where("jobId", "==", req.params.jobId)
      .get();
    const photos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    photos.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(photos);
  } catch (err) { next(err); }
});

// DELETE /api/photos/:photoId — delete a photo
router.delete("/:photoId", async (req, res, next) => {
  try {
    const doc = await db.collection("jobPhotos").doc(req.params.photoId).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Photo not found" });
    }
    try {
      await bucket.file(doc.data().filename).delete();
    } catch (_) { /* file may already be gone */ }
    await db.collection("jobPhotos").doc(req.params.photoId).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
