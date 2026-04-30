// ════════════════════════════════════════════════
// Team Tracker Routes — clock in/out + live location sharing
//
// Mounted at /api/tracker so it has its own permission mapping
// (tracker.view / tracker.viewAll) independent of /api/team, which
// is gated on team.manage (owner/admin only).
// ════════════════════════════════════════════════

const router = require("express").Router();
const { db } = require("../firebase");

async function getMyTeamDoc(req) {
  const snap = await db.collection("team")
    .where("orgId", "==", req.orgId)
    .where("uid", "==", req.uid)
    .limit(1)
    .get();
  if (!snap.empty) return snap.docs[0];

  // Owner has no team record yet — create it so clock-in/out work immediately
  if (req.uid === req.orgId) {
    const userDoc = await db.collection("users").doc(req.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const ref = await db.collection("team").add({
      orgId: req.orgId,
      uid: req.uid,
      email: userData.email || "",
      name: userData.name || userData.company || "Owner",
      role: "owner",
      status: "active",
      joinedAt: userData.createdAt || Date.now(),
    });
    return await ref.get();
  }

  return null;
}

// Owner has null permissions (unrestricted); everyone else gets a Set.
function canViewAll(req) {
  if (!req.userPermissions) return true;           // owner
  return req.userPermissions.has("tracker.viewAll");
}

// GET /api/tracker/locations — current pins for the org.
// Permission "tracker.viewAll" returns everyone; otherwise just self.
router.get("/locations", async (req, res, next) => {
  try {
    let query = db.collection("team").where("orgId", "==", req.orgId);
    const viewAll = canViewAll(req);
    if (!viewAll) {
      query = query.where("uid", "==", req.uid);
    }
    const snap = await query.get();
    const members = snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        uid: data.uid || null,
        name: data.name || "",
        role: data.role || "technician",
        status: data.status || "active",
        clockedIn: !!data.clockedIn,
        clockedInAt: data.clockedInAt || null,
        clockedOutAt: data.clockedOutAt || null,
        location: data.location || null,
      };
    });
    res.json({ members, canViewAll: viewAll });
  } catch (err) { next(err); }
});

// POST /api/tracker/clock-in — mark the caller as on the clock
router.post("/clock-in", async (req, res, next) => {
  try {
    const doc = await getMyTeamDoc(req);
    if (!doc) return res.status(404).json({ error: "You are not a member of this team" });
    await doc.ref.update({
      clockedIn: true,
      clockedInAt: Date.now(),
    });
    res.json({ success: true, clockedIn: true, clockedInAt: Date.now() });
  } catch (err) { next(err); }
});

// POST /api/tracker/clock-out — clear clocked-in state and drop the live pin
router.post("/clock-out", async (req, res, next) => {
  try {
    const doc = await getMyTeamDoc(req);
    if (!doc) return res.status(404).json({ error: "You are not a member of this team" });
    const { FieldValue } = require("firebase-admin/firestore");
    await doc.ref.update({
      clockedIn: false,
      clockedOutAt: Date.now(),
      location: FieldValue.delete(),
    });
    res.json({ success: true, clockedIn: false, clockedOutAt: Date.now() });
  } catch (err) { next(err); }
});

