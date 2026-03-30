/**
 * SWFT CORE AGENT — v1.0
 * ========================
 * Days 1–6 build, all in one file.
 *
 * What this does:
 * 1. Receives a missed call webhook from Twilio
 * 2. Texts the customer back within 60 seconds as the owner
 * 3. Holds a qualifying conversation via SMS using Claude
 * 4. Notifies the owner with a clean lead summary
 *
 * Stack: Node.js + Express + Twilio + Anthropic API + Firebase
 *
 * SETUP (do this before running):
 * npm install express twilio @anthropic-ai/sdk firebase-admin dotenv
 *
 * ENV VARS NEEDED (.env file):
 * TWILIO_ACCOUNT_SID=
 * TWILIO_AUTH_TOKEN=
 * TWILIO_PHONE_NUMBER=       ← your Twilio number (e.g. +14031234567)
 * ANTHROPIC_API_KEY=
 * FIREBASE_PROJECT_ID=       ← swft-ai26
 * GOOGLE_APPLICATION_CREDENTIALS=./firebase-service-account.json
 */

require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const admin = require('firebase-admin');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── CLIENTS ────────────────────────────────────────────────────────────────

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Firebase init
const serviceAccount = require('./firebase-service-account.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID,
});
const db = admin.firestore();

// ─── IN-MEMORY CONVERSATION STORE ───────────────────────────────────────────
// Stores active SMS conversations keyed by customer phone number.
// In production this would be Firestore — using memory here for simplicity.
const conversations = {};

// ─── BUSINESS CONFIG ─────────────────────────────────────────────────────────
// In production this is fetched from Firestore per tenant.
// For now, one config object you edit directly during testing.
const BUSINESS = {
  ownerName: 'Mike',
  businessName: 'Calgary Concrete Co.',
  ownerPhone: '+14031110000',   // ← REPLACE with your real number
  services: ['concrete driveways', 'patios', 'sidewalks', 'garage pads'],
  serviceArea: 'Calgary and surrounding areas (Airdrie, Cochrane, Chestermere)',
  tone: 'friendly and casual',  // or 'professional'
  avgJobValue: 2500,            // used to estimate rescued revenue
};

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────
// This is what makes the agent sound like the owner, not a robot.
function buildSystemPrompt(business) {
  return `You are a helpful assistant texting on behalf of ${business.ownerName}, the owner of ${business.businessName}.

A customer just tried to call ${business.ownerName} but he missed the call because he's out on a job.
Your job is to text the customer back immediately, keep them warm, and find out what they need.

IMPORTANT RULES:
- NEVER say you are an AI, bot, or assistant. You ARE ${business.ownerName}'s messaging system.
- Sound ${business.tone}. Real. Human. Like a busy contractor texting between jobs.
- Keep messages SHORT — 1-3 sentences max. This is SMS, not email.
- The business offers: ${business.services.join(', ')}.
- Service area: ${business.serviceArea}.
- Your goal is to qualify the lead by finding out:
  1. What service they need
  2. Where the job is located
  3. Rough timeline (urgent / this season / planning ahead)
- Once you have all 3, tell them ${business.ownerName} will follow up personally to book a time.
- Do NOT give specific pricing. Say "Mike will go over pricing when he follows up."
- If they ask something you can't answer, say "I'll make sure Mike gets back to you on that."

When you have gathered all 3 qualification points, end your response with this exact tag on a new line:
[QUALIFIED]

Do not use [QUALIFIED] until you have job type, location, AND timeline.`;
}

// ─── ROUTE: MISSED CALL WEBHOOK (Twilio) ─────────────────────────────────────
/**
 * Twilio calls this URL when a call goes unanswered.
 * Set this as your Twilio number's "Call Status Callback URL" in the Twilio console.
 * Also set: Voice → "A call comes in" → TwiML → <Reject> or forward to voicemail.
 *
 * Twilio webhook URL: https://your-domain.com/missed-call
 */
