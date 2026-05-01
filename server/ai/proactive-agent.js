const Anthropic = require("@anthropic-ai/sdk");
const { db } = require("../firebase");

const client = new Anthropic();

// Defaults match the keys in routes/agents.js DEFAULTS. Each agent runs
// autonomously when enabled — there's no drafts-for-approval queue.
const DEFAULTS = {
  quote_followup:   { enabled: false, thresholdDays: 3 },
  invoice_followup: { enabled: false, thresholdDays: 7 },
  review_request:   { enabled: false, thresholdDays: 1 },
  lead_followup:    { enabled: false, thresholdDays: 1 },
};

// Read the per-org config for an agent. Falls back to DEFAULTS if the org
// hasn't configured this agent yet — newly added orgs get the default
// behavior automatically.
async function getAgentConfig(orgId, type) {
  try {
    const doc = await db.collection("orgs").doc(orgId).collection("agentConfigs").doc(type).get();
    return doc.exists ? { ...DEFAULTS[type], ...doc.data() } : { ...DEFAULTS[type] };
  } catch (_) {
    return { ...DEFAULTS[type] };
  }
}

// Append an entry to the agent activity log so the user can see what each
// agent has been doing. The Agents hub reads from here.
async function logActivity(orgId, entry) {
  try {
    await db.collection("orgs").doc(orgId).collection("agentActivity").add({
      ...entry,
      createdAt: Date.now(),
    });
  } catch (e) {
    console.warn("[proactive-agent] activity log failed:", e.message);
  }
}

// Skip targets we've already acted on so the hourly scan doesn't email the
// same customer over and over for the same quote/invoice/job. Checks both
// the activity log (new agent runs write here) and the legacy
// pendingAgentActions collection (kept for backward compat with the
// Agent Inbox dropdown).
async function alreadyHandled(orgId, targetId) {
  try {
    const actSnap = await db.collection("orgs").doc(orgId).collection("agentActivity")
      .where("targetId", "==", targetId)
      .limit(1)
      .get();
    if (!actSnap.empty) return true;
  } catch (_) { /* fall through */ }
  try {
    const snap = await db.collection("pendingAgentActions")
      .where("orgId", "==", orgId)
      .where("targetId", "==", targetId)
      .limit(1)
      .get();
    return !snap.empty;
  } catch (_) {
    return false;
  }
}

// How many reminders have we already sent for this target, and when was
// the most recent? Used by Payment Reminder for multi-stage chasing —
// after the first nudge we wait another full cycle before escalating.
async function sendCountFor(orgId, targetId) {
  try {
    const snap = await db.collection("orgs").doc(orgId).collection("agentActivity")
      .where("targetId", "==", targetId)
      .where("action", "==", "sent")
      .get();
    let lastSentAt = 0;
    snap.docs.forEach(d => {
      const ts = d.data().createdAt || 0;
      if (ts > lastSentAt) lastSentAt = ts;
    });
    return { count: snap.size, lastSentAt };
  } catch (_) {
    return { count: 0, lastSentAt: 0 };
  }
}

