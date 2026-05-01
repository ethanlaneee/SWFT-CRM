/**
 * Shared tools used by every autonomous agent (CEO + specialists).
 *
 * Each tool returns a stable JSON shape that's safe to feed back into
 * Claude's tool-use loop, and writes an entry to the org's
 * agentActivity log so the user can see exactly what was done and why.
 *
 * Agents pass the actor name (e.g. "CEO", "Admin", "Sales") so the
 * activity log can attribute every action to the right specialist.
 */

const { db } = require("../firebase");

async function logActivity(orgId, entry) {
  try {
    await db.collection("orgs").doc(orgId).collection("agentActivity").add({
      ...entry,
      createdAt: Date.now(),
    });
  } catch (e) {
    console.warn("[agent-tools] activity log failed:", e.message);
  }
}

// ── send_email ────────────────────────────────────────────────────────────
// Sends through the org owner's connected Gmail. Logs an "errored" entry
// if Gmail isn't connected so the user knows why nothing went out.
async function sendEmailTool({ orgId, uid, userData, actor }, args) {
  const { recipient_email, subject, body, target_type, target_id, customer_id, customer_name, reasoning } = args || {};
  if (!recipient_email || !subject || !body) {
    return { ok: false, error: "Missing recipient_email / subject / body" };
  }
  if (!userData.gmailConnected || !userData.gmailTokens) {
    await logActivity(orgId, {
      agent: actor || "agent", action: "errored", channel: "email",
      targetType: target_type || null, targetId: target_id || null,
      customerId: customer_id || null, customerName: customer_name || null,
      recipientEmail: recipient_email, subject, errorMessage: "Gmail not connected", reasoning,
    });
    return { ok: false, error: "Gmail not connected — enable in SWFT Connect." };
  }
  try {
    const { sendViaGmail } = require("../routes/messages");
    const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;white-space:pre-wrap;">${body}</div>`;
    const userForSend = { ...userData, _uid: uid };
    await sendViaGmail(userForSend, recipient_email, subject, htmlBody, body);
    await logActivity(orgId, {
      agent: actor || "agent", action: "sent", channel: "email",
      targetType: target_type || null, targetId: target_id || null,
      customerId: customer_id || null, customerName: customer_name || null,
      recipientEmail: recipient_email, subject, body, reasoning,
    });
    return { ok: true, channel: "email" };
  } catch (e) {
    console.error(`[agent-tools] send_email failed:`, e.message);
    await logActivity(orgId, {
      agent: actor || "agent", action: "errored", channel: "email",
      targetType: target_type || null, targetId: target_id || null,
      customerId: customer_id || null, customerName: customer_name || null,
      recipientEmail: recipient_email, subject, errorMessage: e.message, reasoning,
    });
    return { ok: false, error: e.message };
  }
}

// ── send_sms ──────────────────────────────────────────────────────────────
// Sends via Twilio. Logs "errored" if Twilio isn't configured.
async function sendSmsTool({ orgId, actor }, args) {
  const { recipient_phone, body, target_type, target_id, customer_id, customer_name, reasoning } = args || {};
  if (!recipient_phone || !body) {
    return { ok: false, error: "Missing recipient_phone / body" };
  }
  try {
    const { sendSms } = require("../utils/twilio");
    await sendSms(recipient_phone, body);
    await logActivity(orgId, {
      agent: actor || "agent", action: "sent", channel: "sms",
      targetType: target_type || null, targetId: target_id || null,
      customerId: customer_id || null, customerName: customer_name || null,
      recipientPhone: recipient_phone, body, reasoning,
    });
    return { ok: true, channel: "sms" };
  } catch (e) {
    console.error(`[agent-tools] send_sms failed:`, e.message);
    await logActivity(orgId, {
      agent: actor || "agent", action: "errored", channel: "sms",
      targetType: target_type || null, targetId: target_id || null,
      customerId: customer_id || null, customerName: customer_name || null,
      recipientPhone: recipient_phone, errorMessage: e.message, reasoning,
    });
    return { ok: false, error: e.message };
  }
}

