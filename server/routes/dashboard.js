const router = require("express").Router();
const { db } = require("../firebase");

// GET /api/dashboard — aggregated stats
router.get("/", async (req, res, next) => {
  try {
    const [jobsSnap, quotesSnap, invoicesSnap, scheduleSnap] = await Promise.all([
      db.collection("jobs").where("userId", "==", req.uid).get(),
      db.collection("quotes").where("userId", "==", req.uid).get(),
      db.collection("invoices").where("userId", "==", req.uid).get(),
      db.collection("schedule").where("userId", "==", req.uid).get(),
    ]);

    const jobs = jobsSnap.docs.map(d => d.data());
    const invoices = invoicesSnap.docs.map(d => d.data());

    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    const totalJobs = jobs.length;
    const activeJobs = jobs.filter(j => j.status === "active").length;
    const scheduledJobs = jobs.filter(j => j.status === "scheduled").length;
    const completedJobs = jobs.filter(j => j.status === "complete").length;

    const monthlyRevenue = invoices
      .filter(i => i.status === "paid" && i.paidAt >= thirtyDaysAgo)
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
