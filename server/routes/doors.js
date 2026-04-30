// ════════════════════════════════════════════════
// Door Knocking Tracker — log doors, statuses, and per-visit timestamps
//
// Data model:  doorKnocks collection
//   { orgId, userId, userName, lat, lng, accuracy, address,
//     name, phone, email, notes, status,
//     visits: [{ ts, status, notes, by, byName }],
//     createdAt, updatedAt }
//
// Each "door" is one physical address. Logging a return visit appends to
// `visits` and updates the top-level status — preserving the full history
// the user asked for.
// ════════════════════════════════════════════════

const router = require("express").Router();
const { db } = require("../firebase");

const col = () => db.collection("doorKnocks");

const ALLOWED_STATUSES = new Set([
  "pending",         // planned but not yet knocked (bulk-imported)
  "no_answer",
  "not_interested",
  "chatted",
  "come_back",
  "callback",
  "lead",
  "sale",
]);

function sanitizeStatus(s, fallback) {
  const v = String(s || fallback || "no_answer").toLowerCase().trim();
  return ALLOWED_STATUSES.has(v) ? v : (fallback || "no_answer");
}

function clampStr(v, max) {
  if (v == null) return "";
  return String(v).slice(0, max);
}

function validCoord(lat, lng) {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90
      && Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

// Server-side geocoder. Tries Google Geocoding API first (using
// GOOGLE_MAPS_API_KEY), then falls back to OpenStreetMap Nominatim — which
// is free and key-less, so imports work even if the Google key isn't set
// up for Geocoding. Returns { address, lat, lng, source } or { error, message }.
async function geocodeViaGoogle(address) {
  const KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!KEY) return { error: "NO_API_KEY" };
  const url = "https://maps.googleapis.com/maps/api/geocode/json?address="
    + encodeURIComponent(address) + "&key=" + KEY;
  try {
    const r = await fetch(url);
    const data = await r.json();
    if (data.status === "OK" && data.results && data.results[0]) {
      const g = data.results[0];
      return {
        source: "google",
        address: g.formatted_address || address,
        lat: g.geometry.location.lat,
        lng: g.geometry.location.lng,
      };
    }
    return { error: data.status || "GEOCODE_FAILED", message: data.error_message || "" };
  } catch (e) {
    return { error: "NETWORK_ERROR", message: e.message };
  }
}

async function geocodeViaNominatim(address) {
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=0&q="
    + encodeURIComponent(address);
  try {
    const r = await fetch(url, {
      // Nominatim requires a User-Agent identifying the application
      headers: { "User-Agent": "SWFT-CRM/1.0 (https://goswft.com)" },
    });
    const data = await r.json();
    if (Array.isArray(data) && data[0]) {
      const g = data[0];
      return {
        source: "nominatim",
        address: g.display_name || address,
        lat: parseFloat(g.lat),
        lng: parseFloat(g.lon),
      };
    }
    return { error: "ZERO_RESULTS", message: "No match in OpenStreetMap" };
  } catch (e) {
    return { error: "NETWORK_ERROR", message: e.message };
  }
}

async function geocodeAddress(address) {
  // Try Google when configured
  const google = await geocodeViaGoogle(address);
  if (!google.error) return google;
  // ZERO_RESULTS is unlikely to be solved by the fallback — but try anyway
  // since Nominatim sometimes finds addresses Google misses.
  // For REQUEST_DENIED / NO_API_KEY / OVER_QUERY_LIMIT / NETWORK_ERROR,
  // fall through to OSM.
  const osm = await geocodeViaNominatim(address);
  if (!osm.error) return osm;
  // Both failed — return Google's error first since it's usually more actionable
  return google.error ? google : osm;
}

async function getKnockerName(req) {
  try {
    const teamSnap = await db.collection("team")
      .where("orgId", "==", req.orgId)
      .where("uid", "==", req.uid)
      .limit(1).get();
    if (!teamSnap.empty) {
      const t = teamSnap.docs[0].data();
      if (t.name) return t.name;
    }
    const userDoc = await db.collection("users").doc(req.uid).get();
    if (userDoc.exists) {
      const u = userDoc.data();
      return u.name || u.firstName || u.email || "Unknown";
    }
  } catch (_) {}
  return "Unknown";
}

