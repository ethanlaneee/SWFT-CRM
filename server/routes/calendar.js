// ════════════════════════════════════════════════
// ICS Calendar Feed — Apple Calendar subscription
// Public endpoint authenticated via a per-user token
// Subscribe URL: webcal://goswft.com/api/calendar/:token/feed.ics
// ════════════════════════════════════════════════

const router = require("express").Router();
const { db } = require("../firebase");
const crypto = require("crypto");

function escapeIcs(str) {
  return (str || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function formatIcsDate(ms) {
  const d = new Date(ms);
  return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function formatIcsDateOnly(str) {
  // str like "2026-04-10"
  return str.replace(/-/g, "");
}

// ── Generate or retrieve a calendar token for a user ──
async function tokenHandler(req, res) {
  try {
    const uid = req.uid;
    const userRef = db.collection("users").doc(uid);
    const snap = await userRef.get();
    const data = snap.exists ? snap.data() : {};

    if (data.calendarToken) {
      return res.json({ token: data.calendarToken });
    }

    const token = crypto.randomBytes(24).toString("hex");
    await userRef.set({ calendarToken: token }, { merge: true });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── ICS feed — public, authenticated by token ──
router.get("/:token/feed.ics", async (req, res) => {
  try {
    const { token } = req.params;

    // Find user by token
    const usersSnap = await db.collection("users").where("calendarToken", "==", token).limit(1).get();
    if (usersSnap.empty) return res.status(404).send("Calendar not found");

    const uid = usersSnap.docs[0].id;
    const userData = usersSnap.docs[0].data();
    const orgId = userData.orgId || uid;
    const companyName = userData.company || "SWFT";

    // Fetch jobs
    const jobsSnap = await db.collection("jobs")
      .where("orgId", "==", orgId)
      .get();

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//SWFT CRM//SWFT Calendar//EN",
      `X-WR-CALNAME:${escapeIcs(companyName)} Jobs`,
      "X-WR-TIMEZONE:America/Edmonton",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
      `X-PUBLISHED-TTL:PT1H`,
    ];

    for (const doc of jobsSnap.docs) {
      const job = doc.data();
      if (!job.scheduledDate && !job.date) continue;

      const dateStr = job.scheduledDate || job.date;
      const uid_str = `swft-job-${doc.id}@goswft.com`;
      const summary = escapeIcs(job.title || job.customerName || "Job");
      const location = escapeIcs(job.address || "");
      const description = escapeIcs([
        job.customerName ? `Customer: ${job.customerName}` : "",
        job.service ? `Service: ${job.service}` : "",
        job.status ? `Status: ${job.status}` : "",
        job.notes ? `Notes: ${job.notes}` : "",
      ].filter(Boolean).join("\\n"));

      const createdAt = job.createdAt ? formatIcsDate(job.createdAt) : formatIcsDate(Date.now());

      if (job.startTime && job.endTime) {
        const start = `${dateStr}T${job.startTime}:00`;
        const end = `${dateStr}T${job.endTime}:00`;
        lines.push("BEGIN:VEVENT");
        lines.push(`UID:${uid_str}`);
        lines.push(`DTSTAMP:${formatIcsDate(Date.now())}`);
        lines.push(`CREATED:${createdAt}`);
        lines.push(`DTSTART;TZID=America/Edmonton:${start.replace(/[-:]/g, "").replace("T", "T")}`);
        lines.push(`DTEND;TZID=America/Edmonton:${end.replace(/[-:]/g, "").replace("T", "T")}`);
        lines.push(`SUMMARY:${summary}`);
        if (location) lines.push(`LOCATION:${location}`);
        if (description) lines.push(`DESCRIPTION:${description}`);
        lines.push("END:VEVENT");
      } else {
        // All-day event
        lines.push("BEGIN:VEVENT");
        lines.push(`UID:${uid_str}`);
        lines.push(`DTSTAMP:${formatIcsDate(Date.now())}`);
        lines.push(`CREATED:${createdAt}`);
        lines.push(`DTSTART;VALUE=DATE:${formatIcsDateOnly(dateStr)}`);
        lines.push(`DTEND;VALUE=DATE:${formatIcsDateOnly(dateStr)}`);
        lines.push(`SUMMARY:${summary}`);
        if (location) lines.push(`LOCATION:${location}`);
        if (description) lines.push(`DESCRIPTION:${description}`);
        lines.push("END:VEVENT");
      }
    }

    lines.push("END:VCALENDAR");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="swft-jobs.ics"');
    res.send(lines.join("\r\n"));
  } catch (err) {
    console.error("ICS feed error:", err.message);
    res.status(500).send("Error generating calendar feed");
  }
});

module.exports = router;
module.exports.tokenHandler = tokenHandler;
