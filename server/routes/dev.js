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

    // Separate org owners from team members — team members don't own subscriptions
    const isTeamMember = u => u.orgId && u.orgId !== u.id;
    const orgOwners = users.filter(u => !isTeamMember(u));

    // ── User stats — org owners only ──
    const totalUsers = orgOwners.length;
    const subscribedUsers = orgOwners.filter(u => u.isSubscribed).length;
    const trialUsers = orgOwners.filter(u => !u.isSubscribed && u.accountStatus === "trialing").length;
    const expiredUsers = orgOwners.filter(u => !u.isSubscribed && (u.accountStatus === "expired" || u.accountStatus === "canceled")).length;

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

    // Plan breakdown — org owners only
    const planBreakdown = {};
    orgOwners.forEach(u => {
      const plan = u.plan || "starter";
      planBreakdown[plan] = (planBreakdown[plan] || 0) + 1;
    });

    // Signups last 30 days — org owners only
    const monthlySignups = orgOwners.filter(u => {
      const ts = normTs(u.createdAt);
      return ts && ts >= thirtyDaysAgo;
    }).length;

    // Trial conversion rate — org owners only
    const convertedFromTrial = orgOwners.filter(u => u.isSubscribed && u.trialStartDate).length;
    const totalEverTrialed = orgOwners.filter(u => u.trialStartDate).length;
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

      const isMember = data.orgId && data.orgId !== uid;
      return {
        id: uid,
        name: data.name || null,
        email: data.email || null,
        company: data.company || null,
        phone: data.phone || null,
        plan: isMember ? null : (data.plan || "starter"),
        accountStatus: data.accountStatus || "unknown",
        isSubscribed: isMember ? null : !!data.isSubscribed,
        role: data.role || "owner",
        orgId: data.orgId || null,
        accountType: data.accountType || null,
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

// ── POST /api/dev/user/:id/suspend — disable Firebase Auth (blocks all login) ──
router.post("/user/:id/suspend", async (req, res, next) => {
  try {
    const { authAdmin } = require("../firebase");
    await authAdmin.updateUser(req.params.id, { disabled: true });
    await db.collection("users").doc(req.params.id).set({ suspended: true, suspendedAt: Date.now() }, { merge: true });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/dev/user/:id/unsuspend — re-enable Firebase Auth ──
router.post("/user/:id/unsuspend", async (req, res, next) => {
  try {
    const { authAdmin } = require("../firebase");
    await authAdmin.updateUser(req.params.id, { disabled: false });
    await db.collection("users").doc(req.params.id).set({ suspended: false, suspendedAt: null }, { merge: true });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/dev/user/:id/signout — revoke all refresh tokens (force sign out) ──
router.post("/user/:id/signout", async (req, res, next) => {
  try {
    const { authAdmin } = require("../firebase");
    await authAdmin.revokeRefreshTokens(req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── PATCH /api/dev/user/:id — update user profile fields ──
router.patch("/user/:id", async (req, res, next) => {
  try {
    const uid = req.params.id;
    const { displayName, plan, smsLimit, aiLimit, adminNote } = req.body;
    const update = {};
    if (displayName !== undefined) update.displayName = displayName;
    if (plan !== undefined) update.plan = plan;
    if (smsLimit !== undefined) update.smsLimit = Number(smsLimit);
    if (aiLimit !== undefined) update.aiLimit = Number(aiLimit);
    if (adminNote !== undefined) update.adminNote = adminNote;
    update.updatedByAdmin = Date.now();
    await db.collection("users").doc(uid).set(update, { merge: true });
    // Sync displayName to Firebase Auth if provided
    if (displayName) {
      try {
        const { authAdmin } = require("../firebase");
        await authAdmin.updateUser(uid, { displayName });
      } catch (_) { /* non-fatal */ }
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/dev/resubscribe — remove an email from unsubscribes + ses_suppressions ──
// Body: { email, orgId? }  — if orgId omitted, removes across all orgs
router.post("/resubscribe", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const orgId = req.body.orgId ? String(req.body.orgId) : null;
    if (!email) return res.status(400).json({ error: "email required" });

    let unsubQuery = db.collection("unsubscribes").where("email", "==", email);
    if (orgId) unsubQuery = unsubQuery.where("orgId", "==", orgId);
    const unsubSnap = await unsubQuery.get();
    for (const doc of unsubSnap.docs) await doc.ref.delete();

    const suppressionId = Buffer.from(email).toString("hex").slice(0, 80);
    const suppressionRef = db.collection("ses_suppressions").doc(suppressionId);
    const suppressionDoc = await suppressionRef.get();
    let removedSuppression = false;
    if (suppressionDoc.exists) {
      await suppressionRef.delete();
      removedSuppression = true;
    }

    res.json({
      success: true,
      email,
      orgId,
      removedUnsubscribes: unsubSnap.size,
      removedSuppression,
    });
  } catch (err) { next(err); }
});

// ── POST /api/dev/users — create a new user account ──
router.post("/users", async (req, res, next) => {
  try {
    const { authAdmin, db } = require("../firebase");
    const { email, password, firstName, lastName, company, plan, accountStatus } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Valid email is required." });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    const name = [firstName, lastName].filter(Boolean).join(" ") || email.split("@")[0];

    // Create Firebase Auth account
    const authUser = await authAdmin.createUser({
      email,
      password,
      displayName: name,
    });

    const now = Date.now();
    const status = accountStatus || "trialing";
    const profile = {
      uid: authUser.uid,
      email,
      firstName: firstName || "",
      lastName: lastName || "",
      name,
      displayName: name,
      company: company || "",
      businessName: company || "",
      plan: plan || "starter",
      isSubscribed: status === "active",
      accountStatus: status,
      stripeCustomerId: "",
      trialStartDate: now,
      trialEndDate: now + 14 * 24 * 60 * 60 * 1000,
      role: "owner",
      orgId: authUser.uid,
      createdAt: now,
      updatedAt: now,
    };

    await db.collection("users").doc(authUser.uid).set(profile);
    res.json({ success: true, uid: authUser.uid, ...profile });
  } catch (err) {
    if (err.code === "auth/email-already-exists") {
      return res.status(400).json({ error: "An account with this email already exists." });
    }
    next(err);
  }
});

// ── Default cost rates (editable via dashboard, persisted to Firestore) ──
const DEFAULT_COST_SETTINGS = {
  fixed: {
    render: 0,            // Hobby plan = free
    domain: 1.25,         // ~$15/yr / 12
    firebase: 0,          // free tier estimate
    twilioPhone: 1.15,    // monthly per phone number
    elevenlabsBase: 0,    // pay-as-you-go
    vapiBase: 0,          // pay-as-you-go
  },
  rates: {
    anthropicPerMessage: 0.005,    // ~$5 per 1k AI messages (rough avg across Haiku+Sonnet)
    twilioPerSms: 0.0079,          // outbound US SMS
    sesPerThousandEmails: 0.10,    // SES outbound
    googleMapsMonthly: 0,          // covered by $200 free credit unless heavy
    stripePercent: 2.9,            // Stripe processing fee on subscriptions
    stripeFixedPerCharge: 0.30,
  },
};

router.get("/costs", async (req, res, next) => {
  try {
    // Load saved settings (or fall back to defaults)
    const settingsDoc = await db.collection("config").doc("costs").get();
    const saved = settingsDoc.exists ? settingsDoc.data() : {};
    const settings = {
      fixed: { ...DEFAULT_COST_SETTINGS.fixed, ...(saved.fixed || {}) },
      rates: { ...DEFAULT_COST_SETTINGS.rates, ...(saved.rates || {}) },
    };

    // Aggregate current-month usage across all users
    const mk = monthKey();
    const usersSnap = await db.collection("users").get();
    let totalAiMessages = 0;
    let totalSmsSent = 0;
    await Promise.all(usersSnap.docs.map(async (doc) => {
      try {
        const usageDoc = await db.collection("usage").doc(doc.id).collection("months").doc(mk).get();
        if (usageDoc.exists) {
          const u = usageDoc.data();
          totalAiMessages += u.aiMessageCount || 0;
          totalSmsSent += u.smsCount || 0;
        }
      } catch (_) {}
    }));

    // Broadcast emails this month (from messages collection)
    let totalBroadcasts = 0;
    try {
      const startOfMonth = new Date();
      startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
      const broadcastsSnap = await db.collection("messages")
        .where("type", "==", "email")
        .where("sentAt", ">=", startOfMonth.getTime())
        .get();
      totalBroadcasts = broadcastsSnap.docs.filter(d => d.data().broadcastId).length;
    } catch (_) {}

    // Stripe MRR + paying subscriptions count (mirrors /stats)
    let stripeMRR = 0;
    let payingSubscriptions = 0;
    try {
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      let hasMore = true;
      let startingAfter;
      while (hasMore) {
        const params = { status: "active", limit: 100, expand: ["data.discount"] };
        if (startingAfter) params.starting_after = startingAfter;
        const subs = await stripe.subscriptions.list(params);
        for (const sub of subs.data) {
          let subTotal = 0;
          for (const item of sub.items.data) {
            const amount = item.price.unit_amount || 0;
            const interval = item.price.recurring?.interval;
            if (interval === "year") subTotal += amount / 12;
            else subTotal += amount;
          }
          if (sub.discount?.coupon) {
            const coupon = sub.discount.coupon;
            if (coupon.percent_off) subTotal *= (1 - coupon.percent_off / 100);
            else if (coupon.amount_off) subTotal = Math.max(0, subTotal - coupon.amount_off);
          }
          stripeMRR += subTotal;
          if (subTotal > 0) payingSubscriptions++;
        }
        hasMore = subs.has_more;
        if (subs.data.length) startingAfter = subs.data[subs.data.length - 1].id;
      }
      stripeMRR = Math.round(stripeMRR) / 100;
    } catch (_) {}

    res.json({
      settings,
      usage: { totalAiMessages, totalSmsSent, totalBroadcasts, stripeMRR, payingSubscriptions },
    });
  } catch (err) { next(err); }
});

router.post("/costs", async (req, res, next) => {
  try {
    const { fixed, rates } = req.body || {};
    if (!fixed || !rates) return res.status(400).json({ error: "Missing fixed or rates" });
    await db.collection("config").doc("costs").set({ fixed, rates }, { merge: true });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
