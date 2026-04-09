/**
 * SWFT — AI Receptionist Agent
 *
 * Handles inbound SMS messages from customers and unknown numbers.
 * Qualifies leads, answers questions, books estimates, and escalates
 * when it can't handle a request.
 *
 * Conversation history per phone number is stored in:
 *   receptionistChats/{orgId}_{phone}/messages/{docId}
 *
 * Per-thread manual mode stored on:
 *   receptionistChats/{orgId}_{phone} (doc field: manualMode)
 *
 * AI-detected tasks stored in:
 *   tasks/{taskId}
 */

const Anthropic = require("@anthropic-ai/sdk");
const { db } = require("../firebase");
const { sendSms, getUserTelnyxConfig } = require("../telnyx");
const { getPlan } = require("../plans");
const { getUsage, incrementSms } = require("../usage");

const anthropic = new Anthropic();

const MAX_HISTORY = 20;

/**
 * Get the receptionist config for an org. Returns null if disabled.
 */
async function getReceptionistConfig(orgId) {
  const doc = await db.collection("orgs").doc(orgId).collection("agentConfigs").doc("receptionist").get();
  if (!doc.exists) {
    // Auto-create default config as DISABLED — user must explicitly turn on
    const defaultConfig = { enabled: false, tone: "professional", greeting: "", channels: "voice_sms" };
    await db.collection("orgs").doc(orgId).collection("agentConfigs").doc("receptionist").set(defaultConfig);
    console.log("[receptionist] Auto-created config for org:", orgId, "(disabled by default)");
    return null;
  }
  const config = doc.data();
  if (!config.enabled) return null;
  return config;
}

/**
 * Get conversation history for a phone number with this org.
 */
async function getChatHistory(orgId, phone) {
  const chatId = `${orgId}_${phone.replace(/\D/g, "")}`;
  const snap = await db.collection("receptionistChats").doc(chatId)
    .collection("messages")
    .orderBy("timestamp", "asc")
    .limitToLast(MAX_HISTORY)
    .get();
  return snap.docs.map(d => d.data());
}

/**
 * Save a message to the receptionist chat history.
 */
async function saveChatMessage(orgId, phone, role, content) {
  const chatId = `${orgId}_${phone.replace(/\D/g, "")}`;
  await db.collection("receptionistChats").doc(chatId)
    .collection("messages").add({
      role,
      content,
      timestamp: Date.now(),
    });
}

/**
 * Handle an inbound SMS message with the AI receptionist.
 *
 * @param {string} orgId - Organization ID
 * @param {string} ownerUid - Owner's UID (for SMS limits)
 * @param {object} owner - Owner user data (company, name, plan, etc.)
 * @param {string} fromPhone - Sender's phone number
 * @param {string} messageBody - The SMS message text
 * @param {object|null} customer - Matched customer data or null for unknown
 * @returns {{ replied: boolean, response: string|null, action: string|null }}
 */