async function draftMessage(type, record, businessName) {
  // Payment reminders escalate over time. Stage 1 = gentle ping, stage 2
  // = firmer, stage 3 = final notice. After stage 3 the agent stops and
  // the owner takes it from there.
  const invoiceTone = record.stage === 3
    ? "FINAL notice tone — direct, short, says payment is significantly past due and that this is the last automated reminder. Respectful but firm."
    : record.stage === 2
    ? "Firmer tone than a first nudge — polite but clear that the invoice is overdue."
    : "Warm, gentle reminder tone — assume the customer just forgot.";

  const prompts = {
    quote_followup: `You are a friendly business assistant for ${businessName}. Write a short, warm follow-up email to a customer named "${record.customerName}" about quote #${record.quoteNum || record.id} for "${record.service || "services"}" totaling $${record.total || "TBD"}. The quote was sent ${Math.floor((Date.now() - record.sentAt) / 86400000)} days ago with no response. Ask if they have any questions and whether they'd like to move forward. Keep it under 4 sentences. Return JSON: {"subject":"...","body":"...","reasoning":"..."}`,

    invoice_followup: `You are a business assistant for ${businessName}. Write a payment reminder email to "${record.customerName}" about invoice #${record.invoiceNum || record.id} for $${record.total || "TBD"}, which has been open for ${Math.floor((Date.now() - record.createdAt) / 86400000)} days. Tone: ${invoiceTone} This is reminder #${record.stage} of up to 3. Keep it under 4 sentences. Return JSON: {"subject":"...","body":"...","reasoning":"..."}`,

    review_request: `You are a friendly business assistant for ${businessName}. Write a short, genuine email to a customer named "${record.customerName}" who recently had a job completed (${record.service || "service"}). Thank them for their business and kindly ask them to leave a Google review. Keep it under 4 sentences. Return JSON: {"subject":"...","body":"...","reasoning":"..."}`,

    lead_followup: `You are a sales-conscious business assistant for ${businessName}. Write a short, warm intro/follow-up email to a prospective customer named "${record.customerName}" who reached out about ${record.service ? `"${record.service}"` : "your services"} ${Math.floor((Date.now() - record.firstContactAt) / 86400000)} days ago and hasn't gotten a quote yet. Acknowledge their interest, ask if they'd like to schedule a quote or have questions, and keep it under 4 sentences. Return JSON: {"subject":"...","body":"...","reasoning":"..."}`,
  };

  const resp = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    messages: [{ role: "user", content: prompts[type] }],
  });

  const text = resp.content[0]?.text || "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

// Send the email through the org owner's Gmail and log a 'sent' activity
// entry. Agents are autonomous: if they're enabled, they act. No
// drafts-for-approval queue. Caller has already verified config.enabled.
async function dispatch(orgId, uid, userData, type, action, draft) {
  if (!userData.gmailConnected || !userData.gmailTokens) {
    await logActivity(orgId, {
      agent: type, action: "errored",
      targetType: action.targetType, targetId: action.targetId,
      customerName: action.customerName, recipientEmail: action.recipientEmail,
      subject: draft.subject, errorMessage: "Gmail not connected — cannot send",
    });
    return { errored: "no_gmail" };
  }
  try {
    const { sendViaGmail } = require("../routes/messages");
    const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;white-space:pre-wrap;">${draft.body}</div>`;
    const userForSend = { ...userData, _uid: uid };
    await sendViaGmail(userForSend, action.recipientEmail, draft.subject, htmlBody, draft.body);
    await logActivity(orgId, {
      agent: type, action: "sent",
      targetType: action.targetType, targetId: action.targetId,
      customerId: action.customerId || null,
      customerName: action.customerName, recipientEmail: action.recipientEmail,
      subject: draft.subject, body: draft.body,
      reasoning: draft.reasoning || "",
    });
    return { sent: true };
  } catch (e) {
    console.error(`[proactive-agent] send ${type} failed:`, e.message);
    await logActivity(orgId, {
      agent: type, action: "errored",
      targetType: action.targetType, targetId: action.targetId,
      customerName: action.customerName, recipientEmail: action.recipientEmail,
      subject: draft.subject, errorMessage: e.message,
    });
    return { errored: e.message };
  }
}