// GET /api/doors — list all door knocks for this org
// Owners and users with `tracker.viewAll` see every door; others see only
// their own. Sorted newest-first by `updatedAt`.
router.get("/", async (req, res, next) => {
  try {
    const snap = await col().where("orgId", "==", req.orgId).get();
    let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const perms = req.userPermissions; // null = owner
    if (perms && !perms.has("tracker.viewAll")) {
      results = results.filter(r => r.userId === req.uid);
    }

    results.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    res.json(results);
  } catch (err) { next(err); }
});

// GET /api/doors/:id
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await col().doc(req.params.id).get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Door not found" });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) { next(err); }
});

// POST /api/doors — log a new door knock
// Captures timestamp server-side so timing is consistent regardless of
// device clock. Creates `visits[0]` automatically from the request.
router.post("/", async (req, res, next) => {
  try {
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    if (!validCoord(lat, lng)) {
      return res.status(400).json({ error: "Invalid latitude/longitude" });
    }

    const status = sanitizeStatus(req.body.status);
    const notes = clampStr(req.body.notes, 2000);
    const userName = await getKnockerName(req);
    const now = Date.now();

    const data = {
      orgId: req.orgId,
      userId: req.uid,
      userName,
      lat,
      lng,
      accuracy: Number.isFinite(Number(req.body.accuracy)) ? Number(req.body.accuracy) : null,
      address: clampStr(req.body.address, 300),
      name: clampStr(req.body.name, 120),
      phone: clampStr(req.body.phone, 40),
      email: clampStr(req.body.email, 200),
      notes,
      status,
      visits: [{
        ts: now,
        status,
        notes,
        by: req.uid,
        byName: userName,
      }],
      createdAt: now,
      updatedAt: now,
    };

    const ref = await col().add(data);
    res.status(201).json({ id: ref.id, ...data });
  } catch (err) { next(err); }
});

// POST /api/doors/bulk — bulk-create planned doors from addresses or pre-geocoded entries
// Body: { addresses: ["123 Main St", ...] }   (server-side geocodes each)
//   or: { entries:  [{ address, lat, lng }] } (already geocoded by caller)
// Each door starts with status='pending' and an empty visits[] so it shows
// as planned-but-not-yet-knocked. Capped at 200 per call.
router.post("/bulk", async (req, res, next) => {
  try {
    const rawAddresses = Array.isArray(req.body && req.body.addresses) ? req.body.addresses : [];
    const preGeocoded  = Array.isArray(req.body && req.body.entries)   ? req.body.entries   : [];

    const total = rawAddresses.length + preGeocoded.length;
    if (!total) return res.status(400).json({ error: "No addresses provided" });
    if (total > 200) return res.status(400).json({ error: "Too many addresses (max 200 per import)" });

    const userName = await getKnockerName(req);
    const now = Date.now();
    const valid = [];
    const failed = [];   // [{ address, error, message }]

    // 1) geocode raw addresses on the server
    let usedNominatim = false;  // OSM TOS = 1 req/sec; bump throttle once we hit it
    for (const raw of rawAddresses) {
      const address = clampStr(raw, 300);
      if (!address) { failed.push({ address: raw, error: "EMPTY", message: "Empty line" }); continue; }
      const r = await geocodeAddress(address);
      if (r.source === "nominatim") usedNominatim = true;
      if (r.error) {
        failed.push({ address, error: r.error, message: r.message });
      } else {
        valid.push({
          orgId: req.orgId,
          userId: req.uid,
          userName,
          lat: r.lat,
          lng: r.lng,
          accuracy: null,
          address: r.address,
          name: "", phone: "", email: "", notes: "",
          status: "pending",
          visits: [],
          createdAt: now,
          updatedAt: now,
        });
      }
      // Adaptive throttle: 1.1s for Nominatim (per their TOS), 100ms for Google
      await new Promise(res => setTimeout(res, usedNominatim ? 1100 : 100));
    }

    // 2) accept any pre-geocoded entries the client supplied
    for (const e of preGeocoded) {
      const lat = Number(e.lat);
      const lng = Number(e.lng);
      const address = clampStr(e.address, 300);
      if (!address) { failed.push({ address: "", error: "EMPTY" }); continue; }
      if (!validCoord(lat, lng)) { failed.push({ address, error: "INVALID_COORDS" }); continue; }
      valid.push({
        orgId: req.orgId,
        userId: req.uid,
        userName,
        lat, lng, accuracy: null, address,
        name: clampStr(e.name, 120),
        phone: clampStr(e.phone, 40),
        email: "",
        notes: clampStr(e.notes, 2000),
        status: "pending",
        visits: [],
        createdAt: now,
        updatedAt: now,
      });
    }

    if (!valid.length) {
      // Embed the first failure code in the error message so it survives
      // the apiFetch wrapper (which only forwards data.error to the client).
      const first = failed[0] || {};
      const code = first.error || "UNKNOWN";
      const detail = first.message ? `: ${first.message}` : "";
      return res.status(400).json({
        error: `Could not import any addresses [${code}]${detail}`,
        firstFailure: code,
        firstMessage: first.message || "",
        failed,
      });
    }

    // Firestore batched writes max 500 ops per batch — we cap at 200 so one batch is enough.
    const batch = db.batch();
    const created = [];
    for (const data of valid) {
      const ref = col().doc();
      batch.set(ref, data);
      created.push({ id: ref.id, ...data });
    }
    await batch.commit();

    res.status(201).json({
      created,
      count: created.length,
      failedCount: failed.length,
      failed,
    });
  } catch (err) { next(err); }
});