async function handleInboundMessage(orgId, ownerUid, owner, fromPhone, messageBody, customer) {
  const config = await getReceptionistConfig(orgId);
  if (!config) return { replied: false, response: null, action: null };

  // Check per-thread manual mode — owner has taken over this conversation
  const chatId = `${orgId}_${fromPhone.replace(/\D/g, "")}`;
  const chatMeta = await db.collection("receptionistChats").doc(chatId).get();
  if (chatMeta.exists && chatMeta.data().manualMode === true) {
    // Save inbound to history so the owner can see it, but don't auto-reply
    await saveChatMessage(orgId, fromPhone, "user", messageBody);
    console.log(`[receptionist] Manual mode active for ${chatId}, skipping auto-reply`);
    return { replied: false, response: null, action: "manual_mode" };
  }

  // Check SMS limits before responding (includes bonus credits from packs)
  const plan = getPlan(owner.plan);
  const { getEffectiveUsage } = require("../usage");
  const usage = await getEffectiveUsage(ownerUid);
  const effectiveLimit = plan.smsLimit === Infinity ? Infinity : plan.smsLimit + (usage.smsCredits || 0);
  if (usage.smsCount >= effectiveLimit) {
    console.log(`[receptionist] SMS limit reached for org ${orgId}, skipping auto-reply`);
    return { replied: false, response: null, action: "sms_limit" };
  }

  // Get conversation history
  const history = await getChatHistory(orgId, fromPhone);

  // Save the inbound message
  await saveChatMessage(orgId, fromPhone, "user", messageBody);

  // Build messages for Claude
  const messages = history.map(h => ({
    role: h.role === "user" ? "user" : "assistant",
    content: h.content,
  }));
  messages.push({ role: "user", content: messageBody });

  // Auto-discover business context from job history
  const bizContext = await getBusinessContext(orgId, ownerUid);

  // Build system prompt
  const systemPrompt = buildReceptionistPrompt(config, owner, customer, bizContext);

  // Call Claude
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 200,
    system: systemPrompt,
    messages,
  });

  const replyText = response.content[0]?.text || "";
  if (!replyText) return { replied: false, response: null, action: null };

  // Parse task signals: [TASK:TYPE:details]
  const taskRegex = /\[TASK:(QUOTE|ESTIMATE|CALL|PAYMENT):([^\]]*)\]/gi;
  const detectedTasks = [];
  let tm;
  while ((tm = taskRegex.exec(replyText)) !== null) {
    detectedTasks.push({ type: tm[1].toUpperCase(), details: tm[2].trim() });
  }

  // Strip all signals from the customer-facing reply
  const shouldEscalate = replyText.includes("[ESCALATE]");
  const cleanReply = replyText
    .replace(/\[TASK:[A-Z]+:[^\]]*\]/gi, "")
    .replace("[ESCALATE]", "")
    .trim();

  if (!cleanReply) return { replied: false, response: null, action: null };

  // Send the SMS reply
  try {
    await sendSms(fromPhone, cleanReply, getUserTelnyxConfig(owner));
    await incrementSms(ownerUid);
    await saveChatMessage(orgId, fromPhone, "assistant", cleanReply);

    // Log to messages collection for visibility in the messages page
    await db.collection("messages").add({
      userId: ownerUid,
      orgId,
      to: fromPhone,
      body: cleanReply,
      customerId: customer?.customerId || "",
      customerName: customer?.customerName || "",
      type: "sms",
      direction: "outbound",
      status: "sent",
      sentVia: "telnyx",
      sentAt: Date.now(),
      isReceptionist: true,
    });

    // Create task documents for each detected signal
    for (const task of detectedTasks) {
      await db.collection("tasks").add({
        orgId,
        ownerUid,
        type: task.type,
        details: task.details,
        phone: fromPhone,
        customerName: customer?.customerName || "",
        customerId: customer?.customerId || "",
        inboundMessage: messageBody.slice(0, 300),
        status: "pending",
        createdAt: Date.now(),
      });
      console.log(`[receptionist] Task created: ${task.type} for org ${orgId} — ${task.details}`);
    }

    // Determine activity type
    const activityType = detectedTasks.length > 0
      ? `task_${detectedTasks[0].type.toLowerCase()}`
      : shouldEscalate ? "escalated"
      : customer ? "replied_customer"
      : "replied_lead";

    // Log activity
    await db.collection("orgs").doc(orgId).collection("agentActivity").add({
      agent: "receptionist",
      type: activityType,
      phone: fromPhone,
      customerName: customer?.customerName || "",
      inboundMessage: messageBody.slice(0, 200),
      response: cleanReply.slice(0, 200),
      tasksCreated: detectedTasks.length,
      createdAt: Date.now(),
    });

    // Notify owner on escalation or task creation
    const needsNotification = shouldEscalate || detectedTasks.length > 0;
    if (needsNotification) {
      const taskLabel = detectedTasks.length > 0
        ? `Task: ${detectedTasks[0].type} — ${detectedTasks[0].details.slice(0, 60)}`
        : null;
      await db.collection("notifications").add({
        orgId,
        userId: ownerUid,
        type: detectedTasks.length > 0 ? "receptionist_task" : "receptionist_escalation",
        title: detectedTasks.length > 0 ? "New AI Task" : "Receptionist Escalation",
        message: taskLabel || `Message from ${customer?.customerName || fromPhone} needs your attention: "${messageBody.slice(0, 100)}"`,
        phone: fromPhone,
        read: false,
        createdAt: Date.now(),
      });
    }

    return { replied: true, response: cleanReply, action: activityType };
  } catch (err) {
    console.error(`[receptionist] Failed to send reply to ${fromPhone}:`, err.message);
    return { replied: false, response: null, action: "send_failed" };
  }
}

/**
 * Auto-discover business info from job history, quotes, and customers.
 * Cached per org for 10 minutes to avoid hitting Firestore on every SMS.
 */
const _bizCache = {};
const BIZ_CACHE_TTL = 10 * 60 * 1000;

async function getBusinessContext(orgId, ownerUid) {
  const cached = _bizCache[orgId];
  if (cached && Date.now() - cached.ts < BIZ_CACHE_TTL) return cached.data;

  // Pull recent jobs to learn services, pricing, and areas
  const jobSnap = await db.collection("jobs")
    .where("userId", "==", ownerUid).limit(50).get();
  const jobs = jobSnap.docs.map(d => d.data());

  // Pull recent quotes
  const quoteSnap = await db.collection("quotes")
    .where("userId", "==", ownerUid).limit(30).get();
  const quotes = quoteSnap.docs.map(d => d.data());

  // Extract unique services
  const serviceSet = new Set();
  jobs.forEach(j => { if (j.service) serviceSet.add(j.service); if (j.title) serviceSet.add(j.title); });
  quotes.forEach(q => { if (q.title) serviceSet.add(q.title); });

  // Extract addresses for service area
  const areas = new Set();
  jobs.forEach(j => {
    if (j.address) {
      const parts = j.address.split(",");
      if (parts.length >= 2) areas.add(parts[parts.length - 2].trim());
    }
  });

  // Price ranges
  const prices = jobs.filter(j => j.cost && j.cost > 0).map(j => j.cost);
  const priceRange = prices.length > 0
    ? `$${Math.min(...prices)} - $${Math.max(...prices)}`
    : "";

  const data = {
    services: [...serviceSet].filter(Boolean).join(", "),
    serviceArea: [...areas].filter(Boolean).join(", "),
    jobCount: jobs.length,
    priceRange,
  };

  _bizCache[orgId] = { ts: Date.now(), data };
  return data;
}

