/**
 * Specialist agents — Admin, Sales, Customer Service.
 *
 * Each specialist is a focused Claude call with:
 *   - A role-specific system prompt
 *   - Access to send_email, send_sms, lookup_customer, done
 *   - A scoped portion of the org snapshot (Admin sees invoices/quotes,
 *     Sales sees leads/quotes, CS sees inbound messages)
 *
 * The CEO meta-agent invokes one of these via the dispatch_*
 * tools, passing instructions like "follow up on these three quotes"
 * or "answer the message from Sarah about scheduling."
 */

const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic();

const { TOOL_SCHEMAS, executeTool } = require("./agent-tools");

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOOL_CALLS_PER_RUN = 8;

// Tools every specialist gets. send_email is required; the others enrich
// reasoning or terminate the loop cleanly.
const SPECIALIST_TOOLS = [
  TOOL_SCHEMAS.send_email,
  TOOL_SCHEMAS.send_sms,
  TOOL_SCHEMAS.lookup_customer,
  TOOL_SCHEMAS.done,
];

const ROLE_PROMPTS = {
  admin: `You are the AUTONOMOUS ADMIN AGENT for {business}. You handle invoices, payments, and quote follow-ups. Your job is to keep money flowing and quotes from going cold.

You can:
- Send a polite payment reminder if an invoice is past due. Escalate tone with each successive reminder (gentle → firmer → final notice). Stop after 3 reminders for the same invoice.
- Send a quote follow-up if a quote was sent and the customer hasn't responded.
- Look up a customer's history before deciding tone. Long-time customers who pay on time deserve a softer touch than first-time defaulters.

Rules:
- Check the recent_agent_activity field. NEVER send the same message you already sent. NEVER act on a target_id another agent already handled today.
- Don't email a customer twice in 7 days for the same invoice/quote unless you're escalating tone explicitly.
- Be specific: reference the invoice/quote number, amount, and how many days it's been.
- Keep emails under 4 sentences.
- When you're done, call done with a one-sentence summary.`,

  sales: `You are the AUTONOMOUS SALES AGENT for {business}. You warm leads and turn interest into booked work.

You can:
- Reach out to leads from the intake form (status: 'serviceRequest') that haven't gotten a response yet.
- Reach out to customers tagged 'lead' or 'from doors' who haven't yet had a quote.
- Look up a customer's history to personalize the outreach.

Rules:
- Check the recent_agent_activity field. Don't repeat outreach you already did.
- Acknowledge the specific service or interest the lead expressed if known.
- Offer a clear next step ("want to schedule a quote? reply with a good time").
- Keep emails under 4 sentences. Keep SMS under 160 characters.
- When you're done, call done with a one-sentence summary.`,

  customer_service: `You are the AUTONOMOUS CUSTOMER SERVICE AGENT for {business}. You answer incoming customer messages so nobody waits.

You can:
- Reply via the same channel the customer used (email, SMS).
- Look up a customer to give a context-aware reply.

Rules:
- Only reply to inbound messages that haven't been answered yet (check recent_agent_activity).
- Don't make promises you can't keep — defer to the owner ("I'll have the team confirm and get back to you") for anything specific you don't have data for.
- Keep replies short and warm.
- When you're done, call done with a one-sentence summary.`,
};

/**
 * Run a specialist agent with a focused brief.
 *
 * @param {string} role            'admin' | 'sales' | 'customer_service'
 * @param {object} ctx             { orgId, uid, userData }
 * @param {string} businessName
 * @param {object} focus           snapshot fields the specialist should look at
 * @param {string} ceoInstructions free-form instructions from the CEO
 * @returns {Promise<{ actions: number, summary: string }>}
 */
async function runSpecialist(role, ctx, businessName, focus, ceoInstructions) {
  const systemPrompt = (ROLE_PROMPTS[role] || ROLE_PROMPTS.admin).replace(/{business}/g, businessName);

  const userMessage = `CEO instructions for this run:\n${ceoInstructions || "Use your judgment — act on whatever needs attention right now."}\n\n` +
    `Here is the relevant state of the business:\n\`\`\`json\n${JSON.stringify(focus, null, 2)}\n\`\`\`\n\n` +
    `Today's date: ${new Date().toISOString().split("T")[0]}.\n\n` +
    `Decide what (if anything) to do. Use send_email or send_sms for any action. Call done() when you're satisfied.`;

  const messages = [{ role: "user", content: userMessage }];
  const actorName = role === "customer_service" ? "Customer Service"
                  : role === "sales"            ? "Sales"
                  :                                "Admin";
  const toolCtx = { ...ctx, actor: actorName };

  let actions = 0;
  let summary = "";

  for (let i = 0; i < MAX_TOOL_CALLS_PER_RUN; i++) {
    let resp;
    try {
      resp = await client.messages.create({
        model: MODEL,
        max_tokens: 1500,
        system: systemPrompt,
        tools: SPECIALIST_TOOLS,
        messages,
      });
    } catch (e) {
      console.error(`[specialist:${role}] Claude call failed:`, e.message);
      return { actions, summary: `Errored: ${e.message}` };
    }

    if (resp.stop_reason === "end_turn") {
      // Pull any plain-text content as a summary fallback
      const text = (resp.content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
      if (text && !summary) summary = text;
      break;
    }
    if (resp.stop_reason !== "tool_use") break;

    // Process every tool_use block in this assistant turn, build tool_result blocks
    const toolResults = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      const result = await executeTool(toolCtx, block.name, block.input);
      if (result && result.ok && (block.name === "send_email" || block.name === "send_sms")) {
        actions++;
      }
      if (block.name === "done") {
        summary = (block.input && block.input.summary) || summary || "Run complete.";
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    // Feed the assistant turn + tool results back
    messages.push({ role: "assistant", content: resp.content });
    messages.push({ role: "user", content: toolResults });

    // If 'done' was called, we can stop early
    if (toolResults.some(r => {
      try { return JSON.parse(r.content).done; } catch { return false; }
    })) break;
  }

  return { actions, summary: summary || `${actorName} run complete.` };
}

module.exports = { runSpecialist };
