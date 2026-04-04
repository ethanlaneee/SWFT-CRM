const Anthropic = require("@anthropic-ai/sdk");
const { db } = require("../firebase");
const crmTools = require("./tools");
const getSystemPrompt = require("./system-prompt");
const { getConversationHistory, saveMessage } = require("./memory");
const { getIntegrationTools, executeIntegrationTool } = require("./integration-tools");

const client = new Anthropic();

// Integration tool names — if a tool call matches one of these, route to integration handler
const INTEGRATION_TOOL_NAMES = [
  "list_calendar_events", "create_calendar_event",
  "check_gmail_inbox", "send_gmail",
];

// ── Tool execution — maps tool names to Firestore operations ──

async function executeTool(toolName, input, uid) {
  switch (toolName) {
    case "create_customer": {
      const data = {
        userId: uid,
        name: input.name || "",
        email: input.email || "",
        phone: input.phone || "",
        address: input.address || "",
        notes: input.notes || "",
        tags: input.tags || [],
        createdAt: Date.now(),
      };
      const ref = await db.collection("customers").add(data);
      return { id: ref.id, ...data };
    }

    case "search_customers": {
      const snap = await db.collection("customers").where("userId", "==", uid).get();
      const q = (input.query || "").toLowerCase();
      const results = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(c =>
          c.name.toLowerCase().includes(q) ||
          (c.email && c.email.toLowerCase().includes(q)) ||
          (c.phone && c.phone.includes(q))
        );
      return { count: results.length, customers: results.slice(0, 10) };
    }

    case "update_customer": {
      const { customerId, ...updates } = input;
      const cDoc = await db.collection("customers").doc(customerId).get();
      if (!cDoc.exists || cDoc.data().userId !== uid) return { error: "Customer not found" };
      updates.updatedAt = Date.now();
      await db.collection("customers").doc(customerId).update(updates);
      const updated = await db.collection("customers").doc(customerId).get();
      return { id: updated.id, ...updated.data() };
    }

    case "create_quote": {
      const total = (input.items || []).reduce((sum, i) => sum + (i.amount || 0), 0);
      const data = {
        userId: uid,
        customerId: input.customerId || "",
        customerName: input.customerName || "",
        items: input.items || [],
        total,
        notes: input.notes || "",
        status: "draft",
        createdAt: Date.now(),
      };
      const ref = await db.collection("quotes").add(data);
      return { id: ref.id, ...data };
    }

    case "list_quotes": {
      const snap = await db.collection("quotes").where("userId", "==", uid).get();
      let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (input.status) results = results.filter(r => r.status === input.status);
      results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return { quotes: results.slice(0, 20) };
    }

    case "send_quote": {
      const qDoc = await db.collection("quotes").doc(input.quoteId).get();
      if (!qDoc.exists || qDoc.data().userId !== uid) return { error: "Quote not found" };
      await db.collection("quotes").doc(input.quoteId).update({ status: "sent", sentAt: Date.now() });
      return { success: true, quoteId: input.quoteId, status: "sent" };
    }

    case "create_invoice": {
      const total = (input.items || []).reduce((sum, i) => sum + (i.amount || 0), 0);
      const data = {
        userId: uid,
        customerId: input.customerId || "",
        customerName: input.customerName || "",
        quoteId: input.quoteId || null,
        items: input.items || [],
        total,
        notes: input.notes || "",
        status: "open",
        dueDate: input.dueDate || null,
        createdAt: Date.now(),
      };
      const ref = await db.collection("invoices").add(data);
      return { id: ref.id, ...data };
    }

    case "list_invoices": {
      const snap = await db.collection("invoices").where("userId", "==", uid).get();
      let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (input.status) results = results.filter(r => r.status === input.status);
      results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return { invoices: results.slice(0, 20) };
    }

    case "create_job": {
      const data = {
        userId: uid,
        customerId: input.customerId || "",
        customerName: input.customerName || "",
        quoteId: input.quoteId || null,
        title: input.title || "",
        description: input.description || "",
        service: input.service || "",
        status: input.status || "scheduled",
        scheduledDate: input.scheduledDate || null,
        cost: input.cost || 0,
        address: input.address || "",
        createdAt: Date.now(),
      };
      const ref = await db.collection("jobs").add(data);
      return { id: ref.id, ...data };
    }

    case "list_jobs": {
      const snap = await db.collection("jobs").where("userId", "==", uid).get();
      let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (input.status) results = results.filter(r => r.status === input.status);
      results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return { jobs: results.slice(0, 20) };
    }

    case "update_job": {
      const { jobId, ...updates } = input;
      const jDoc = await db.collection("jobs").doc(jobId).get();
      if (!jDoc.exists || jDoc.data().userId !== uid) return { error: "Job not found" };
      updates.updatedAt = Date.now();
      await db.collection("jobs").doc(jobId).update(updates);
      const updated = await db.collection("jobs").doc(jobId).get();
      return { id: updated.id, ...updated.data() };
    }

    case "schedule_job": {
      const data = {
        userId: uid,
        jobId: input.jobId || null,
        title: input.title || "",
        date: input.date || null,
        startTime: input.startTime || null,
        endTime: input.endTime || null,
        location: input.location || "",
        notes: input.notes || "",
        createdAt: Date.now(),
      };
      const ref = await db.collection("schedule").add(data);
      return { id: ref.id, ...data };
    }

    case "get_dashboard_stats": {
      const [jobsSnap, quotesSnap, invoicesSnap, scheduleSnap] = await Promise.all([
        db.collection("jobs").where("userId", "==", uid).get(),
        db.collection("quotes").where("userId", "==", uid).get(),
        db.collection("invoices").where("userId", "==", uid).get(),
        db.collection("schedule").where("userId", "==", uid).get(),
      ]);

      const jobs = jobsSnap.docs.map(d => d.data());
      const invoices = invoicesSnap.docs.map(d => d.data());
      const now = Date.now();
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

      return {
        totalJobs: jobs.length,
        activeJobs: jobs.filter(j => j.status === "active").length,
        completedJobs: jobs.filter(j => j.status === "complete").length,
        monthlyRevenue: invoices
          .filter(i => i.status === "paid" && i.paidAt && i.paidAt >= thirtyDaysAgo)
          .reduce((sum, i) => sum + (i.total || 0), 0),
        totalRevenue: invoices
          .filter(i => i.status === "paid")
          .reduce((sum, i) => sum + (i.total || 0), 0),
        activeQuotes: quotesSnap.docs.filter(d => ["draft", "sent"].includes(d.data().status)).length,
        openInvoices: invoices.filter(i => i.status === "open").length,
        upcomingTasks: scheduleSnap.size,
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Main agent loop — handles tool calling with Claude ──

async function runAgent(uid, userMessage, userProfile) {
  // Get conversation history
  const history = await getConversationHistory(uid);

  // Save the user's message
  await saveMessage(uid, "user", userMessage);

  // Build messages array
  const messages = [
    ...history,
    { role: "user", content: userMessage },
  ];

  const systemPrompt = getSystemPrompt(userProfile.name, userProfile.company);

  // Dynamically add integration tools based on user's connected services
  const integrationTools = await getIntegrationTools(uid);
  const allTools = [...crmTools, ...integrationTools];

  // Agent loop — keep calling Claude until it stops using tools
  let response;
  const actionsTaken = [];

  for (let i = 0; i < 10; i++) { // Max 10 tool-use rounds
    response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      tools: allTools,
      messages,
    });

    // If no tool use, we're done
    if (response.stop_reason === "end_turn" || !response.content.some(b => b.type === "tool_use")) {
      break;
    }

    // Process tool calls
    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    const toolResults = [];
    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        // Route to integration handler or CRM handler
        const result = INTEGRATION_TOOL_NAMES.includes(block.name)
          ? await executeIntegrationTool(block.name, block.input, uid)
          : await executeTool(block.name, block.input, uid);
        actionsTaken.push({ tool: block.name, input: block.input, result });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Extract the final text response
  const textBlocks = response.content.filter(b => b.type === "text");
  const finalText = textBlocks.map(b => b.text).join("\n");

  // Save assistant response
  await saveMessage(uid, "assistant", finalText);

  return {
    message: finalText,
    actions: actionsTaken,
  };
}

module.exports = { runAgent };