/**
 * Build the system prompt for the receptionist.
 *
 * The agent starts as a generic assistant. As the business owner adds info
 * in Settings (bizAbout, bizServices, bizArea, bizHours, bizWebsite, bizNotes)
 * and accumulates jobs/quotes, the prompt automatically becomes more specific
 * and fine-tuned to that business — no manual prompt editing required.
 */
function buildReceptionistPrompt(config, owner, customer, bizContext) {
  const companyName = config.businessName || owner.company || owner.name || "our company";
  const ownerName = owner.name || "the owner";
  const tone = config.tone === "casual" ? "casual and friendly" : "friendly and professional";

  let prompt = `You are an AI receptionist for ${companyName}. You respond to inbound text messages on behalf of the owner.`;

  // Auto-discovered business context from actual jobs & quotes
  if (bizContext.services) {
    prompt += `\n\nSERVICES (from past jobs): ${bizContext.services}`;
  }
  if (bizContext.serviceArea) {
    prompt += `\nSERVICE AREA: ${bizContext.serviceArea}`;
  }
  if (bizContext.priceRange) {
    prompt += `\nTYPICAL PRICE RANGE: DO NOT share this with customers. See PRICING rule below.`;
  }
  if (bizContext.jobCount > 0) {
    prompt += `\nCOMPLETED JOBS: ${bizContext.jobCount}+`;
  }

  // Business profile from Settings page (populated by the owner)
  if (owner.bizAbout) prompt += `\n\nABOUT THE BUSINESS: ${owner.bizAbout}`;
  if (owner.bizServices && !bizContext.services) prompt += `\nSERVICES: ${owner.bizServices}`;
  if (owner.bizArea && !bizContext.serviceArea) prompt += `\nSERVICE AREA: ${owner.bizArea}`;
  if (owner.bizHours) prompt += `\nHOURS: ${owner.bizHours}`;
  if (owner.bizWebsite || owner.website) prompt += `\nWEBSITE: ${owner.bizWebsite || owner.website}`;
  if (owner.bizNotes) prompt += `\nNOTES: ${owner.bizNotes}`;

  // Manual overrides from agent config page
  if (config.businessDescription) prompt += `\n\nEXTRA INFO: ${config.businessDescription}`;

  prompt += `

STYLE: ${tone}. Extremely short. One sentence, two max. No fluff. Text like a busy person.

RULES:
1. Only mention services from the list above. Never invent services.
2. PRICING — HARD RULE: NEVER give out pricing, cost estimates, price ranges, ballpark numbers, or any indication of what something costs. No matter how they ask — "how much", "what's the rate", "ballpark", "rough estimate" — do NOT provide a number. Instead, let them know that every job is different and you'd love to book a free estimate so ${ownerName} can come take a look and give them an accurate quote in person. Be warm about it, not robotic. Steer toward scheduling. Emit [TASK:ESTIMATE:wants pricing, steer to on-site estimate] when this happens.
3. Don't know? Say "${ownerName} will get back to you."
4. Can't help or person is upset? Add [ESCALATE] at end of reply.
5. Under 120 chars when possible. This is SMS.
6. "stop"/"unsubscribe" → acknowledge + [ESCALATE]
7. No emojis unless customer uses them first.
8. NEVER repeat business info word-for-word. Absorb the details and respond naturally. Paraphrase. Never mention specific dollar amounts.

TASK SIGNALS — embed ONE in your reply (customer never sees it) when triggered:
• [TASK:QUOTE:brief summary] — Lead gave enough detail (measurements, scope, material type) that the owner can prepare a quote
• [TASK:ESTIMATE:brief summary] — Lead explicitly wants a physical walkthrough or on-site visit
• [TASK:CALL:brief summary] — Situation needs a real phone call (emergency, complex specs, unclear scope, frustrated lead)
• [TASK:PAYMENT:brief summary] — Lead is ready to pay, book with deposit, or explicitly mentions payment now
Only emit a signal when clearly triggered. Never emit more than one per reply. Strip it yourself — it goes to the owner's task dashboard, not to the customer.`;

  if (config.greeting) {
    prompt += `\n\nGREETING STYLE: "${config.greeting}"`;
  }

  if (customer) {
    prompt += `\n\nEXISTING CUSTOMER: ${customer.customerName || "Unknown"}. Be familiar, they've worked with us before.`;
  } else {
    prompt += `\n\nNEW LEAD. Be warm. Try to get their name and what they need in 1-2 exchanges.`;
  }

  return prompt;
}

module.exports = { handleInboundMessage, getReceptionistConfig };