app.post('/missed-call', async (req, res) => {
  const callStatus = req.body.CallStatus;
  const customerPhone = req.body.From;
  const calledPhone = req.body.To;

  console.log(`📞 Call event: ${callStatus} from ${customerPhone}`);

  // Only fire on no-answer or busy — not on completed calls
  const missedStatuses = ['no-answer', 'busy', 'failed'];
  if (!missedStatuses.includes(callStatus)) {
    return res.status(200).send('OK');
  }

  // Don't fire twice for the same customer if already in a conversation
  if (conversations[customerPhone]) {
    console.log(`⚠️  Already in conversation with ${customerPhone}, skipping.`);
    return res.status(200).send('OK');
  }

  console.log(`🚨 Missed call from ${customerPhone} — firing SWFT response...`);

  // Build the first message
  const openingMessage = `Hey! It's ${BUSINESS.ownerName} from ${BUSINESS.businessName} — sorry I missed your call, I'm out on a job right now. What can I help you with?`;

  // Initialize conversation in memory
  conversations[customerPhone] = {
    messages: [],         // Claude conversation history
    qualified: false,
    startedAt: new Date().toISOString(),
    customerPhone,
    businessConfig: BUSINESS,
  };

  try {
    // Send the opening text within 60 seconds of missed call
    await twilioClient.messages.create({
      body: openingMessage,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: customerPhone,
    });

    console.log(`✅ Opening text sent to ${customerPhone}`);

    // Log to Firestore
    await db.collection('leads').add({
      customerPhone,
      status: 'opened',
      openingMessage,
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      businessId: 'default', // multi-tenant key in production
    });
  } catch (err) {
    console.error('❌ Failed to send opening text:', err.message);
  }

  res.status(200).send('OK');
});

// ─── ROUTE: INCOMING SMS REPLY (Twilio) ──────────────────────────────────────
/**
 * Twilio calls this URL when the customer replies to the agent's text.
 * Set this as your Twilio number's "A message comes in" webhook URL.
 *
 * Twilio webhook URL: https://your-domain.com/sms
 */
app.post('/sms', async (req, res) => {
  const customerPhone = req.body.From;
  const incomingMessage = req.body.Body?.trim();

  console.log(`💬 SMS from ${customerPhone}: "${incomingMessage}"`);

  // If no active conversation, customer is texting cold (not from a missed call)
  // Still handle it gracefully
  if (!conversations[customerPhone]) {
    conversations[customerPhone] = {
      messages: [],
      qualified: false,
      startedAt: new Date().toISOString(),
      customerPhone,
      businessConfig: BUSINESS,
    };
  }

  const convo = conversations[customerPhone];

  // If already qualified, just acknowledge and tell them owner will follow up
  if (convo.qualified) {
    await twilioClient.messages.create({
      body: `Thanks! ${BUSINESS.ownerName} has everything he needs and will follow up with you soon.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: customerPhone,
    });
    return res.status(200).send('OK');
  }

  // Add customer message to history
  convo.messages.push({
    role: 'user',
    content: incomingMessage,
  });

  try {
    // Call Claude to generate the next agent response
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: buildSystemPrompt(BUSINESS),
      messages: convo.messages,
    });

    const agentReply = response.content[0].text.trim();

    // Check if agent has finished qualifying
    const isQualified = agentReply.includes('[QUALIFIED]');
    const cleanReply = agentReply.replace('[QUALIFIED]', '').trim();

    // Add agent response to history
    convo.messages.push({
      role: 'assistant',
      content: agentReply,
    });

    // Send the SMS reply
    await twilioClient.messages.create({
      body: cleanReply,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: customerPhone,
    });

    console.log(`🤖 Agent replied to ${customerPhone}: "${cleanReply}"`);

    // If qualified, notify the owner and save lead
    if (isQualified) {
      convo.qualified = true;
      console.log(`✅ Lead qualified: ${customerPhone}`);
      await notifyOwner(customerPhone, convo);
    }

    // Update Firestore with latest conversation
    await db.collection('leads')
      .where('customerPhone', '==', customerPhone)
      .limit(1)
      .get()
      .then(snapshot => {
        if (!snapshot.empty) {
          snapshot.docs[0].ref.update({
            messages: convo.messages,
            qualified: convo.qualified,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      });
  } catch (err) {
    console.error('❌ Agent error:', err.message);
    // Fallback — never leave customer hanging
    await twilioClient.messages.create({
      body: `Thanks for your message! ${BUSINESS.ownerName} will get back to you as soon as he's free.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: customerPhone,
    });
  }

  res.status(200).send('OK');
});