async function scanAndDraft(orgId, uid) {
  let drafted = 0;
  let sent = 0;

  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.exists ? userDoc.data() : {};
  const businessName = userData.company || userData.name || "our business";

  const now = Date.now();

  // Each agent type: load config once, skip if disabled, otherwise scan its
  // target collection with the config's threshold.
  const cfgQuote   = await getAgentConfig(orgId, "quote_followup");
  const cfgInvoice = await getAgentConfig(orgId, "invoice_followup");
  const cfgReview  = await getAgentConfig(orgId, "review_request");

  // ── Quote follow-ups ──────────────────────────────────────────────────────
  if (cfgQuote.enabled) {
    const thresholdMs = (cfgQuote.thresholdDays || 3) * 86400000;
    try {
      const quotesSnap = await db.collection("quotes")
        .where("orgId", "==", orgId)
        .where("status", "==", "sent")
        .get();

      for (const doc of quotesSnap.docs) {
        const q = doc.data();
        const sentAt = q.sentAt || q.updatedAt || q.createdAt || 0;
        if ((now - sentAt) < thresholdMs) continue;
        if (!q.customerEmail && !q.email) continue;
        if (await alreadyHandled(orgId, doc.id)) continue;

        const draft = await draftMessage("quote_followup", { ...q, id: doc.id, sentAt }, businessName);
        if (!draft) continue;

        const result = await dispatch(orgId, uid, userData, "quote_followup", {
          targetId: doc.id, targetType: "quote",
          customerId: q.customerId || null, customerName: q.customerName || "Customer",
          recipientEmail: q.customerEmail || q.email,
        }, draft);
        if (result.sent) sent++;
        if (result.drafted) drafted++;
      }
    } catch (e) {
      console.error("[proactive-agent] Quote scan error:", e.message);
    }
  }

  // ── Invoice follow-ups (multi-stage chase) ───────────────────────────────
  // Stage 1: send first reminder once the invoice is `thresholdDays` overdue.
  // Stage 2: send a firmer one 7 days after stage 1.
  // Stage 3: send a final notice 7 days after stage 2.
  // After stage 3 the agent stops. The escalation lives in the prompt
  // (invoiceTone in draftMessage), so the same agent voices three different
  // tones over time.
  if (cfgInvoice.enabled) {
    const thresholdMs = (cfgInvoice.thresholdDays || 7) * 86400000;
    const escalateMs = 7 * 86400000;
    try {
      const invSnap = await db.collection("invoices")
        .where("orgId", "==", orgId)
        .where("status", "==", "open")
        .get();

      for (const doc of invSnap.docs) {
        const inv = doc.data();
        const createdAt = inv.createdAt || 0;
        if (!inv.customerEmail && !inv.email) continue;

        const { count, lastSentAt } = await sendCountFor(orgId, doc.id);
        if (count >= 3) continue;                              // capped — owner takes over
        if (count === 0 && (now - createdAt) < thresholdMs) continue;
        if (count > 0  && (now - lastSentAt) < escalateMs) continue;

        const stage = count + 1;
        const draft = await draftMessage("invoice_followup", { ...inv, id: doc.id, stage }, businessName);
        if (!draft) continue;

        const result = await dispatch(orgId, uid, userData, "invoice_followup", {
          targetId: doc.id, targetType: "invoice",
          customerId: inv.customerId || null, customerName: inv.customerName || "Customer",
          recipientEmail: inv.customerEmail || inv.email,
          stage,
        }, draft);
        if (result.sent) sent++;
      }
    } catch (e) {
      console.error("[proactive-agent] Invoice scan error:", e.message);
    }
  }

  // ── Review requests ───────────────────────────────────────────────────────
  if (cfgReview.enabled) {
    const thresholdMs = (cfgReview.thresholdDays || 1) * 86400000;
    const recencyWindow = 7 * 86400000; // ignore jobs completed > 7 days ago
    try {
      const jobsSnap = await db.collection("jobs")
        .where("orgId", "==", orgId)
        .where("status", "==", "completed")
        .get();

      for (const doc of jobsSnap.docs) {
        const job = doc.data();
        const completedAt = job.completedAt || job.updatedAt || 0;
        if (!completedAt) continue;
        if ((now - completedAt) < thresholdMs) continue;       // not old enough
        if ((now - completedAt) > recencyWindow) continue;      // too old to bother
        if (!job.customerEmail && !job.email) continue;
        if (await alreadyHandled(orgId, doc.id)) continue;

        const draft = await draftMessage("review_request", { ...job, id: doc.id }, businessName);
        if (!draft) continue;

        const result = await dispatch(orgId, uid, userData, "review_request", {
          targetId: doc.id, targetType: "job",
          customerId: job.customerId || null, customerName: job.customerName || "Customer",
          recipientEmail: job.customerEmail || job.email,
        }, draft);
        if (result.sent) sent++;
        if (result.drafted) drafted++;
      }
    } catch (e) {
      console.error("[proactive-agent] Job scan error:", e.message);
    }
  }

  // ── Lead follow-up ────────────────────────────────────────────────────────
  // Watches new leads in two places: pending serviceRequests (intake form
  // submissions waiting to be approved into customers) AND customers that
  // are tagged 'lead' or 'from doors' but have no jobs yet. Sends a single
  // warm intro/follow-up so the lead doesn't go cold.
  const cfgLead = await getAgentConfig(orgId, "lead_followup");
  if (cfgLead.enabled) {
    const thresholdMs = (cfgLead.thresholdDays || 1) * 86400000;
    try {
      // 1. Service requests still pending (form submitted, no quote yet)
      const srSnap = await db.collection("serviceRequests")
        .where("orgId", "==", orgId)
        .where("status", "==", "pending")
        .get();
      for (const doc of srSnap.docs) {
        const sr = doc.data();
        const firstContactAt = sr.createdAt || 0;
        if (!firstContactAt || (now - firstContactAt) < thresholdMs) continue;
        if (!sr.email) continue;
        if (await alreadyHandled(orgId, doc.id)) continue;

        const draft = await draftMessage("lead_followup", {
          customerName: sr.name || "there",
          service: sr.service || "",
          firstContactAt,
        }, businessName);
        if (!draft) continue;

        const result = await dispatch(orgId, uid, userData, "lead_followup", {
          targetId: doc.id, targetType: "serviceRequest",
          customerId: sr.customerId || null, customerName: sr.name || "Lead",
          recipientEmail: sr.email,
        }, draft);
        if (result.sent) sent++;
      }

      // 2. Customers tagged as leads with no jobs and no previous outreach
      const custSnap = await db.collection("customers")
        .where("orgId", "==", orgId)
        .where("tags", "array-contains-any", ["lead", "from doors"])
        .get();
      for (const doc of custSnap.docs) {
        const c = doc.data();
        const firstContactAt = c.createdAt || 0;
        if (!firstContactAt || (now - firstContactAt) < thresholdMs) continue;
        if (!c.email) continue;
        if (await alreadyHandled(orgId, doc.id)) continue;
        // Skip if customer already has a job — they're past the lead stage
        const jobsSnap = await db.collection("jobs")
          .where("orgId", "==", orgId)
          .where("customerId", "==", doc.id)
          .limit(1).get();
        if (!jobsSnap.empty) continue;

        const draft = await draftMessage("lead_followup", {
          customerName: c.name || "there",
          service: "",
          firstContactAt,
        }, businessName);
        if (!draft) continue;

        const result = await dispatch(orgId, uid, userData, "lead_followup", {
          targetId: doc.id, targetType: "customer",
          customerId: doc.id, customerName: c.name || "Lead",
          recipientEmail: c.email,
        }, draft);
        if (result.sent) sent++;
      }
    } catch (e) {
      console.error("[proactive-agent] Lead scan error:", e.message);
    }
  }

  return drafted + sent;
}

async function runProactiveAgentForAllOrgs() {
  try {
    const usersSnap = await db.collection("users")
      .where("accountStatus", "in", ["trial", "active"])
      .get();

    let total = 0;
    for (const doc of usersSnap.docs) {
      const uid = doc.id;
      const data = doc.data();
      if (data.orgId && data.orgId !== uid) continue;     // skip team members
      if (!data.gmailConnected || !data.gmailTokens) continue;

      try {
        const count = await scanAndDraft(uid, uid);
        if (count > 0) {
          console.log(`[proactive-agent] Processed ${count} actions for org ${uid}`);
          total += count;
        }
      } catch (e) {
        console.error(`[proactive-agent] Error for org ${uid}:`, e.message);
      }
    }

    if (total > 0) {
      console.log(`[proactive-agent] Total actions this run: ${total}`);
    }
  } catch (e) {
    console.error("[proactive-agent] Runner error:", e.message);
  }
}

module.exports = { scanAndDraft, runProactiveAgentForAllOrgs };
