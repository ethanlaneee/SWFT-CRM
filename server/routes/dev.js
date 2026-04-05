/**
 * SWFT CRM — Developer Dashboard API
 *
 * Admin-only endpoints that expose platform-wide stats:
 *   GET /api/dev/stats    → aggregate platform metrics
 *   GET /api/dev/users    → all user profiles + usage
 *   GET /api/dev/user/:id → single user deep-dive
 */

const router = require("express").Router();
const { db } = require("../firebase");
const { PLANS, getPlan } = require("../plans");

// ── Admin-only guard — only ethan@goswft.com can access ──
const DEV_EMAILS = ["ethan@goswft.com"];

router.use((req, res, next) => {
  if (!req.user?.email || !DEV_EMAILS.includes(req.user.email)) {
    return res.status(403).json({ error: "Access denied." });
  }
  next();
});

// ── Helper: current month key (YYYY-MM) ──
function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ── GET /api/dev/stats — platform-wide aggregate metrics ──
router.get("/stats", async (req, res, next) => {
  try {
    const [usersSnap, customersSnap, jobsSnap, quotesSnap, invoicesSnap] = await Promise.all([
      db.collection("users").get(),
      db.collection("customers").get(),
      db.collection("jobs").get(),
      db.collection("quotes").get(),
      db.collection("invoices").get(),
    ]);

    const users = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const jobs = jobsSnap.docs.map(d => d.data());
    const invoices = invoicesSnap.docs.map(d => d.data());

    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    // User stats — categories must be mutually exclusive and sum to totalUsers
    const totalUsers = users.length;
    const paidUsers = users.filter(u => u.isSubscribed).length;
    const trialUsers = users.filter(u => !u.isSubscribed && u.accountStatus === "trialing").length;
    const expiredUsers = users.filter(u => !u.isSubscribed && (u.accountStatus === "expired" || u.accountStatus === "canceled")).length;
    // "active" here means accountStatus is "active" but NOT subscribed (edge case — should not happen normally)
    const activeNotPaid = users.filter(u => !u.isSubscribed && u.accountStatus === "active").length;
    // Unknown = users that don't fit any bucket (no accountStatus set, etc.)
    const unknownUsers = totalUsers - paidUsers - trialUsers - expiredUsers - activeNotPaid;

    // Plan breakdown
    const planBreakdown = {};
    users.forEach(u => {
      const plan = u.plan || "starter";
      planBreakdown[plan] = (planBreakdown[plan] || 0) + 1;
    });

    // Signups last 7 days
    const recentSignups = users.filter(u => {
      const created = u.createdAt;
      if (!created) return false;
      const ts = typeof created === "number" ? created : created._seconds ? created._seconds * 1000 : new Date(created).getTime();
      return ts >= sevenDaysAgo;
    }).length;

    // Signups last 30 days
    const monthlySignups = users.filter(u => {
      const created = u.createdAt;
      if (!created) return false;
      const ts = typeof created === "number" ? created : created._seconds ? created._seconds * 1000 : new Date(created).getTime();
      return ts >= thirtyDaysAgo;
    }).length;

    // Platform data totals
    const totalCustomers = customersSnap.size;
    const totalJobs = jobsSnap.size;
    const totalQuotes = quotesSnap.size;
    const totalInvoices = invoicesSnap.size;

    // Job status breakdown
    const activeJobs = jobs.filter(j => j.status === "active").length;
    const scheduledJobs = jobs.filter(j => j.status === "scheduled").length;
    const completedJobs = jobs.filter(j => j.status === "complete").length;

    // Invoice / revenue stats
    const paidInvoices = invoices.filter(i => i.status === "paid");
    const totalRevenue = paidInvoices.reduce((sum, i) => sum + (i.total || 0), 0);
    const monthlyRevenue = paidInvoices
      .filter(i => {
        const ts = i.paidAt || 0;
        const paidTime = typeof ts === "number" ? ts : ts._seconds ? ts._seconds * 1000 : new Date(ts).getTime();
        return paidTime >= thirtyDaysAgo;
      })
      .reduce((sum, i) => sum + (i.total || 0), 0);

    // MRR from Stripe (real active subscriptions)
    let stripeMRR = 0;
    try {
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      let hasMore = true;
      let startingAfter = undefined;
      while (hasMore) {
        const params = { status: "active", limit: 100 };
        if (startingAfter) params.starting_after = startingAfter;
        const subs = await stripe.subscriptions.list(params);
        for (const sub of subs.data) {
          for (const item of sub.items.data) {
            const amount = item.price.unit_amount || 0; // cents
            const interval = item.price.recurring?.interval;
            // Normalize to monthly
            if (interval === "year") stripeMRR += amount / 12;
            else stripeMRR += amount; // monthly or default
          }
        }
        hasMore = subs.has_more;
        if (subs.data.length) startingAfter = subs.data[subs.data.length - 1].id;
      }
      stripeMRR = Math.round(stripeMRR) / 100; // cents → dollars
    } catch (_) { /* Stripe unavailable — leave at 0 */ }

    // Trial conversion rate
    const convertedFromTrial = users.filter(u => u.isSubscribed && u.trialStartDate).length;
    const totalEverTrialed = users.filter(u => u.trialStartDate).length;
    const trialConversionRate = totalEverTrialed > 0
      ? Math.round((convertedFromTrial / totalEverTrialed) * 100)
      : 0;

    res.json({
      users: { total: totalUsers, paid: paidUsers, trial: trialUsers, expired: expiredUsers, activeNotPaid, unknown: unknownUsers, recentSignups, monthlySignups, trialConversionRate },
      plans: planBreakdown,
      platform: { totalCustomers, totalJobs, totalQuotes, totalInvoices, activeJobs, scheduledJobs, completedJobs },
      revenue: { totalRevenue, monthlyRevenue, stripeMRR },
    });
  } catch (err) { next(err); }
});

