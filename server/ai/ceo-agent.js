/**
 * CEO Agent — autonomous orchestrator that runs the org's AI team.
 *
 * On each tick the CEO loads a snapshot of the business state, calls
 * Claude with a CEO-style system prompt + dispatch tools, and lets
 * Claude decide which specialist (Admin / Sales / Customer Service)
 * should do what.
 *
 * The CEO doesn't directly send any emails — it's pure judgment. The
 * specialists (server/ai/specialists.js) do the actual sending. Every
 * decision (dispatch + reasoning) is logged to the orgs/{orgId}/
 * agentActivity collection for the user to review.
 */

const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic();

const { db } = require("../firebase");
const { loadOrgSnapshot } = require("./agent-context");
const { logActivity } = require("./agent-tools");
const { runSpecialist } = require("./specialists");

const MODEL = "claude-sonnet-4-6";    // CEO uses the smarter model — judgment matters
const MAX_DISPATCHES_PER_RUN = 6;

const SYSTEM_PROMPT = `You are the AUTONOMOUS CEO AGENT for {business}, a home-services business.

Your team is three specialists you can dispatch:
  • ADMIN AGENT — handles invoices, payment chasing, quote follow-ups
  • SALES AGENT — handles leads, prospect outreach, warming new customers
  • CUSTOMER SERVICE AGENT — replies to incoming customer messages

Each tick (about once an hour) you receive a snapshot of the current state of
the business: open quotes, unpaid invoices, recent leads, inbound messages,
and what your agents have done in the last 30 actions.

Your job is to think like a thoughtful CEO and decide what (if anything) the
team should focus on RIGHT NOW. Then dispatch the relevant specialist with
specific instructions: which records to act on and any context they need.

Rules:
  - Look at recent_agent_activity FIRST. Don't repeat what you just did.
  - Don't dispatch every specialist every run — only when there's clearly
    work for them. "Do nothing" is a perfectly good answer most ticks.
  - Be specific in your dispatches: name the customer / quote ID / invoice ID
    you want the specialist to act on, and explain why.
  - When you're satisfied for this tick, call done() with a short summary.
  - Limit yourself to dispatching at most one specialist per area per tick.

You are NOT the one sending the emails — your specialists do. You decide
what's worth doing and dispatch accordingly.`;

const TOOLS = [
  {
    name: "dispatch_admin",
    description: "Dispatch the Admin Agent to handle a specific set of invoices or quote follow-ups. Provide a focused list of target IDs (invoice or quote IDs) and clear instructions on what you want done.",
    input_schema: {
      type: "object",
      properties: {
        target_ids: {
          type: "array", items: { type: "string" },
          description: "Invoice or quote IDs the admin should focus on this run.",
        },
        instructions: {
          type: "string",
          description: "Clear instructions, e.g. 'Send second-stage payment reminders for these three invoices — they're 14+ days overdue.'",
        },
        reasoning: { type: "string", description: "Why you're dispatching the admin right now." },
      },
      required: ["instructions", "reasoning"],
    },
  },
  {
    name: "dispatch_sales",
    description: "Dispatch the Sales Agent to warm up specific leads. Provide the lead/customer IDs and what kind of outreach you want.",
    input_schema: {
      type: "object",
      properties: {
        target_ids: {
          type: "array", items: { type: "string" },
          description: "Service-request IDs or customer IDs to focus on.",
        },
        instructions: {
          type: "string",
          description: "Clear instructions, e.g. 'Reach out to these two intake leads from yesterday — both asked about kitchen remodels.'",
        },
        reasoning: { type: "string", description: "Why you're dispatching sales right now." },
      },
      required: ["instructions", "reasoning"],
    },
  },
  {
    name: "dispatch_customer_service",
    description: "Dispatch the Customer Service Agent to reply to inbound messages that haven't been answered.",
    input_schema: {
      type: "object",
      properties: {
        target_ids: {
          type: "array", items: { type: "string" },
          description: "Message IDs to focus on.",
        },
        instructions: {
          type: "string",
          description: "Clear instructions, e.g. 'Reply to Sarah's question about scheduling — propose Wednesday or Thursday.'",
        },
        reasoning: { type: "string", description: "Why a reply is warranted." },
      },
      required: ["instructions", "reasoning"],
    },
  },
  {
    name: "done",
    description: "Call when you've made all the decisions for this tick. Always include a one-sentence summary of what you concluded.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
      },
      required: ["summary"],
    },
  },
];