// POST /api/tracker/location — receive a live position from a clocked-in member
router.post("/location", async (req, res, next) => {
  try {
    const { latitude, longitude, accuracy } = req.body || {};
    const lat = Number(latitude);
    const lng = Number(longitude);
    const acc = Number(accuracy);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      return res.status(400).json({ error: "Invalid latitude" });
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: "Invalid longitude" });
    }
    if (Number.isFinite(acc) && acc > 10000) {
      return res.status(400).json({ error: "Location accuracy too low" });
    }

    const teamDoc = await getMyTeamDoc(req);
    if (!teamDoc) return res.status(404).json({ error: "You are not a member of this team" });
    if (!teamDoc.data().clockedIn) {
      return res.status(403).json({ error: "You must clock in before sharing location" });
    }

    await teamDoc.ref.update({
      location: {
        lat,
        lng,
        accuracy: Number.isFinite(acc) ? acc : null,
        updatedAt: Date.now(),
      },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/tracker/optimize-route
// One-click "optimize my day" for a single tech. Takes today's (or a chosen
// date's) assigned jobs with addresses, hands them to Google Directions with
// `waypoints=optimize:true`, and returns the best stop order plus total drive
// distance and duration. Doesn't mutate jobs — display-only; the owner can
// choose whether to adjust start times themselves.
router.post("/optimize-route", async (req, res, next) => {
  try {
    const { techUid, date } = req.body || {};
    if (!techUid) return res.status(400).json({ error: "techUid is required" });

    // Only owner or someone with tracker.viewAll can optimize anyone else's route.
    // Techs can still optimize their own without that permission.
    if (techUid !== req.uid && !canViewAll(req)) {
      return res.status(403).json({ error: "Not allowed to optimize another member's route" });
    }

    const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!MAPS_KEY) return res.status(503).json({ error: "Google Maps is not configured on this server." });

    // Resolve the day window — default to today, interpreted in the caller's
    // locale roughly via startOfDay/endOfDay calculated on the server.
    const day = date ? new Date(date) : new Date();
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    const end = start + 24 * 60 * 60 * 1000;

    // Pull all jobs for this tech on the selected day, dropping anything
    // without an address (can't route to it) or already completed.
    const jobsSnap = await db.collection("jobs")
      .where("orgId", "==", req.orgId)
      .where("assignedTo", "==", techUid)
      .get();

    const jobs = jobsSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(j => {
        if (!j.address || !j.address.trim()) return false;
        if (j.status === "complete" || j.status === "cancelled") return false;
        const sched = Number(j.scheduledDate);
        return Number.isFinite(sched) && sched >= start && sched < end;
      })
      .sort((a, b) => (a.scheduledDate || 0) - (b.scheduledDate || 0));

    if (jobs.length === 0) {
      return res.status(400).json({ error: "No jobs with addresses scheduled for this day." });
    }
    if (jobs.length === 1) {
      return res.json({
        orderedJobs: jobs,
        totalDistanceMeters: 0,
        totalDurationSeconds: 0,
        polyline: null,
        note: "Only one stop — nothing to optimize.",
      });
    }

    // Google Directions caps at ~25 waypoints per request. We use origin + dest
    // + up to 23 optimizable waypoints; past that we'd need chunking, which is
    // a v2 concern.
    const MAX_STOPS = 25;
    const truncated = jobs.length > MAX_STOPS;
    const stops = jobs.slice(0, MAX_STOPS);

    // Origin: tech's current location if they're clocked in and sharing,
    // otherwise the first stop's address. Destination: last stop.
    const techSnap = await db.collection("team")
      .where("orgId", "==", req.orgId)
      .where("uid", "==", techUid)
      .limit(1)
      .get();
    const techData = techSnap.empty ? null : techSnap.docs[0].data();
    const liveLoc = techData?.clockedIn && techData?.location?.lat != null
      ? `${techData.location.lat},${techData.location.lng}`
      : null;

    const origin = liveLoc || stops[0].address;
    const destination = stops[stops.length - 1].address;
    // If we used the live location as origin, every stop is a waypoint.
    // Otherwise the first stop is the origin and the last is the destination —
    // only the middle stops are waypoints.
    const waypointJobs = liveLoc ? stops.slice(0, -1) : stops.slice(1, -1);
    const waypointsParam = waypointJobs.length
      ? "optimize:true|" + waypointJobs.map(j => j.address).join("|")
      : null;

    const params = new URLSearchParams({
      origin,
      destination,
      key: MAPS_KEY,
      mode: "driving",
    });
    if (waypointsParam) params.set("waypoints", waypointsParam);

    const dirRes = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`);
    const dirData = await dirRes.json();
    if (dirData.status !== "OK" || !dirData.routes?.length) {
      return res.status(502).json({ error: `Routing failed: ${dirData.status || "unknown"}. ${dirData.error_message || ""}`.trim() });
    }

    const route = dirData.routes[0];
    // waypoint_order tells us the optimized permutation of the waypoints we sent.
    // Reconstruct the full ordered job list: origin → reordered waypoints → dest.
    const order = route.waypoint_order || [];
    const orderedJobs = [];
    if (liveLoc) {
      // All stops were waypoints; last one is destination
      const mid = order.map(i => waypointJobs[i]);
      orderedJobs.push(...mid, stops[stops.length - 1]);
    } else {
      orderedJobs.push(stops[0]);
      orderedJobs.push(...order.map(i => waypointJobs[i]));
      orderedJobs.push(stops[stops.length - 1]);
    }

    const totalDistanceMeters = route.legs.reduce((s, l) => s + (l.distance?.value || 0), 0);
    const totalDurationSeconds = route.legs.reduce((s, l) => s + (l.duration?.value || 0), 0);

    // Per-leg durations so the UI can show "Stop 1 → Stop 2: 14 min / 6 mi"
    const legs = route.legs.map(l => ({
      distanceMeters: l.distance?.value || 0,
      distanceText: l.distance?.text || "",
      durationSeconds: l.duration?.value || 0,
      durationText: l.duration?.text || "",
      startAddress: l.start_address,
      endAddress: l.end_address,
    }));

    res.json({
      orderedJobs,
      legs,
      totalDistanceMeters,
      totalDurationSeconds,
      polyline: route.overview_polyline?.points || null,
      origin: liveLoc ? { type: "live", location: techData.location } : { type: "address", address: stops[0].address },
      truncated,
      originalCount: jobs.length,
    });
  } catch (err) { next(err); }
});

module.exports = router;
