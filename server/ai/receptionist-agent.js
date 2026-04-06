/**
 * SWFT — AI Receptionist Agent
 *
 * Handles inbound SMS messages from customers and unknown numbers.
 * Qualifies leads, answers questions, books estimates, and escalates
 * when it can't handle a request.
 *
 * Conversation history per phone number is stored in:
 *   receptionistChats/{orgId}_{phone}/messages/{docId}
 */

const Anthropic = require("@anthropic-ai/sdk");
const { db } = require("../firebase");
const { sendSms } = require("../twilio");
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
    // Auto-create default config as enabled
    const defaultConfig = { enabled: true, tone: "professional", greeting: "", channels: "voice_sms" };
    await db.collection("orgs").doc(orgId).collection("agentConfigs").doc("receptionist").set(defaultConfig);
    console.log("[receptionist] Auto-created config for org:", orgId);
    return defaultConfig;
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

  // Check SMS limits before responding
  const plan = getPlan(owner.plan);
  const usage = await getUsage(ownerUid);
  if (usage.smsCount >= plan.smsLimit) {
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
    max_tokens: 160,
    system: systemPrompt,
    messages,
  });

  const replyText = response.content[0]?.text || "";
  if (!replyText) return { replied: false, response: null, action: null };

  // Check for escalation signal
  const shouldEscalate = replyText.includes("[ESCALATE]");
  const cleanReply = replyText.replace("[ESCALATE]", "").trim();

  // Send the SMS reply
  try {
    await sendSms(fromPhone, cleanReply);
    await incrementSms(ownerUid);
    await saveChatMessage(orgId, fromPhone, "assistant", cleanReply);

    // Log to messages collection for visibility
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
      sentVia: "twilio",
      sentAt: Date.now(),
      isReceptionist: true,
    });

    // Log activity
    const activityType = shouldEscalate ? "escalated" : (customer ? "replied_customer" : "replied_lead");
    await db.collection("orgs").doc(orgId).collection("agentActivity").add({
      agent: "receptionist",
      type: activityType,
      phone: fromPhone,
      customerName: customer?.customerName || "",
      inboundMessage: messageBody.slice(0, 200),
      response: cleanReply.slice(0, 200),
      createdAt: Date.now(),
    });

    // If escalation, notify the owner
    if (shouldEscalate) {
      await db.collection("notifications").add({
        orgId,
        userId: ownerUid,
        type: "receptionist_escalation",
        title: "Receptionist Escalation",
        message: `Message from ${customer?.customerName || fromPhone} needs your attention: "${messageBody.slice(0, 100)}"`,
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
 * Auto-discovers business info from actual job/quote data.
 */
function buildReceptionistPrompt(config, owner, customer, bizContext) {
  const companyName = config.businessName || owner.company || owner.name || "our company";
  const ownerName = owner.name || "the owner";
  const tone = config.tone === "casual" ? "casual and friendly" : "friendly and professional";

  let prompt = `You are an AI receptionist for ${companyName}. You respond to inbound text messages.`;

  // Auto-discovered business context
  if (bizContext.services) {
    prompt += `\n\nSERVICES (from past jobs): ${bizContext.services}`;
  }
  if (bizContext.serviceArea) {
    prompt += `\nSERVICE AREA: ${bizContext.serviceArea}`;
  }
  if (bizContext.priceRange) {
    prompt += `\nTYPICAL PRICE RANGE: ${bizContext.priceRange} (but always say ${ownerName} will send a custom quote)`;
  }
  if (bizContext.jobCount > 0) {
    prompt += `\nCOMPLETED JOBS: ${bizContext.jobCount}+`;
  }

  // Business profile from Settings page (owner's user doc)
  if (owner.bizAbout) prompt += `\n\nABOUT THE BUSINESS: ${owner.bizAbout}`;
  if (owner.bizServices && !bizContext.services) prompt += `\nSERVICES: ${owner.bizServices}`;
  if (owner.bizArea && !bizContext.serviceArea) prompt += `\nSERVICE AREA: ${owner.bizArea}`;
  if (owner.bizHours) prompt += `\nHOURS: ${owner.bizHours}`;
  if (owner.bizWebsite || owner.website) prompt += `\nWEBSITE: ${owner.bizWebsite || owner.website}`;
  if (owner.bizNotes) prompt += `\nNOTES: ${owner.bizNotes}`;

  // Manual overrides from agent config
  if (config.businessDescription) prompt += `\n\nEXTRA: ${config.businessDescription}`;

  prompt += `

STYLE: ${tone}. Extremely short. One sentence, two max. No fluff. Text like a busy person.

RULES:
1. Only mention services from the list above. Never invent services.
2. Never quote specific prices. Always say "${ownerName} will send a custom quote."
3. Don't know? Say "${ownerName} will get back to you."
4. Can't help or person is upset? Add [ESCALATE] at end.
5. Under 120 chars when possible. This is SMS.
6. "stop"/"unsubscribe" → acknowledge + [ESCALATE]
7. No emojis unless customer uses them first.`;

  if (config.greeting) {
    prompt += `\n\nGREETING STYLE: "${config.greeting}"`;
  }

  if (customer) {
    prompt += `\n\nEXISTING CUSTOMER: ${customer.customerName || "Unknown"}. Be familiar.`;
  } else {
    prompt += `\n\nNEW LEAD. Get their name and what they need.`;
  }

  return prompt;
}

module.exports = { handleInboundMessage, getReceptionistConfig };