// Pull a focused subset of the snapshot for the specialist that's about to run.
// Keeps each specialist's prompt small and on-task.
function focusFor(role, snapshot, targetIds) {
  const ids = new Set((targetIds || []).map(String));
  const filterById = (arr) => ids.size === 0 ? arr : arr.filter(x => ids.has(String(x.id)));

  if (role === "admin") {
    return {
      open_quotes: filterById(snapshot.open_quotes),
      unpaid_invoices: filterById(snapshot.unpaid_invoices),
      recent_agent_activity: snapshot.recent_agent_activity,
    };
  }
  if (role === "sales") {
    return {
      leads: filterById(snapshot.leads),
      open_quotes: snapshot.open_quotes,            // helpful context
      recent_agent_activity: snapshot.recent_agent_activity,
    };
  }
  if (role === "customer_service") {
    return {
      recent_inbound_messages: filterById(snapshot.recent_inbound_messages),
      recent_agent_activity: snapshot.recent_agent_activity,
    };
  }
  return snapshot;
}

async function runCeo(orgId, uid) {
  const snapshot = await loadOrgSnapshot(orgId, uid);
  const businessName = snapshot.business_name;
  const userData = snapshot.user_data;

  // Strip the user_data field before showing the snapshot to Claude — it
  // contains raw OAuth tokens etc. that have no business in a prompt.
  const safeSnapshot = { ...snapshot };
  delete safeSnapshot.user_data;

  const systemPrompt = SYSTEM_PROMPT.replace(/{business}/g, businessName);
  const userMessage = `Current state:\n\`\`\`json\n${JSON.stringify(safeSnapshot, null, 2)}\n\`\`\`\n\n` +
    `Decide what the team should do this tick. Dispatch the specialists you need, or call done() if nothing warrants action right now.`;

  const messages = [{ role: "user", content: userMessage }];
  const ctx = { orgId, uid, userData };

  let dispatches = 0;
  let summary = "";
  const dispatchSummaries = [];

  for (let i = 0; i < MAX_DISPATCHES_PER_RUN; i++) {
    let resp;
    try {
      resp = await client.messages.create({
        model: MODEL,
        max_tokens: 2000,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      });
    } catch (e) {
      console.error(`[ceo-agent] Claude call failed:`, e.message);
      await logActivity(orgId, {
        agent: "CEO", action: "errored", errorMessage: e.message,
      });
      return { dispatches, summary: `CEO errored: ${e.message}` };
    }

    if (resp.stop_reason === "end_turn") {
      const text = (resp.content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
      if (text && !summary) summary = text;
      break;
    }
    if (resp.stop_reason !== "tool_use") break;

    const toolResults = [];
    let calledDone = false;

    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      const args = block.input || {};

      if (block.name === "done") {
        summary = args.summary || summary || "Run complete.";
        calledDone = true;
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ ok: true, done: true }) });
        continue;
      }

      let role = null;
      if (block.name === "dispatch_admin")             role = "admin";
      else if (block.name === "dispatch_sales")        role = "sales";
      else if (block.name === "dispatch_customer_service") role = "customer_service";

      if (!role) {
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ ok: false, error: "Unknown tool" }) });
        continue;
      }

      // Log the dispatch decision itself so the user sees CEO's reasoning
      await logActivity(orgId, {
        agent: "CEO", action: "dispatched",
        targetType: role, body: args.instructions || "",
        reasoning: args.reasoning || "",
      });

      const focus = focusFor(role, snapshot, args.target_ids);
      const result = await runSpecialist(role, ctx, businessName, focus, args.instructions);
      dispatches++;
      dispatchSummaries.push(`${role}: ${result.summary} (${result.actions} action${result.actions === 1 ? "" : "s"})`);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify({ ok: true, role, actions: result.actions, summary: result.summary }),
      });
    }

    messages.push({ role: "assistant", content: resp.content });
    messages.push({ role: "user", content: toolResults });

    if (calledDone) break;
  }

  // Final activity log entry summarising the tick
  await logActivity(orgId, {
    agent: "CEO", action: "tick_complete",
    body: summary || "Tick complete.",
    reasoning: dispatchSummaries.join("  |  "),
  });

  return { dispatches, summary: summary || "Tick complete." };
}

async function runCeoForAllOrgs() {
  try {
    const usersSnap = await db.collection("users")
      .where("accountStatus", "in", ["trial", "active"])
      .get();

    let total = 0;
    for (const doc of usersSnap.docs) {
      const uid = doc.id;
      const data = doc.data();
      if (data.orgId && data.orgId !== uid) continue;     // skip team members

      // Gate by the CEO agent toggle
      try {
        const cfgDoc = await db.collection("orgs").doc(uid).collection("agentConfigs").doc("ceo").get();
        if (!cfgDoc.exists || !cfgDoc.data().enabled) continue;
      } catch (_) { continue; }

      try {
        const result = await runCeo(uid, uid);
        if (result.dispatches > 0) {
          console.log(`[ceo-agent] org ${uid}: ${result.dispatches} dispatches — ${result.summary}`);
          total += result.dispatches;
        }
      } catch (e) {
        console.error(`[ceo-agent] Error for org ${uid}:`, e.message);
      }
    }

    if (total > 0) console.log(`[ceo-agent] Total dispatches this run: ${total}`);
  } catch (e) {
    console.error("[ceo-agent] Runner error:", e.message);
  }
}

module.exports = { runCeo, runCeoForAllOrgs };