// ── lookup_customer ───────────────────────────────────────────────────────
// Returns the customer doc plus a small snapshot of their relationship —
// number of jobs, last completed job, payment record, recent message
// activity. Helps the agent decide whether to soften or firm up its tone.
async function lookupCustomerTool({ orgId }, args) {
  const customerId = (args && args.customer_id) || null;
  if (!customerId) return { ok: false, error: "Missing customer_id" };
  try {
    const custDoc = await db.collection("customers").doc(customerId).get();
    if (!custDoc.exists || custDoc.data().orgId !== orgId) {
      return { ok: false, error: "Customer not found" };
    }
    const cust = custDoc.data();
    const [jobs, invoices, messages] = await Promise.all([
      db.collection("jobs").where("orgId", "==", orgId).where("customerId", "==", customerId).get(),
      db.collection("invoices").where("orgId", "==", orgId).where("customerId", "==", customerId).get(),
      db.collection("messages").where("orgId", "==", orgId).where("customerId", "==", customerId).orderBy("sentAt", "desc").limit(5).get(),
    ]);
    let totalPaid = 0, openInvoiceTotal = 0, paidCount = 0;
    invoices.docs.forEach(d => {
      const v = d.data();
      const t = Number(v.total) || 0;
      if (v.status === "paid") { totalPaid += t; paidCount++; }
      else if (v.status !== "draft") openInvoiceTotal += t;
    });
    const completedJobs = jobs.docs.filter(d => d.data().status === "complete" || d.data().status === "completed").length;
    const recentMessages = messages.docs.slice(0, 5).map(d => {
      const m = d.data();
      return {
        type: m.type || null,
        direction: m.direction || (m.from ? "in" : "out"),
        body: (m.body || "").slice(0, 200),
        sentAt: m.sentAt || null,
      };
    });
    return {
      ok: true,
      customer: {
        id: customerId,
        name: cust.name || "",
        email: cust.email || "",
        phone: cust.phone || "",
        address: cust.address || "",
        tags: cust.tags || [],
        notes: cust.notes || "",
        createdAt: cust.createdAt || null,
      },
      relationship: {
        totalJobs: jobs.size,
        completedJobs,
        totalPaidLifetime: totalPaid,
        paidInvoiceCount: paidCount,
        openInvoiceTotal,
        openInvoiceCount: invoices.docs.filter(d => d.data().status !== "paid" && d.data().status !== "draft").length,
        recentMessages,
      },
    };
  } catch (e) {
    console.error("[agent-tools] lookup_customer failed:", e.message);
    return { ok: false, error: e.message };
  }
}

// ── done ──────────────────────────────────────────────────────────────────
// Explicit "I'm finished — no more actions this run" so the loop can exit
// cleanly even if Claude wants to keep talking.
async function doneTool({ orgId, actor }, args) {
  const summary = (args && args.summary) || "Run complete.";
  await logActivity(orgId, {
    agent: actor || "agent", action: "summary",
    body: summary,
  });
  return { ok: true, done: true };
}

// Tool schemas exposed to Claude. Each agent picks which subset to surface.
const TOOL_SCHEMAS = {
  send_email: {
    name: "send_email",
    description: "Send an email to a customer through the business owner's Gmail. Use this for follow-ups, payment reminders, lead outreach, review requests, anything that warrants a written touch. Always include short, useful reasoning.",
    input_schema: {
      type: "object",
      properties: {
        recipient_email: { type: "string", description: "Email address to send to." },
        subject: { type: "string", description: "Email subject line." },
        body: { type: "string", description: "Plain-text email body. Keep it short, warm, and specific." },
        target_type: { type: "string", description: "What kind of record this email is about: 'quote', 'invoice', 'job', 'serviceRequest', 'customer', or 'message'." },
        target_id: { type: "string", description: "ID of the target record (so the activity log can dedupe)." },
        customer_id: { type: "string", description: "Customer ID if known." },
        customer_name: { type: "string", description: "Customer name for the activity log." },
        reasoning: { type: "string", description: "One-sentence reason this email is being sent right now." },
      },
      required: ["recipient_email", "subject", "body", "reasoning"],
    },
  },
  send_sms: {
    name: "send_sms",
    description: "Send a short SMS to a customer through the business owner's Twilio number. Best for time-sensitive nudges or quick confirmations. Keep it under 160 characters.",
    input_schema: {
      type: "object",
      properties: {
        recipient_phone: { type: "string", description: "Phone number in E.164 format, e.g. +15551234567." },
        body: { type: "string", description: "SMS text. Under 160 chars." },
        target_type: { type: "string" },
        target_id: { type: "string" },
        customer_id: { type: "string" },
        customer_name: { type: "string" },
        reasoning: { type: "string", description: "One-sentence reason for sending." },
      },
      required: ["recipient_phone", "body", "reasoning"],
    },
  },
  lookup_customer: {
    name: "lookup_customer",
    description: "Look up a customer's full record plus a relationship snapshot — total jobs, completed jobs, lifetime paid, open invoice balance, and the last 5 message exchanges. Use this before deciding tone for repeat customers.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "Customer ID to look up." },
      },
      required: ["customer_id"],
    },
  },
  done: {
    name: "done",
    description: "Call this to end the run when you're satisfied that no further action is warranted right now. Always include a one-sentence summary.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One-sentence summary of what was done this run." },
      },
      required: ["summary"],
    },
  },
};

const TOOL_HANDLERS = {
  send_email:      sendEmailTool,
  send_sms:        sendSmsTool,
  lookup_customer: lookupCustomerTool,
  done:            doneTool,
};

// Run a single tool call. Returns the JSON-stringifiable result.
async function executeTool(ctx, toolName, args) {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) return { ok: false, error: `Unknown tool: ${toolName}` };
  try {
    return await handler(ctx, args || {});
  } catch (e) {
    console.error(`[agent-tools] ${toolName} threw:`, e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  TOOL_SCHEMAS,
  TOOL_HANDLERS,
  executeTool,
  logActivity,
};