// ── GET /api/dev/users — all users with usage ──
router.get("/users", async (req, res, next) => {
  try {
    const usersSnap = await db.collection("users").get();
    const mk = monthKey();

    const users = await Promise.all(usersSnap.docs.map(async (doc) => {
      const data = doc.data();
      const uid = doc.id;

      // Get current month usage
      let usage = { smsCount: 0, aiMessageCount: 0 };
      try {
        const usageDoc = await db.collection("usage").doc(uid).collection("months").doc(mk).get();
        if (usageDoc.exists) {
          const u = usageDoc.data();
          usage = { smsCount: u.smsCount || 0, aiMessageCount: u.aiMessageCount || 0 };
        }
      } catch (_) { /* ignore */ }

      // Count user's data
      let customerCount = 0, jobCount = 0, invoiceCount = 0;
      try {
        const orgId = data.orgId || uid;
        const [custSnap, jobSnap, invSnap] = await Promise.all([
          db.collection("customers").where("orgId", "==", orgId).get(),
          db.collection("jobs").where("orgId", "==", orgId).get(),
          db.collection("invoices").where("orgId", "==", orgId).get(),
        ]);
        customerCount = custSnap.size;
        jobCount = jobSnap.size;
        invoiceCount = invSnap.size;
      } catch (_) { /* ignore */ }

      // Normalize timestamps
      const createdAt = data.createdAt
        ? (typeof data.createdAt === "number" ? data.createdAt : data.createdAt._seconds ? data.createdAt._seconds * 1000 : new Date(data.createdAt).getTime())
        : null;

      const trialEndDate = data.trialEndDate
        ? (typeof data.trialEndDate === "number" ? data.trialEndDate : data.trialEndDate._seconds ? data.trialEndDate._seconds * 1000 : new Date(data.trialEndDate).getTime())
        : null;

      return {
        id: uid,
        name: data.name || null,
        email: data.email || null,
        company: data.company || null,
        phone: data.phone || null,
        plan: data.plan || "starter",
        accountStatus: data.accountStatus || "unknown",
        isSubscribed: !!data.isSubscribed,
        role: data.role || "owner",
        createdAt,
        trialEndDate,
        gmailConnected: !!data.gmailConnected,
        usage,
        counts: { customers: customerCount, jobs: jobCount, invoices: invoiceCount },
      };
    }));

    // Sort by createdAt descending (newest first)
    users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    res.json(users);
  } catch (err) { next(err); }
});

