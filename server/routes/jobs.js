const router = require("express").Router();
const { db } = require("../firebase");
const { triggerAutomation } = require("./automations");
const { syncJobToCalendar, deleteJobFromCalendar } = require("../ai/integration-tools");

const col = () => db.collection("jobs");

// List jobs — permission-based filtering
// jobs.viewAll → see every job in the org
// jobs.view only → see jobs assigned to this user
router.get("/", async (req, res, next) => {
  try {
    const snap = await col().where("orgId", "==", req.orgId).get();
    let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // If user does NOT have jobs.viewAll, filter to assigned jobs only
    const perms = req.userPermissions; // Set or null (owner)
    if (perms && !perms.has("jobs.viewAll")) {
      results = results.filter(r => r.assignedTo === req.uid);
    }

    if (req.query.status) results = results.filter(r => r.status === req.query.status);
    if (req.query.assignedTo) results = results.filter(r => r.assignedTo === req.query.assignedTo);
    results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(results);
  } catch (err) { next(err); }
});

// Get single job
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) { next(err); }
});

// Create job
router.post("/", async (req, res, next) => {
  try {
    const data = {
      orgId: req.orgId,
      userId: req.uid, // keep for legacy compat
      customerId: req.body.customerId || "",
      customerName: req.body.customerName || "",
      quoteId: req.body.quoteId || null,
      title: req.body.title || "",
      description: req.body.description || "",
      service: req.body.service || "",
      status: req.body.status || "scheduled",
      scheduledDate: req.body.scheduledDate || null,
      startTime: req.body.startTime || "",
      cost: req.body.cost || 0,
      address: req.body.address || "",
      sqft: req.body.sqft || "",
      duration: req.body.duration || "",
      finish: req.body.finish || "",
      crew: req.body.crew || "Unassigned",
      assignedTo: req.body.assignedTo || null, // team member UID
      createdAt: Date.now(),
    };
    const ref = await col().add(data);

    // Sync to Google Calendar if connected and job has a date (await to store event ID)
    if (data.scheduledDate) {
      try {
        const calResult = await syncJobToCalendar(req.uid, data, ref.id);
        if (calResult && calResult.eventId) data.googleCalendarEventId = calResult.eventId;
      } catch (e) { console.error("Calendar sync error:", e.message); }
    }

    res.status(201).json({ id: ref.id, ...data });
  } catch (err) { next(err); }
});

// Update job
router.put("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Job not found" });
    }
    const updates = {};
    for (const key of ["customerId", "customerName", "quoteId", "title", "description", "service", "status", "scheduledDate", "startTime", "cost", "address", "sqft", "duration", "finish", "crew", "assignedTo"]) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updatedAt = Date.now();
    await col().doc(req.params.id).update(updates);

    // Sync to Google Calendar if date is set (new or existing)
    const merged = { ...doc.data(), ...updates };
    if (merged.scheduledDate) {
      try {
        await syncJobToCalendar(req.uid, merged, req.params.id);
      } catch (e) { console.error("Calendar sync error:", e.message); }
    }

    res.json({ id: req.params.id, ...merged });
  } catch (err) { next(err); }
});

// Complete job
router.post("/:id/complete", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Job not found" });
    }
    await col().doc(req.params.id).update({ status: "complete", completedAt: Date.now() });

    // Trigger automations for job_completed
    const jobData = doc.data();
    if (jobData.customerId) {
      try {
        const custDoc = await db.collection("customers").doc(jobData.customerId).get();
        const cust = custDoc.exists ? custDoc.data() : {};
        triggerAutomation(req.orgId, "job_completed", {
          id: jobData.customerId,
          name: cust.name || jobData.customerName || "",
          phone: cust.phone || "",
          email: cust.email || "",
          total: jobData.cost || 0,
          service: jobData.service || "",
        }).catch(console.error);
      } catch (e) { console.error("job_completed automation error:", e); }
    }

    res.json({ success: true, status: "complete" });
  } catch (err) { next(err); }
});

// Delete job
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Job not found" });
    }
    const jobData = doc.data();
    await col().doc(req.params.id).delete();

    // Remove from Google Calendar if synced
    if (jobData.googleCalendarEventId) {
      deleteJobFromCalendar(req.uid, jobData.googleCalendarEventId).catch(console.error);
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
