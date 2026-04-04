const router = require("express").Router();
const multer = require("multer");
const { db, bucket } = require("../firebase");
const path = require("path");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|jpg|png|gif|webp|heic)|video\/mp4/.test(file.mimetype);
    cb(ok ? null : new Error("Only images and MP4 videos are allowed"), ok);
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

      await fileRef.save(file.buffer, {
        metadata: { contentType: file.mimetype },
      });

      await fileRef.makePublic();
      const url = `https://storage.googleapis.com/${bucket.name}/${filename}`;

      const photoData = {
        orgId: req.orgId,
        jobId: req.params.jobId,
        url,
        filename,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        uploadedBy: req.uid,
        createdAt: Date.now(),
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
      .orderBy("createdAt", "desc")
      .get();
    const photos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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
    // Delete from Storage
    try {
      await bucket.file(doc.data().filename).delete();
    } catch (e) { /* file may already be gone */ }
    await db.collection("jobPhotos").doc(req.params.photoId).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
