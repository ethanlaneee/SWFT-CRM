/**
 * Loads a structured snapshot of an org's current state for the CEO
 * agent to reason over. The snapshot is small + dense — every record
 * is summarized to a few key fields so the whole thing fits in a
 * single Claude prompt without blowing the token budget.
 *
 * The CEO agent reads this once at the start of each run and decides
 * what (if anything) the team should do.
 */

const { db } = require("../firebase");

const DAY = 86400000;

function summariseQuote(d, data) {
  return {
    id: d.id,
    customer_id: data.customerId || null,
    customer_name: data.customerName || "Customer",
    customer_email: data.customerEmail || data.email || null,
    service: data.service || "",
    total: Number(data.total) || 0,
    status: data.status || "draft",
    sent_at: data.sentAt || null,
    days_since_sent: data.sentAt ? Math.floor((Date.now() - data.sentAt) / DAY) : null,
  };
}

function summariseInvoice(d, data) {
  return {
    id: d.id,
    customer_id: data.customerId || null,
    customer_name: data.customerName || "Customer",
    customer_email: data.customerEmail || data.email || null,
    service: data.service || "",
    total: Number(data.total) || 0,
    status: data.status || "open",
    created_at: data.createdAt || null,
    due_date: data.dueDate || null,
    days_since_created: data.createdAt ? Math.floor((Date.now() - data.createdAt) / DAY) : null,
  };
}

function summariseJob(d, data) {
  return {
    id: d.id,
    customer_id: data.customerId || null,
    customer_name: data.customerName || "Customer",
    customer_email: data.customerEmail || data.email || null,
    service: data.service || "",
    status: data.status || "scheduled",
    completed_at: data.completedAt || null,
    days_since_completed: data.completedAt ? Math.floor((Date.now() - data.completedAt) / DAY) : null,
  };
}

function summariseLead(d, data, source) {
  return {
    id: d.id,
    source,                     // 'serviceRequest' or 'customer'
    customer_id: source === "customer" ? d.id : (data.customerId || null),
    customer_name: data.name || data.customerName || "Lead",
    customer_email: data.email || null,
    customer_phone: data.phone || null,
    service: data.service || "",
    created_at: data.createdAt || null,
    days_old: data.createdAt ? Math.floor((Date.now() - data.createdAt) / DAY) : null,
    tags: data.tags || [],
  };
}

function summariseMessage(d, data) {
  return {
    id: d.id,
    customer_id: data.customerId || null,
    customer_name: data.customerName || null,
    type: data.type || null,         // 'sms' | 'email' | 'facebook' | ...
    direction: data.direction || (data.from ? "in" : "out"),
    body: (data.body || "").slice(0, 280),
    sent_at: data.sentAt || data.receivedAt || data.createdAt || null,
  };
}

function summariseActivity(d) {
  const a = d.data();
  return {
    id: d.id,
    agent: a.agent || null,
    action: a.action || null,
    target_type: a.targetType || null,
    target_id: a.targetId || null,
    customer_name: a.customerName || null,
    subject: a.subject || null,
    reasoning: a.reasoning || null,
    created_at: a.createdAt || null,
  };
}

/**
 * Load the snapshot.
 *
 * @param {string} orgId
 * @returns {Promise<object>}  { businessName, openQuotes, unpaidInvoices,
 *                               recentlyCompletedJobs, leads,
 *                               recentInboundMessages, recentActivity }
 */
async function loadOrgSnapshot(orgId, uid) {
  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.exists ? userDoc.data() : {};
  const businessName = userData.company || userData.name || "the business";

  // ── Open quotes (status 'sent', not yet approved/declined) ───────────
  const quotesSnap = await db.collection("quotes")
    .where("orgId", "==", orgId)
    .where("status", "==", "sent")
    .get();
  const openQuotes = quotesSnap.docs.map(d => summariseQuote(d, d.data()));

  // ── Unpaid invoices (anything not 'paid' or 'draft') ─────────────────
  const invoicesSnap = await db.collection("invoices")
    .where("orgId", "==", orgId)
    .get();
  const unpaidInvoices = invoicesSnap.docs
    .filter(d => {
      const s = d.data().status;
      return s && s !== "paid" && s !== "draft";
    })
    .map(d => summariseInvoice(d, d.data()));

  // ── Recently completed jobs (within last 14 days) ────────────────────
  const cutoff = Date.now() - 14 * DAY;
  const jobsSnap = await db.collection("jobs")
    .where("orgId", "==", orgId)
    .get();
  const recentlyCompletedJobs = jobsSnap.docs
    .filter(d => {
      const j = d.data();
      const s = j.status;
      const isComplete = s === "complete" || s === "completed";
      const completedAt = j.completedAt || j.updatedAt || 0;
      return isComplete && completedAt >= cutoff;
    })
    .map(d => summariseJob(d, d.data()));

  // ── Leads: pending intake-form requests + lead-tagged customers ──────
  const [serviceReqsSnap, leadCustsSnap] = await Promise.all([
    db.collection("serviceRequests").where("orgId", "==", orgId).where("status", "==", "pending").get(),
    db.collection("customers").where("orgId", "==", orgId).where("tags", "array-contains-any", ["lead", "from doors"]).get(),
  ]);
  const leads = [
    ...serviceReqsSnap.docs.map(d => summariseLead(d, d.data(), "serviceRequest")),
    ...leadCustsSnap.docs.map(d => summariseLead(d, d.data(), "customer")),
  ];

  // ── Recent inbound messages waiting for a reply ──────────────────────
  let recentInboundMessages = [];
  try {
    const msgsSnap = await db.collection("messages")
      .where("orgId", "==", orgId)
      .orderBy("sentAt", "desc")
      .limit(20)
      .get();
    recentInboundMessages = msgsSnap.docs
      .map(d => summariseMessage(d, d.data()))
      .filter(m => m.direction === "in");
  } catch (_) { /* messages collection may not be indexed in some orgs */ }

  // ── Recent agent activity (so the CEO doesn't repeat itself) ─────────
  let recentActivity = [];
  try {
    const actSnap = await db.collection("orgs").doc(orgId).collection("agentActivity")
      .orderBy("createdAt", "desc")
      .limit(30)
      .get();
    recentActivity = actSnap.docs.map(summariseActivity);
  } catch (_) { /* activity log may not exist yet */ }

  return {
    business_name: businessName,
    today: new Date().toISOString().split("T")[0],
    open_quotes: openQuotes,
    unpaid_invoices: unpaidInvoices,
    recently_completed_jobs: recentlyCompletedJobs,
    leads,
    recent_inbound_messages: recentInboundMessages.slice(0, 10),
    recent_agent_activity: recentActivity,
    user_data: userData,    // not sent to Claude — used by tool layer for Gmail send
  };
}

module.exports = { loadOrgSnapshot };
