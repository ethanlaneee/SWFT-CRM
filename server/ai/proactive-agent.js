const Anthropic = require("@anthropic-ai/sdk");
const { db } = require("../firebase");

const client = new Anthropic();

const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

async function hasPendingAction(orgId, targetId) {
  const snap = await db.collection("pendingAgentActions")
    .where("orgId", "==", orgId)
    .where("targetId", "==", targetId)
    .where("status", "==", "pending")
    .limit(1)
    .get();
  return !snap.empty;
}

async function draftMessage(type, record, businessName) {
  const prompts = {
    quote_followup: `You are a friendly business assistant for ${businessName}. Write a short, warm follow-up email to a customer named "${record.customerName}" about quote #${record.quoteNum || record.id} for "${record.service || "services"}" totaling $${record.total || "TBD"}. The quote was sent ${Math.floor((Date.now() - record.sentAt) / 86400000)} days ago with no response. Ask if they have any questions and whether they'd like to move forward. Keep it under 4 sentences. Return JSON: {"subject":"...","body":"...","reasoning":"..."}`,

    invoice_followup: `You are a friendly business assistant for ${businessName}. Write a short, polite payment reminder email to a customer named "${record.customerName}" about invoice #${record.invoiceNum || record.id} for $${record.total || "TBD"} that has been open for ${Math.floor((Date.now() - record.createdAt) / 86400000)} days. Be warm, not aggressive. Keep it under 4 sentences. Return JSON: {"subject":"...","body":"...","reasoning":"..."}`,

    review_request: `You are a friendly business assistant for ${businessName}. Write a short, genuine email to a customer named "${record.customerName}" who recently had a job completed (${record.service || "service"}). Thank them for their business and kindly ask them to leave a Google review. Keep it under 4 sentences. Return JSON: {"subject":"...","body":"...","reasoning":"..."}`,
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

async function scanAndDraft(orgId, uid) {
  let drafted = 0;

  // Load owner user doc for business name
  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.exists ? userDoc.data() : {};
  const businessName = userData.company || userData.name || "our business";

  const now = Date.now();

  // ── Quote follow-ups ──────────────────────────────────────────────────────
  try {
    const quotesSnap = await db.collection("quotes")
      .where("orgId", "==", orgId)
      .where("status", "==", "sent")
      .get();

    for (const doc of quotesSnap.docs) {
      const q = doc.data();
      const sentAt = q.sentAt || q.updatedAt || q.createdAt || 0;
      if ((now - sentAt) < THREE_DAYS) continue;
      if (!q.customerEmail && !q.email) continue;
      if (await hasPendingAction(orgId, doc.id)) continue;

      const draft = await draftMessage("quote_followup", {
        ...q, id: doc.id, sentAt,
      }, businessName);
      if (!draft) continue;

      await db.collection("pendingAgentActions").add({
        orgId, uid,
        type: "quote_followup",
        targetId: doc.id,
        targetType: "quote",
        customerId: q.customerId || null,
        customerName: q.customerName || "Customer",
        draftSubject: draft.subject,
        draftMessage: draft.body,
        channel: "email",
        recipientEmail: q.customerEmail || q.email,
        reasoning: draft.reasoning || "",
        status: "pending",
        createdAt: Date.now(),
      });
      drafted++;
    }
  } catch (e) {
    console.error("[proactive-agent] Quote scan error:", e.message);
  }

  // ── Invoice follow-ups ────────────────────────────────────────────────────
  try {
    const invSnap = await db.collection("invoices")
      .where("orgId", "==", orgId)
      .where("status", "==", "open")
      .get();

    for (const doc of invSnap.docs) {
      const inv = doc.data();
      const createdAt = inv.createdAt || 0;
      if ((now - createdAt) < SEVEN_DAYS) continue;
      if (!inv.customerEmail && !inv.email) continue;
      if (await hasPendingAction(orgId, doc.id)) continue;

      const draft = await draftMessage("invoice_followup", {
        ...inv, id: doc.id,
      }, businessName);
      if (!draft) continue;

      await db.collection("pendingAgentActions").add({
        orgId, uid,
        type: "invoice_followup",
        targetId: doc.id,
        targetType: "invoice",
        customerId: inv.customerId || null,
        customerName: inv.customerName || "Customer",
        draftSubject: draft.subject,
        draftMessage: draft.body,
        channel: "email",
        recipientEmail: inv.customerEmail || inv.email,
        reasoning: draft.reasoning || "",
        status: "pending",
        createdAt: Date.now(),
      });
      drafted++;
    }
  } catch (e) {
    console.error("[proactive-agent] Invoice scan error:", e.message);
  }

  // ── Review requests ───────────────────────────────────────────────────────
  try {
    const jobsSnap = await db.collection("jobs")
      .where("orgId", "==", orgId)
      .where("status", "==", "completed")
      .get();

    for (const doc of jobsSnap.docs) {
      const job = doc.data();
      const completedAt = job.completedAt || job.updatedAt || 0;
      if (!completedAt || (now - completedAt) > THREE_DAYS) continue;
      if (!job.customerEmail && !job.email) continue;
      if (await hasPendingAction(orgId, doc.id)) continue;

      // Check if we already sent a review request for this job (any status)
      const existing = await db.collection("pendingAgentActions")
        .where("orgId", "==", orgId)
        .where("targetId", "==", doc.id)
        .limit(1)
        .get();
      if (!existing.empty) continue;

      const draft = await draftMessage("review_request", {
        ...job, id: doc.id,
      }, businessName);
      if (!draft) continue;

      await db.collection("pendingAgentActions").add({
        orgId, uid,
        type: "review_request",
        targetId: doc.id,
        targetType: "job",
        customerId: job.customerId || null,
        customerName: job.customerName || "Customer",
        draftSubject: draft.subject,
        draftMessage: draft.body,
        channel: "email",
        recipientEmail: job.customerEmail || job.email,
        reasoning: draft.reasoning || "",
        status: "pending",
        createdAt: Date.now(),
      });
      drafted++;
    }
  } catch (e) {
    console.error("[proactive-agent] Job scan error:", e.message);
  }

  return drafted;
}

async function runProactiveAgentForAllOrgs() {
  try {
    // Find all org owners (users who are their own org)
    const usersSnap = await db.collection("users")
      .where("accountStatus", "in", ["trial", "active"])
      .get();

    let totalDrafted = 0;
    for (const doc of usersSnap.docs) {
      const uid = doc.id;
      const data = doc.data();
      // Skip team members — they share their owner's org
      if (data.orgId && data.orgId !== uid) continue;
      if (!data.gmailConnected || !data.gmailTokens) continue;

      try {
        const count = await scanAndDraft(uid, uid);
        if (count > 0) {
          console.log(`[proactive-agent] Drafted ${count} actions for org ${uid}`);
          totalDrafted += count;
        }
      } catch (e) {
        console.error(`[proactive-agent] Error for org ${uid}:`, e.message);
      }
    }

    if (totalDrafted > 0) {
      console.log(`[proactive-agent] Total new actions drafted: ${totalDrafted}`);
    }
  } catch (e) {
    console.error("[proactive-agent] Runner error:", e.message);
  }
}

module.exports = { scanAndDraft, runProactiveAgentForAllOrgs };
