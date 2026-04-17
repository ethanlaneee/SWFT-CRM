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
  return snap.empty ? null : snap.docs[0];
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

module.exports = router;
