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

// ── Helper: normalize Firestore timestamp to ms ──
function normTs(val) {
  if (!val) return null;
  if (typeof val === "number") return val;
  if (val._seconds) return val._seconds * 1000;
  return new Date(val).getTime();
}

// ── GET /api/dev/stats — platform-wide aggregate metrics ──
// Platform totals are NOT computed here — they come from summing per-user
// counts in the /users endpoint so numbers are always consistent.
router.get("/stats", async (req, res, next) => {
  try {
    const usersSnap = await db.collection("users").get();
    const users = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    // ── User stats — mutually exclusive categories ──
    const totalUsers = users.length;
    const subscribedUsers = users.filter(u => u.isSubscribed).length;
    const trialUsers = users.filter(u => !u.isSubscribed && u.accountStatus === "trialing").length;
    const expiredUsers = users.filter(u => !u.isSubscribed && (u.accountStatus === "expired" || u.accountStatus === "canceled")).length;

    // ── Paid users from Stripe (actually paying > $0) ──
    let paidUsers = 0;
    let stripeMRR = 0;
    try {
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      let hasMore = true;
      let startingAfter = undefined;
      while (hasMore) {
        const params = { status: "active", limit: 100, expand: ["data.discount"] };
        if (startingAfter) params.starting_after = startingAfter;
        const subs = await stripe.subscriptions.list(params);
        for (const sub of subs.data) {
          let subTotal = 0;
          for (const item of sub.items.data) {
            const amount = item.price.unit_amount || 0; // cents
            const interval = item.price.recurring?.interval;
            if (interval === "year") subTotal += amount / 12;
            else subTotal += amount;
          }
          // Apply coupon discount if present
          if (sub.discount?.coupon) {
            const coupon = sub.discount.coupon;
            if (coupon.percent_off) subTotal = subTotal * (1 - coupon.percent_off / 100);
            else if (coupon.amount_off) subTotal = Math.max(0, subTotal - coupon.amount_off);
          }
          stripeMRR += subTotal;
          if (subTotal > 0) paidUsers++;
        }
        hasMore = subs.has_more;
        if (subs.data.length) startingAfter = subs.data[subs.data.length - 1].id;
      }
      stripeMRR = Math.round(stripeMRR) / 100; // cents → dollars
    } catch (_) { /* Stripe unavailable */ }

    // Plan breakdown
    const planBreakdown = {};
    users.forEach(u => {
      const plan = u.plan || "starter";
      planBreakdown[plan] = (planBreakdown[plan] || 0) + 1;
    });

    // Signups last 30 days
    const monthlySignups = users.filter(u => {
      const ts = normTs(u.createdAt);
      return ts && ts >= thirtyDaysAgo;
    }).length;

    // Trial conversion rate
    const convertedFromTrial = users.filter(u => u.isSubscribed && u.trialStartDate).length;
    const totalEverTrialed = users.filter(u => u.trialStartDate).length;
    const trialConversionRate = totalEverTrialed > 0
      ? Math.round((convertedFromTrial / totalEverTrialed) * 100)
      : 0;

    res.json({
      users: { total: totalUsers, subscribed: subscribedUsers, paid: paidUsers, trial: trialUsers, expired: expiredUsers, monthlySignups, trialConversionRate },
      plans: planBreakdown,
      revenue: { stripeMRR },
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
      let customerCount = 0, jobCount = 0, quoteCount = 0, invoiceCount = 0;
      try {
        const orgId = data.orgId || uid;
        const [custSnap, jobSnap, quoteSnap, invSnap] = await Promise.all([
          db.collection("customers").where("orgId", "==", orgId).get(),
          db.collection("jobs").where("orgId", "==", orgId).get(),
          db.collection("quotes").where("orgId", "==", orgId).get(),
          db.collection("invoices").where("orgId", "==", orgId).get(),
        ]);
        customerCount = custSnap.size;
        jobCount = jobSnap.size;
        quoteCount = quoteSnap.size;
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
        counts: { customers: customerCount, jobs: jobCount, quotes: quoteCount, invoices: invoiceCount },
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

// ── GET /api/dev/outreach — combined outreach campaign data ──
router.get("/outreach", async (req, res, next) => {
  try {
    const [leadsSnap, emailsSnap] = await Promise.all([
      db.collection("outreach_leads").orderBy("createdAt", "desc").limit(500).get(),
      db.collection("outreach_emails").orderBy("createdAt", "desc").limit(500).get(),
    ]);

    const leads = leadsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const emails = emailsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const drafts = emails.filter(e => e.status === "draft");
    const scoredLeads = leads.filter(l => l.score != null);
    const avgScore = scoredLeads.length > 0
      ? Math.round(scoredLeads.reduce((sum, l) => sum + l.score, 0) / scoredLeads.length)
      : 0;

    res.json({
      stats: {
        leads: {
          total: leads.length,
          new: leads.filter(l => l.status === "new").length,
          scored: leads.filter(l => l.status === "scored").length,
          drafted: leads.filter(l => l.status === "drafted").length,
          emailed: leads.filter(l => l.status === "emailed").length,
          replied: leads.filter(l => l.status === "replied").length,
          converted: leads.filter(l => l.status === "converted").length,
          unsubscribed: leads.filter(l => l.status === "unsubscribed").length,
          avgScore,
        },
        emails: {
          total: emails.length,
          drafts: drafts.length,
          sent: emails.filter(e => e.status === "sent").length,
          rejected: emails.filter(e => e.status === "rejected").length,
        },
      },
      leads,
      drafts,
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
