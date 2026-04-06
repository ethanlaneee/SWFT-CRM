/**
 * SWFT — Follow-up Agent
 *
 * Background worker that scans for items needing follow-up and creates
 * scheduled follow-up messages. Runs on a 60-second interval.
 *
 * Handles four follow-up types:
 *   1. Unsigned quotes  — sent quotes not yet approved (Day 1, 3, 7)
 *   2. Overdue invoices — sent invoices past due date (Day 1, 3, 7)
 *   3. Review requests  — completed jobs (24h after completion)
 *   4. Re-engagement    — inactive customers (12 months, no jobs)
 *
 * Follow-up records stored at: followups/{docId}
 * Agent config stored at:      orgs/{orgId}/agentConfigs/followup
 */

const { db } = require("../firebase");
const { sendSms } = require("../twilio");
const { getPlan } = require("../plans");
const { getUsage, incrementSms } = require("../usage");
const { google } = require("googleapis");

/**
 * Get the next 9:00 AM Eastern Time timestamp.
 * Server runs in UTC, so we calculate 9 AM ET properly.
 */
function nextNineAm() {
  // Build "now" in Eastern time using Intl
  const eastern = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());

  const parts = {};
  eastern.forEach(p => { parts[p.type] = p.value; });
  const etHour = parseInt(parts.hour, 10);
  const etNow = new Date(`${parts.year}-${parts.month}-${parts.day}T09:00:00`);

  // Convert 9 AM ET to UTC: figure out the current ET→UTC offset
  const utcNow = new Date();
  const etString = utcNow.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(etString);
  const offsetMs = utcNow.getTime() - etDate.getTime();

  // Target 9 AM ET today, converted to UTC
  const todayStr = `${parts.year}-${parts.month}-${parts.day}T09:00:00`;
  let target = new Date(todayStr).getTime() + offsetMs;

  // If 9 AM ET already passed today, schedule for tomorrow
  if (target <= Date.now()) {
    target += 24 * 60 * 60 * 1000;
  }
  return target;
}

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "https://goswft.com/api/auth/google/callback";

