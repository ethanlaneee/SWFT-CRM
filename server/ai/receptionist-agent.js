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
  if (!doc.exists) return null;
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

  // Build system prompt
  const systemPrompt = buildReceptionistPrompt(config, owner, customer);

  // Call Claude
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
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
 * Build the system prompt for the receptionist.
 */
function buildReceptionistPrompt(config, owner, customer) {
  const companyName = owner.company || owner.name || "our company";
  const ownerName = owner.name || "the owner";
  const tone = config.tone === "casual" ? "casual and friendly" : "friendly and professional";

  let prompt = `You are an AI receptionist for ${companyName}. You respond to inbound text messages from customers and potential leads.

TONE: Be ${tone}. Keep messages SHORT (1-3 sentences max). Sound human, not robotic. No emojis overload — one max per message if appropriate.

YOUR CAPABILITIES:
- Answer basic questions about services, availability, and pricing
- Qualify leads (what service they need, their address, timeline)
- Encourage them to book an estimate
- Confirm existing appointments
- Take messages for the owner

RULES:
1. NEVER make up specific prices, dates, or availability — say you'll check and get back to them
2. If someone asks for specific pricing, say "${ownerName} will follow up with a custom quote"
3. If you can't handle a request or the person seems upset, include [ESCALATE] at the END of your message (it will be stripped before sending)
4. Keep responses under 160 characters when possible (SMS length)
5. If this is a brand new conversation, greet them warmly
6. If someone says "stop" or "unsubscribe", acknowledge and include [ESCALATE]`;

  if (config.greeting) {
    prompt += `\n\nSUGGESTED GREETING STYLE: "${config.greeting}"`;
  }

  if (customer) {
    prompt += `\n\nTHIS IS AN EXISTING CUSTOMER:
- Name: ${customer.customerName || "Unknown"}
- They are already in our system, so be more familiar and helpful.`;
  } else {
    prompt += `\n\nTHIS IS A NEW/UNKNOWN NUMBER — treat them as a potential lead. Try to get their name and what service they need.`;
  }

  return prompt;
}

module.exports = { handleInboundMessage, getReceptionistConfig };
