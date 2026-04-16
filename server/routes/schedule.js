const router = require("express").Router();
const { google } = require("googleapis");
const { db } = require("../firebase");
const { getOAuthClient } = require("../utils/email");

const col = () => db.collection("schedule");

/**
 * Sync a time block to Google Calendar if connected.
 * Creates or updates a Google Calendar event and stores the gcalEventId back.
 */
async function syncToGoogleCalendar(uid, scheduleId, data) {
  try {
    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) return;
    const userData = userDoc.data();
    const gcal = userData.integrations?.google_calendar;
    if (!gcal?.connected || !gcal?.tokens) return;

    const auth = getOAuthClient(gcal.tokens);
    auth.on("tokens", async (newTokens) => {
      try {
        const updated = { ...gcal.tokens, ...newTokens };
        await db.collection("users").doc(uid).update({
          "integrations.google_calendar.tokens": updated,
        });
      } catch (e) { /* ignore token refresh save errors */ }
    });

    const calendar = google.calendar({ version: "v3", auth });

    if (!data.date || !data.startTime || !data.endTime) return;

    const startDateTime = `${data.date}T${data.startTime}:00`;
    const endDateTime = `${data.date}T${data.endTime}:00`;
    const typeLabels = { billable: "Billable", internal: "Internal", buffer: "Buffer" };
    const summary = data.title || `${typeLabels[data.type] || "Time"} Block`;
    const description = [
      data.notes || "",
      `Type: ${typeLabels[data.type] || data.type}`,
      data.jobId ? `Job ID: ${data.jobId}` : "",
    ].filter(Boolean).join("\n");

    const eventBody = {
      summary,
      description,
      location: data.location || "",
      start: { dateTime: startDateTime, timeZone: "America/Edmonton" },
      end: { dateTime: endDateTime, timeZone: "America/Edmonton" },
    };

    // Check if we have an existing Google Calendar event to update
    const existingEventId = data.gcalEventId;

    if (existingEventId) {
      try {
        await calendar.events.update({
          calendarId: "primary",
          eventId: existingEventId,
          requestBody: eventBody,
        });
        console.log(`[schedule] Updated GCal event ${existingEventId} for block ${scheduleId}`);
        return;
      } catch (e) {
        // Event may have been deleted from calendar — create a new one
        console.log(`[schedule] GCal update failed (${e.message}), creating new event`);
      }
    }

    // Create new event
    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody: eventBody,
    });

    // Store the GCal event ID back on the schedule doc
    await col().doc(scheduleId).update({ gcalEventId: res.data.id });
    console.log(`[schedule] Created GCal event ${res.data.id} for block ${scheduleId}`);
  } catch (err) {
    console.error(`[schedule] Google Calendar sync error for ${scheduleId}:`, err.message);
  }
}

/**
 * Delete a Google Calendar event when a time block is deleted.
 */
async function deleteFromGoogleCalendar(uid, gcalEventId) {
  try {
    if (!gcalEventId) return;
    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) return;
    const userData = userDoc.data();
    const gcal = userData.integrations?.google_calendar;
    if (!gcal?.connected || !gcal?.tokens) return;

    const auth = getOAuthClient(gcal.tokens);
    const calendar = google.calendar({ version: "v3", auth });
    await calendar.events.delete({ calendarId: "primary", eventId: gcalEventId });
    console.log(`[schedule] Deleted GCal event ${gcalEventId}`);
  } catch (err) {
    console.error(`[schedule] GCal delete error:`, err.message);
  }
}

// List schedule entries
router.get("/", async (req, res, next) => {
  try {
    const snap = await col().where("orgId", "==", req.orgId).get();
    const results = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    results.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    res.json(results);
  } catch (err) { next(err); }
});

// Create schedule entry
router.post("/", async (req, res, next) => {
  try {
    const data = {
      orgId: req.orgId,
      userId: req.uid,
      jobId: req.body.jobId || null,
      title: req.body.title || "",
      type: req.body.type || "other",
      date: req.body.date || null,
      startTime: req.body.startTime || null,
      endTime: req.body.endTime || null,
      durationMins: req.body.durationMins || 60,
      buffer: req.body.buffer || 0,
      location: req.body.location || "",
      notes: req.body.notes || "",
      createdAt: Date.now(),
    };
    const ref = await col().add(data);

    // Sync to Google Calendar in background (don't block response)
    syncToGoogleCalendar(req.uid, ref.id, data).catch(() => {});

    res.status(201).json({ id: ref.id, ...data });
  } catch (err) { next(err); }
});

// Update schedule entry
router.put("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Schedule entry not found" });
    }
    const updates = {};
    for (const key of ["jobId", "title", "type", "date", "startTime", "endTime", "durationMins", "buffer", "location", "notes"]) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updatedAt = Date.now();
    await col().doc(req.params.id).update(updates);

    const merged = { ...doc.data(), ...updates };

    // Sync to Google Calendar in background
    syncToGoogleCalendar(req.uid, req.params.id, merged).catch(() => {});

    res.json({ id: req.params.id, ...merged });
  } catch (err) { next(err); }
});

// Delete schedule entry
router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Schedule entry not found" });
    }

    // Delete from Google Calendar in background
    const gcalEventId = doc.data().gcalEventId;
    deleteFromGoogleCalendar(req.uid, gcalEventId).catch(() => {});

    await col().doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