async function sendFollowupEmail(ownerUid, toEmail, subject, body) {
  const userDoc = await db.collection("users").doc(ownerUid).get();
  if (!userDoc.exists) return;
  const userData = userDoc.data();
  const gmail = userData.integrations?.gmail;
  const tokens = gmail?.tokens || userData.gmailTokens;
  const connected = gmail?.connected || userData.gmailConnected;
  if (!connected || !tokens) return; // Gmail not connected — skip silently

  const client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  client.setCredentials(tokens);

  const gmailApi = google.gmail({ version: "v1", auth: client });
  const raw = Buffer.from(
    `To: ${toEmail}\r\n` +
    `Subject: ${subject}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
    body
  ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  await gmailApi.users.messages.send({ userId: "me", requestBody: { raw } });
  console.log(`[followup-agent] Email sent to ${toEmail}: ${subject}`);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Helpers ──

function daysAgo(ms) {
  return Math.floor((Date.now() - ms) / DAY_MS);
}

/**
 * Get the follow-up agent config for an org. Returns null if disabled.
 */
async function getFollowupConfig(orgId) {
  const doc = await db.collection("orgs").doc(orgId).collection("agentConfigs").doc("followup").get();
  if (!doc.exists) return null;
  const config = doc.data();
  if (!config.enabled) return null;
  return config;
}

/**
 * Get the org owner's UID and user data.
 */
async function getOrgOwner(orgId) {
  const snap = await db.collection("users")
    .where("orgId", "==", orgId)
    .where("role", "==", "owner")
    .limit(1)
    .get();
  if (!snap.empty) {
    return { uid: snap.docs[0].id, user: snap.docs[0].data() };
  }
  // Fallback: orgId might be the owner's uid
  const doc = await db.collection("users").doc(orgId).get();
  if (doc.exists) return { uid: orgId, user: doc.data() };
  return null;
}

/**
 * Check if a follow-up already exists for a target.
 */
async function followupExists(orgId, type, targetId, step) {
  const snap = await db.collection("followups")
    .where("orgId", "==", orgId)
    .where("type", "==", type)
    .where("targetId", "==", targetId)
    .where("step", "==", step)
    .limit(1)
    .get();
  return !snap.empty;
}

/**
 * Create a follow-up record and mark it pending.
 */
async function createFollowup(data) {
  const ref = await db.collection("followups").add({
    ...data,
    status: "pending",
    createdAt: Date.now(),
  });
  return ref.id;
}

/**
 * Log an agent activity entry (shown in the UI activity feed).
 */
async function logActivity(orgId, entry) {
  await db.collection("orgs").doc(orgId).collection("agentActivity").add({
    agent: "followup",
    ...entry,
    createdAt: Date.now(),
  });
}

// ════════════════════════════════════════════════
// SCANNER — finds items that need follow-ups
// ════════════════════════════════════════════════

/**
 * Scan all orgs with follow-up agent enabled and create pending follow-ups.
 */
async function scanForFollowups() {
  // Find all orgs with follow-up agent enabled
  const orgsSnap = await db.collectionGroup("agentConfigs")
    .where("enabled", "==", true)
    .get();

  const orgIds = new Set();
  for (const doc of orgsSnap.docs) {
    if (doc.id === "followup") {
      orgIds.add(doc.ref.parent.parent.id);
    }
  }

  if (!orgIds.size) return;

  for (const orgId of orgIds) {
    try {
      const config = await getFollowupConfig(orgId);
      if (!config) continue;

      await scanUnsignedQuotes(orgId, config);
      await scanOverdueInvoices(orgId, config);
      await scanReviewRequests(orgId, config);
    } catch (err) {
      console.error(`[followup-agent] Scan error for org ${orgId}:`, err.message);
    }
  }
}

/**
 * Scan for sent quotes that haven't been approved.
 */
async function scanUnsignedQuotes(orgId, config) {
  const days = config.unsignedQuoteDays || [1, 3, 7];
  const snap = await db.collection("quotes")
    .where("orgId", "==", orgId)
    .where("status", "==", "sent")
    .get();

  for (const doc of snap.docs) {
    const quote = doc.data();
    if (!quote.sentAt || !quote.customerId) continue;

    const daysSinceSent = daysAgo(quote.sentAt);

    for (const day of days) {
      if (daysSinceSent >= day) {
        const step = `quote_day${day}`;
        const exists = await followupExists(orgId, "unsigned_quote", doc.id, step);
        if (exists) continue;

        // Get customer phone
        const custDoc = await db.collection("customers").doc(quote.customerId).get();
        if (!custDoc.exists) continue;
        const customer = custDoc.data();
        if (!customer.phone) continue;

        const message = buildQuoteFollowup(customer, quote, day);
        await createFollowup({
          orgId,
          type: "unsigned_quote",
          targetId: doc.id,
          customerId: quote.customerId,
          customerName: quote.customerName || customer.name || "",
          phone: customer.phone || null,
          email: customer.email || null,
          step,
          message,
          sendAt: nextNineAm(),
        });
      }
    }
  }
}

/**
 * Scan for invoices past due date.
 */
async function scanOverdueInvoices(orgId, config) {
  const days = config.overdueInvoiceDays || [1, 3, 7];
  const snap = await db.collection("invoices")
    .where("orgId", "==", orgId)
    .where("status", "in", ["open", "sent"])
    .get();

  for (const doc of snap.docs) {
    const invoice = doc.data();
    if (!invoice.dueDate || !invoice.customerId) continue;

    const daysPastDue = daysAgo(invoice.dueDate);
    if (daysPastDue < 1) continue; // Not overdue yet

    for (const day of days) {
      if (daysPastDue >= day) {
        const step = `invoice_day${day}`;
        const exists = await followupExists(orgId, "overdue_invoice", doc.id, step);
        if (exists) continue;

        const custDoc = await db.collection("customers").doc(invoice.customerId).get();
        if (!custDoc.exists) continue;
        const customer = custDoc.data();
        if (!customer.phone) continue;

        const message = buildInvoiceFollowup(customer, invoice, day);
        await createFollowup({
          orgId,
          type: "overdue_invoice",
          targetId: doc.id,
          customerId: invoice.customerId,
          customerName: invoice.customerName || customer.name || "",
          phone: customer.phone || null,
          email: customer.email || null,
          step,
          message,
          total: invoice.total || 0,
          sendAt: nextNineAm(),
        });
      }
    }
  }
}

/**
 * Scan for completed jobs needing a review request.
 */
async function scanReviewRequests(orgId, config) {
  const delayHours = config.reviewRequestDelay || 24;
  const delayMs = delayHours * 60 * 60 * 1000;
  const cutoff = Date.now() - delayMs;

  const snap = await db.collection("jobs")
    .where("orgId", "==", orgId)
    .where("status", "==", "complete")
    .get();

  for (const doc of snap.docs) {
    const job = doc.data();
    if (!job.completedAt || !job.customerId) continue;
    if (job.completedAt > cutoff) continue; // Not enough time has passed

    const step = "review_request";
    const exists = await followupExists(orgId, "review_request", doc.id, step);
    if (exists) continue;

    const custDoc = await db.collection("customers").doc(job.customerId).get();
    if (!custDoc.exists) continue;
    const customer = custDoc.data();
    if (!customer.phone) continue;

    // Get owner info for the review message
    const owner = await getOrgOwner(orgId);
    const companyName = owner?.user?.company || "our team";
    const reviewLink = owner?.user?.googleReviewLink || "";

    const message = buildReviewRequest(customer, job, companyName, reviewLink, config);
    await createFollowup({
      orgId,
      type: "review_request",
      targetId: doc.id,
      customerId: job.customerId,
      customerName: job.customerName || customer.name || "",
      phone: customer.phone || null,
      email: customer.email || null,
      step,
      message,
      sendAt: nextNineAm(),
    });
  }
}

// ════════════════════════════════════════════════
// SENDER — processes pending follow-ups
// ════════════════════════════════════════════════

/**
 * Process all pending follow-up messages that are ready to send.
 */
async function processFollowups() {
  const now = Date.now();

  const pendingSnap = await db.collection("followups")
    .where("status", "==", "pending")
    .where("sendAt", "<=", now)
    .limit(20)
    .get();

  const retrySnap = await db.collection("followups")
    .where("status", "==", "retrying")
    .where("retryAfter", "<=", now)
    .limit(10)
    .get();

  const allDocs = [...pendingSnap.docs, ...retrySnap.docs];
  if (!allDocs.length) return;

  console.log(`[followup-agent] Processing ${allDocs.length} follow-ups`);

  for (const fDoc of allDocs) {
    const followup = fDoc.data();
    const ref = fDoc.ref;
    const retryCount = followup.retryCount || 0;

    try {
      // Check if agent is still enabled
      const config = await getFollowupConfig(followup.orgId);
      if (!config) {
        await ref.update({ status: "skipped", updatedAt: Date.now() });
        continue;
      }

      // Check if the target item's status has changed (e.g., quote approved, invoice paid)
      const shouldSkip = await targetResolved(followup);
      if (shouldSkip) {
        await ref.update({ status: "skipped", reason: "resolved", updatedAt: Date.now() });
        continue;
      }

      // Get owner for SMS limits
      const owner = await getOrgOwner(followup.orgId);
      if (!owner) throw new Error("No org owner found");

      // Check SMS limit
      const plan = getPlan(owner.user.plan);
      const usage = await getUsage(owner.uid);
      if (usage.smsCount >= plan.smsLimit) {
        console.log(`[followup-agent] SMS limit reached for org ${followup.orgId}, skipping`);
        await ref.update({ status: "skipped", reason: "sms_limit", updatedAt: Date.now() });
        continue;
      }

      // Send SMS (if phone on file)
      if (followup.phone) {
        await sendSms(followup.phone, followup.message);
        await incrementSms(owner.uid);
      }

      // Send email (if email on file and Gmail connected)
      if (followup.email) {
        const subject = buildEmailSubject(followup.type);
        try {
          await sendFollowupEmail(owner.uid, followup.email, subject, followup.message);
        } catch (emailErr) {
          console.error(`[followup-agent] Email failed for ${fDoc.id}:`, emailErr.message);
        }
      }

      // Mark as sent
      await ref.update({ status: "sent", sentAt: Date.now(), error: null });

      // Create message record for chat thread visibility
      await db.collection("messages").add({
        userId: owner.uid,
        orgId: followup.orgId,
        to: followup.phone,
        body: followup.message,
        customerId: followup.customerId || "",
        customerName: followup.customerName || "",
        type: "sms",
        status: "sent",
        sentVia: "twilio",
        sentAt: Date.now(),
        isFollowup: true,
        followupId: fDoc.id,
        followupType: followup.type,
      });

      // Log activity
      await logActivity(followup.orgId, {
        type: followup.type,
        targetId: followup.targetId,
        customerId: followup.customerId,
        customerName: followup.customerName,
        step: followup.step,
        total: followup.total || null,
      });

      console.log(`[followup-agent] Sent ${fDoc.id} (${followup.type}/${followup.step}) to ${followup.phone}`);

    } catch (err) {
      console.error(`[followup-agent] Failed ${fDoc.id} (attempt ${retryCount + 1}):`, err.message);

      if (retryCount < 2) {
        const backoffMs = retryCount === 0 ? 60000 : 300000;
        await ref.update({
          status: "retrying",
          retryCount: retryCount + 1,
          retryAfter: Date.now() + backoffMs,
          lastAttempt: Date.now(),
          error: err.message,
        });
      } else {
        await ref.update({
          status: "failed",
          lastAttempt: Date.now(),
          error: err.message,
        });
      }
    }
  }
}

/**
 * Check if the follow-up target has been resolved (no longer needs follow-up).
 */
async function targetResolved(followup) {
  if (followup.type === "unsigned_quote") {
    const doc = await db.collection("quotes").doc(followup.targetId).get();
    if (!doc.exists) return true;
    return doc.data().status === "approved";
  }
  if (followup.type === "overdue_invoice") {
    const doc = await db.collection("invoices").doc(followup.targetId).get();
    if (!doc.exists) return true;
    return doc.data().status === "paid";
  }
  // Review requests and re-engagement don't have a "resolved" state
  return false;
}

// ════════════════════════════════════════════════
// MESSAGE TEMPLATES
// ════════════════════════════════════════════════

function firstName(customer) {
  return (customer.name || "").split(" ")[0] || "there";
}

function formatMoney(amount) {
  return "$" + Number(amount || 0).toLocaleString("en-US", { minimumFractionDigits: 0 });
}

function buildQuoteFollowup(customer, quote, day) {
  const name = firstName(customer);
  const total = formatMoney(quote.total);
  if (day <= 1) {
    return `Hey ${name}, just following up on the ${total} quote we sent over. Any questions or want to move forward? Happy to chat!`;
  }
  if (day <= 3) {
    return `Hi ${name}, wanted to check in on your quote for ${total}. We'd love to get you on the schedule - let me know if you have any questions!`;
  }
  return `Hey ${name}, circling back one more time on your ${total} quote. If you're still interested, we can lock in your spot this week. Just let us know!`;
}

