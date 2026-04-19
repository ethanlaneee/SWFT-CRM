/**
 * SWFT Phone AI — Vapi assistant builder and phone provisioning helpers.
 *
 * Consumed by server/routes/phone.js for:
 *   - Building Claude system prompts from org business data
 *   - Creating / updating Vapi voice assistants
 *   - Provisioning and releasing phone numbers via Vapi
 */

const { db } = require("../firebase");

const VAPI_BASE = "https://api.vapi.ai";
const LOCKED_MODEL = "claude-haiku-4-5-20251001";

// ── System prompt builder ─────────────────────────────────────────────────────

function buildPhoneSystemPrompt(orgData = {}, phoneSettings = {}) {
  const companyName   = orgData.companyName   || orgData.businessName || "this business";
  const services      = Array.isArray(orgData.services) ? orgData.services.join(", ") : (orgData.services || "home services");
  const serviceArea   = orgData.serviceArea   || "";
  const businessHours = orgData.businessHours || "regular business hours";

  const greeting            = phoneSettings.greeting            || `Thanks for calling ${companyName}!`;
  const customInstructions  = phoneSettings.customInstructions  || "";
  const collectName         = phoneSettings.collectName         !== false;
  const collectEmail        = phoneSettings.collectEmail        === true;
  const collectAddress      = phoneSettings.collectAddress      === true;
  const collectJobDetails   = phoneSettings.collectJobDetails   !== false;

  const collectLines = [
    collectName       ? "- Their full name" : null,
    collectEmail      ? "- Their email address" : null,
    collectAddress    ? "- The service address" : null,
    collectJobDetails ? "- A brief description of the job or issue" : null,
  ].filter(Boolean).join("\n");

  return `You are a friendly, professional phone receptionist for ${companyName}. You answer calls on behalf of the business owner and take messages so no lead is ever lost.

Business Info:
- Company: ${companyName}
- Services: ${services}${serviceArea ? `\n- Service Area: ${serviceArea}` : ""}
- Hours: ${businessHours}

Your job:
1. Greet the caller warmly — your opening line: "${greeting}"
2. Understand why they are calling — what service they need or what problem they have
3. Collect their contact information:
${collectLines}
4. Let them know the owner will call them back as soon as possible
5. Thank them and close the call warmly

Rules:
- Never quote prices or make scheduling commitments on behalf of the business
- Keep replies short and conversational — this is a live phone call, not an email
- If asked about services, hours, or service area, answer using the business info above
- Always confirm you have the caller's information before ending the call
- Be empathetic — callers are often stressed about a home problem${customInstructions ? `\n\nAdditional instructions from the owner:\n${customInstructions}` : ""}`;
}

// ── Vapi API helper ───────────────────────────────────────────────────────────

async function vapiRequest(method, path, body) {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) throw new Error("VAPI_API_KEY is not configured");

  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${VAPI_BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Vapi ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Assistant management ──────────────────────────────────────────────────────

function buildAssistantPayload(orgData, phoneSettings, orgId) {
  const companyName = orgData.companyName || orgData.businessName || "Business";
  const appUrl      = process.env.APP_URL || "https://goswft.com";

  return {
    name: `${companyName} — SWFT Phone Agent`,
    model: {
      provider: "anthropic",
      model: LOCKED_MODEL,
      messages: [{ role: "system", content: buildPhoneSystemPrompt(orgData, phoneSettings) }],
      maxTokens: 200,
      temperature: 0.6,
    },
    voice: {
      provider: "playht",
      voiceId: phoneSettings.voiceId || "jennifer",
    },
    firstMessage: phoneSettings.greeting || `Thanks for calling ${companyName}! How can I help you today?`,
    endCallMessage: "Perfect — I've got all your information. Someone from our team will be in touch very shortly. Have a great day!",
    transcriber: {
      provider: "deepgram",
      model: "nova-2",
      language: "en",
    },
    recordingEnabled: true,
    serverUrl: `${appUrl}/api/phone/vapi-webhook`,
    serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET || "",
    metadata: { orgId },
  };
}

async function getOrCreateVapiAssistant(orgId, orgData, phoneSettings) {
  const settingsDoc = await db.collection("phoneSettings").doc(orgId).get();
  const existingId  = settingsDoc.exists ? settingsDoc.data().vapiAssistantId : null;
  const payload     = buildAssistantPayload(orgData, phoneSettings, orgId);

  if (existingId) {
    await vapiRequest("PATCH", `/assistant/${existingId}`, payload);
    return existingId;
  }

  const created = await vapiRequest("POST", "/assistant", payload);
  return created.id;
}

// ── Phone number provisioning ─────────────────────────────────────────────────

async function provisionPhoneNumber(vapiAssistantId, country, areaCode) {
  const body = {
    provider: "twilio",
    assistantId: vapiAssistantId,
    country: country || "US",
  };
  if (areaCode) body.numberDesiredAreaCode = String(areaCode);

  const data = await vapiRequest("POST", "/phone-number", body);
  return { phoneNumberId: data.id, phoneNumber: data.number };
}

async function releasePhoneNumber(phoneNumberId) {
  if (!phoneNumberId) return;
  try {
    await vapiRequest("DELETE", `/phone-number/${phoneNumberId}`, null);
  } catch (err) {
    console.error("[phone-agent] releasePhoneNumber failed:", err.message);
  }
}

module.exports = {
  buildPhoneSystemPrompt,
  getOrCreateVapiAssistant,
  provisionPhoneNumber,
  releasePhoneNumber,
};