// POST /api/doors/:id/visit — log a return visit at an existing door
// Appends to `visits[]` and bumps top-level status + updatedAt.
router.post("/:id/visit", async (req, res, next) => {
  try {
    const ref = col().doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Door not found" });
    }

    const status = sanitizeStatus(req.body.status);
    const notes = clampStr(req.body.notes, 2000);
    const userName = await getKnockerName(req);
    const now = Date.now();

    const visit = {
      ts: now,
      status,
      notes,
      by: req.uid,
      byName: userName,
    };

    const existing = doc.data();
    const visits = Array.isArray(existing.visits) ? existing.visits.slice() : [];
    visits.push(visit);

    const update = {
      status,
      notes: notes || existing.notes || "",
      visits,
      updatedAt: now,
    };

    await ref.update(update);
    res.json({ id: doc.id, ...existing, ...update });
  } catch (err) { next(err); }
});

// PUT /api/doors/:id — update door details (name, phone, notes, status)
// Does NOT log a visit; use /visit for that.
router.put("/:id", async (req, res, next) => {
  try {
    const ref = col().doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Door not found" });
    }

    const update = { updatedAt: Date.now() };
    if (req.body.name != null)    update.name    = clampStr(req.body.name, 120);
    if (req.body.phone != null)   update.phone   = clampStr(req.body.phone, 40);
    if (req.body.email != null)   update.email   = clampStr(req.body.email, 200);
    if (req.body.notes != null)   update.notes   = clampStr(req.body.notes, 2000);
    if (req.body.address != null) update.address = clampStr(req.body.address, 300);
    if (req.body.status != null)  update.status  = sanitizeStatus(req.body.status);

    await ref.update(update);
    const fresh = await ref.get();
    res.json({ id: fresh.id, ...fresh.data() });
  } catch (err) { next(err); }
});

// DELETE /api/doors/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const ref = col().doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Door not found" });
    }
    await ref.delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/doors/stats/today — quick counts for the topbar KPIs
router.get("/stats/today", async (req, res, next) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const start = startOfDay.getTime();

    const snap = await col().where("orgId", "==", req.orgId).get();
    const docs = snap.docs.map(d => d.data());

    const perms = req.userPermissions;
    const filtered = (perms && !perms.has("tracker.viewAll"))
      ? docs.filter(d => d.userId === req.uid)
      : docs;

    let knocksToday = 0;
    const counts = { no_answer: 0, not_interested: 0, chatted: 0, come_back: 0, callback: 0, lead: 0, sale: 0 };
    for (const d of filtered) {
      const visits = Array.isArray(d.visits) ? d.visits : [];
      for (const v of visits) {
        if ((v.ts || 0) >= start) {
          knocksToday++;
          if (counts[v.status] != null) counts[v.status]++;
        }
      }
    }

    res.json({
      knocksToday,
      totalDoors: filtered.length,
      counts,
    });
  } catch (err) { next(err); }
});

module.exports = router;