function buildInvoiceFollowup(customer, invoice, day) {
  const name = firstName(customer);
  const total = formatMoney(invoice.total);
  if (day <= 1) {
    return `Hi ${name}, friendly reminder that your ${total} invoice is due. Let us know if you have any questions about payment!`;
  }
  if (day <= 3) {
    return `Hey ${name}, just checking in on the ${total} invoice. If there's an issue, happy to work something out. Just reply here!`;
  }
  return `Hi ${name}, your ${total} invoice is now ${day} days past due. Please let us know if there's anything we can help with regarding payment.`;
}

function buildEmailSubject(type) {
  if (type === "unsigned_quote") return "Following up on your quote";
  if (type === "overdue_invoice") return "Invoice payment reminder";
  if (type === "review_request") return "How did we do?";
  return "Following up";
}

function buildReviewRequest(customer, job, companyName, reviewLink, config) {
  // Use custom template if provided in config
  if (config.reviewMessage) {
    return config.reviewMessage
      .replace("{firstName}", firstName(customer))
      .replace("{service}", job.service || job.title || "your project")
      .replace("{address}", job.address || "your property")
      .replace("{reviewLink}", reviewLink || "")
      .replace("{company}", companyName);
  }
  const name = firstName(customer);
  const service = job.service || job.title || "your project";
  let msg = `Hey ${name}! It was great working on ${service}. If you're happy with how it turned out, a quick Google review would mean a lot to us!`;
  if (reviewLink) msg += ` ${reviewLink}`;
  return msg;
}

// ════════════════════════════════════════════════
// MAIN WORKER — called on interval
// ════════════════════════════════════════════════

/**
 * Main worker entry point. Scans for new follow-ups, then processes pending ones.
 */
async function runFollowupAgent() {
  try {
    await scanForFollowups();
  } catch (err) {
    console.error("[followup-agent] Scanner error:", err.message);
  }
  try {
    await processFollowups();
  } catch (err) {
    console.error("[followup-agent] Sender error:", err.message);
  }
}

module.exports = { runFollowupAgent, scanForFollowups, processFollowups, sendFollowupEmail };