// ── GET /api/dev/user/:id — single user deep-dive ──
router.get("/user/:id", async (req, res, next) => {
  try {
    const uid = req.params.id;
    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

    const data = userDoc.data();
    const orgId = data.orgId || uid;
    const mk = monthKey();
    const plan = getPlan(data.plan);

    // Parallel fetch all related data
    const [usageDoc, custSnap, jobSnap, quoteSnap, invSnap, teamSnap, schedSnap, msgSnap] = await Promise.all([
      db.collection("usage").doc(uid).collection("months").doc(mk).get(),
      db.collection("customers").where("orgId", "==", orgId).get(),
      db.collection("jobs").where("orgId", "==", orgId).get(),
      db.collection("quotes").where("orgId", "==", orgId).get(),
      db.collection("invoices").where("orgId", "==", orgId).get(),
      db.collection("team").where("orgId", "==", orgId).get(),
      db.collection("schedule").where("orgId", "==", orgId).get(),
      db.collection("messages").doc(uid).collection("history").get().catch(() => ({ size: 0 })),
    ]);

    const usage = usageDoc.exists
      ? { smsCount: usageDoc.data().smsCount || 0, aiMessageCount: usageDoc.data().aiMessageCount || 0 }
      : { smsCount: 0, aiMessageCount: 0 };

    const invoices = invSnap.docs.map(d => d.data());
    const paidInvoices = invoices.filter(i => i.status === "paid");
    const totalRevenue = paidInvoices.reduce((sum, i) => sum + (i.total || 0), 0);

    const jobs = jobSnap.docs.map(d => d.data());

    // Normalize timestamps
    function normTs(val) {
      if (!val) return null;
      if (typeof val === "number") return val;
      if (val._seconds) return val._seconds * 1000;
      return new Date(val).getTime();
    }

    res.json({
      id: uid,
      name: data.name || null,
      email: data.email || null,
      phone: data.phone || null,
      company: data.company || null,
      address: data.address || null,
      website: data.website || null,
      role: data.role || "owner",
      plan: data.plan || "starter",
      accountStatus: data.accountStatus || "unknown",
      isSubscribed: !!data.isSubscribed,
      stripeCustomerId: data.stripeCustomerId || null,
      stripeSubscriptionId: data.stripeSubscriptionId || null,
      trialEndDate: normTs(data.trialEndDate),
      createdAt: normTs(data.createdAt),
      gmailConnected: !!data.gmailConnected,
      gmailAddress: data.gmailAddress || null,
      calendarConnected: !!data.calendarConnected,
      quickbooksConnected: !!data.quickbooksConnected,
      usage,
      planLimits: {
        sms: plan.smsLimit === Infinity ? "unlimited" : plan.smsLimit,
        aiMessages: plan.aiMessageLimit === Infinity ? "unlimited" : plan.aiMessageLimit,
      },
      counts: {
        customers: custSnap.size,
        jobs: jobSnap.size,
        quotes: quoteSnap.size,
        invoices: invSnap.size,
        team: teamSnap.size,
        schedule: schedSnap.size,
        messages: msgSnap.size || 0,
      },
      jobBreakdown: {
        active: jobs.filter(j => j.status === "active").length,
        scheduled: jobs.filter(j => j.status === "scheduled").length,
        complete: jobs.filter(j => j.status === "complete").length,
      },
      revenue: totalRevenue,
    });
  } catch (err) { next(err); }
});

// ── DELETE /api/dev/user/:id — permanently delete a user and all their data ──
router.delete("/user/:id", async (req, res, next) => {
  try {
    const uid = req.params.id;

    // Don't allow deleting yourself
    if (uid === req.uid) {
      return res.status(400).json({ error: "Cannot delete your own account from dev dashboard." });
    }

    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

    const data = userDoc.data();
    const orgId = data.orgId || uid;

    // Cancel Stripe subscription if active
    if (data.stripeSubscriptionId) {
      try {
        const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
        await stripe.subscriptions.cancel(data.stripeSubscriptionId);
      } catch (_) { /* subscription may already be canceled */ }
    }

    // Delete all org-scoped data
    const orgCollections = ["customers", "jobs", "quotes", "invoices", "schedule", "team"];
    for (const colName of orgCollections) {
      const snap = await db.collection(colName).where("orgId", "==", orgId).get();
      const batch = db.batch();
      snap.docs.forEach(doc => batch.delete(doc.ref));
      if (snap.docs.length > 0) await batch.commit();
    }

    // Delete usage subcollection
    try {
      const usageMonths = await db.collection("usage").doc(uid).collection("months").get();
      const batch = db.batch();
      usageMonths.docs.forEach(doc => batch.delete(doc.ref));
      if (usageMonths.docs.length > 0) await batch.commit();
      await db.collection("usage").doc(uid).delete();
    } catch (_) { /* may not exist */ }

    // Delete conversation history
    try {
      const convSnap = await db.collection("conversations").doc(uid).collection("messages").get();
      const batch = db.batch();
      convSnap.docs.forEach(doc => batch.delete(doc.ref));
      if (convSnap.docs.length > 0) await batch.commit();
      await db.collection("conversations").doc(uid).delete();
    } catch (_) { /* may not exist */ }

    // Delete notifications
    try {
      const notifSnap = await db.collection("notifications").doc(uid).collection("items").get();
      const batch = db.batch();
      notifSnap.docs.forEach(doc => batch.delete(doc.ref));
      if (notifSnap.docs.length > 0) await batch.commit();
      await db.collection("notifications").doc(uid).delete();
    } catch (_) { /* may not exist */ }

    // Delete messages subcollection
    try {
      const msgSnap = await db.collection("messages").doc(uid).collection("history").get();
      const batch = db.batch();
      msgSnap.docs.forEach(doc => batch.delete(doc.ref));
      if (msgSnap.docs.length > 0) await batch.commit();
      await db.collection("messages").doc(uid).delete();
    } catch (_) { /* may not exist */ }

    // Delete user profile
    await db.collection("users").doc(uid).delete();

    // Delete Firebase Auth account
    try {
      const { authAdmin } = require("../firebase");
      await authAdmin.deleteUser(uid);
    } catch (_) { /* auth may already be deleted */ }

    res.json({ success: true, message: "User and all data permanently deleted" });
  } catch (err) { next(err); }
});

module.exports = router;
