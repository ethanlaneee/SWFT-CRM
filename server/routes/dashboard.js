const router = require("express").Router();
const { db } = require("../firebase");

// GET /api/dashboard — aggregated stats
router.get("/", async (req, res, next) => {
  try {
    const [jobsSnap, quotesSnap, invoicesSnap, scheduleSnap] = await Promise.all([
      db.collection("jobs").where("orgId", "==", req.orgId).get(),
      db.collection("quotes").where("orgId", "==", req.orgId).get(),
      db.collection("invoices").where("orgId", "==", req.orgId).get(),
      db.collection("schedule").where("orgId", "==", req.orgId).get(),
    ]);

    const jobs = jobsSnap.docs.map(d => d.data());
    const invoices = invoicesSnap.docs.map(d => d.data());

    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    const today = new Date().toISOString().split("T")[0];
    const totalJobs = jobs.length;
    // Count both explicitly "active" AND scheduled jobs whose date has arrived
    const activeJobs = jobs.filter(j =>
      j.status !== "complete" && (
        j.status === "active" ||
        (j.scheduledDate && j.scheduledDate <= today)
      )
    ).length;
    const scheduledJobs = jobs.filter(j => j.status === "scheduled" && j.scheduledDate > today).length;
    const completedJobs = jobs.filter(j => j.status === "complete").length;

    const monthlyRevenue = invoices
      .filter(i => i.status === "paid" && i.paidAt && i.paidAt >= thirtyDaysAgo)
      .reduce((sum, i) => sum + (i.total || 0), 0);

    const totalRevenue = invoices
      .filter(i => i.status === "paid")
      .reduce((sum, i) => sum + (i.total || 0), 0);

    const activeQuotes = quotesSnap.docs.filter(d => {
      const s = d.data().status;
      return s === "draft" || s === "sent";
    }).length;

    const upcomingTasks = scheduleSnap.docs.filter(d => {
      const date = d.data().date;
      return date && date >= new Date().toISOString().split("T")[0];
    }).length;

    res.json({
      totalJobs,
      activeJobs,
      scheduledJobs,
      completedJobs,
      monthlyRevenue,
      totalRevenue,
      activeQuotes,
      upcomingTasks,
    });
  } catch (err) { next(err); }
});

module.exports = router;