// ─── NOTIFY OWNER ─────────────────────────────────────────────────────────────
/**
 * Once a lead is qualified, send the owner a clean plain-English summary via SMS.
 * Also saves the structured lead to Firestore for the dashboard.
 */
async function notifyOwner(customerPhone, convo) {
  try {
    // Ask Claude to extract a clean summary from the conversation
    const summaryResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `You extract lead summaries from SMS conversations. Return ONLY a JSON object with these fields: { "customerName": "first name if mentioned, otherwise 'Customer'", "jobType": "what service they need", "location": "where the job is", "timeline": "when they want it done", "notes": "anything else relevant in one sentence" } Return raw JSON only. No markdown, no explanation.`,
      messages: [
        {
          role: 'user',
          content: `Extract the lead summary from this conversation:\n\n${convo.messages.map(m => `${m.role === 'user' ? 'Customer' : 'Agent'}: ${m.content}`).join('\n')}`,
        },
      ],
    });

    let lead = {};
    try {
      lead = JSON.parse(summaryResponse.content[0].text.trim());
    } catch {
      lead = {
        customerName: 'Customer',
        jobType: 'Unknown',
        location: 'Unknown',
        timeline: 'Unknown',
        notes: '',
      };
    }

    // Build owner notification SMS
    const ownerSMS = [
      `📋 SWFT — New Lead Rescued`,
      `━━━━━━━━━━━━━━━━`,
      `👤 ${lead.customerName} (${customerPhone})`,
      `🔨 ${lead.jobType}`,
      `📍 ${lead.location}`,
      `📅 ${lead.timeline}`,
      lead.notes ? `💬 ${lead.notes}` : null,
      `━━━━━━━━━━━━━━━━`,
      `Reply to them: ${customerPhone}`,
    ].filter(Boolean).join('\n');

    await twilioClient.messages.create({
      body: ownerSMS,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: BUSINESS.ownerPhone,
    });

    console.log(`📨 Owner notified about lead from ${customerPhone}`);

    // Save structured lead to Firestore
    await db.collection('qualified-leads').add({
      ...lead,
      customerPhone,
      qualifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      conversationLength: convo.messages.length,
      estimatedValue: BUSINESS.avgJobValue,
      status: 'new',
      businessId: 'default',
    });
  } catch (err) {
    console.error('❌ Owner notification failed:', err.message);
  }
}

// ─── ROUTE: HEALTH CHECK ──────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'SWFT Agent running',
    activeConversations: Object.keys(conversations).length,
    business: BUSINESS.businessName,
  });
});

// ─── ROUTE: MANUAL TEST ───────────────────────────────────────────────────────
// Hit this endpoint to simulate a missed call without needing a real Twilio event.
// POST /test-missed-call with body: { "from": "+14031234567" }
app.post('/test-missed-call', async (req, res) => {
  const fakePhone = req.body.from || '+14031234567';
  console.log(`🧪 Simulating missed call from ${fakePhone}`);

  // Inject a fake Twilio webhook body and call the handler
  req.body = {
    CallStatus: 'no-answer',
    From: fakePhone,
    To: process.env.TWILIO_PHONE_NUMBER,
  };

  // Re-use missed call logic
  const customerPhone = fakePhone;
  const openingMessage = `Hey! It's ${BUSINESS.ownerName} from ${BUSINESS.businessName} — sorry I missed your call, I'm out on a job right now. What can I help you with?`;

  conversations[customerPhone] = {
    messages: [],
    qualified: false,
    startedAt: new Date().toISOString(),
    customerPhone,
    businessConfig: BUSINESS,
  };

  res.json({
    status: 'Simulated missed call',
    wouldSend: openingMessage,
    to: customerPhone,
    note: 'In production this SMS would fire to the customer immediately.',
  });
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 SWFT Agent live on port ${PORT}`);
  console.log(`   Business: ${BUSINESS.businessName}`);
  console.log(`   Owner: ${BUSINESS.ownerName} (${BUSINESS.ownerPhone})`);
  console.log(`\n   Endpoints:`);
  console.log(`   POST /missed-call     ← Twilio status callback`);
  console.log(`   POST /sms            ← Twilio incoming SMS`);
  console.log(`   POST /test-missed-call ← Manual test`);
  console.log(`   GET  /               ← Health check\n`);
});
