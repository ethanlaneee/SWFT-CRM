/**
 * SWFT — AI Estimator Agent
 *
 * Generates quotes from job descriptions by analyzing past job data
 * and applying the org's pricing configuration.
 *
 * Uses Claude to interpret descriptions, match to historical jobs,
 * and produce structured line items with pricing.
 */

const Anthropic = require("@anthropic-ai/sdk");
const { db } = require("../firebase");

const anthropic = new Anthropic();

/**
 * Get the estimator config for an org. Returns defaults if not configured.
 */
async function getEstimatorConfig(orgId) {
  const doc = await db.collection("orgs").doc(orgId).collection("agentConfigs").doc("estimator").get();
  if (doc.exists) return doc.data();
  return {
    enabled: false,
    basePriceMin: 9,
    basePriceMax: 17,
    markupPct: 22,
    autoSend: false,
  };
}

/**
 * Fetch past completed jobs for this org to use as pricing reference.
 * Returns up to 50 recent jobs with cost/sqft/service data.
 */
async function getPastJobs(orgId) {
  const snap = await db.collection("jobs")
    .where("orgId", "==", orgId)
    .where("status", "==", "complete")
    .orderBy("completedAt", "desc")
    .limit(50)
    .get();

  return snap.docs.map(d => {
    const j = d.data();
    return {
      service: j.service || "",
      title: j.title || "",
      sqft: j.sqft || "",
      cost: j.cost || 0,
      finish: j.finish || "",
      address: j.address || "",
      description: j.description || "",
    };
  }).filter(j => j.cost > 0); // Only jobs with actual cost data
}

/**
 * Fetch recent quotes for pricing reference.
 */
async function getPastQuotes(orgId) {
  const snap = await db.collection("quotes")
    .where("orgId", "==", orgId)
    .where("status", "in", ["sent", "approved"])
    .orderBy("createdAt", "desc")
    .limit(30)
    .get();

  return snap.docs.map(d => {
    const q = d.data();
    return {
      service: q.service || "",
      sqft: q.sqft || "",
      total: q.total || 0,
      finish: q.finish || "",
      items: q.items || [],
      status: q.status,
    };
  }).filter(q => q.total > 0);
}

/**
 * Generate a quote estimate from a description.
 *
 * @param {string} orgId - Organization ID
 * @param {object} request - { description, service, sqft, finish, customerId, customerName, address }
 * @returns {{ items: Array, total: number, notes: string, confidence: string, reasoning: string }}
 */
async function generateEstimate(orgId, request) {
  const config = await getEstimatorConfig(orgId);

  const [pastJobs, pastQuotes] = await Promise.all([
    getPastJobs(orgId),
    getPastQuotes(orgId),
  ]);

  const systemPrompt = buildEstimatorPrompt(config, pastJobs, pastQuotes);

  const userMessage = [
    `Generate a quote estimate for this job:`,
    request.description ? `Description: ${request.description}` : null,
    request.service ? `Service type: ${request.service}` : null,
    request.sqft ? `Square footage: ${request.sqft}` : null,
    request.finish ? `Finish type: ${request.finish}` : null,
    request.address ? `Address: ${request.address}` : null,
  ].filter(Boolean).join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = response.content[0]?.text || "";

  // Parse the structured JSON from Claude's response
  const estimate = parseEstimateResponse(text);

  // Log the estimation for training data
  await logEstimation(orgId, request, estimate);

  return estimate;
}

/**
 * Build the system prompt with pricing context and historical data.
 */
function buildEstimatorPrompt(config, pastJobs, pastQuotes) {
  let prompt = `You are an AI estimator for a concrete/construction service business. Your job is to generate accurate quote estimates based on job descriptions.

PRICING CONFIGURATION:
- Base price range: $${config.basePriceMin} - $${config.basePriceMax} per sqft
- Markup percentage: ${config.markupPct}%
- Round totals to the nearest $50
- Minimum margin: 18%

ESTIMATION RULES:
1. Calculate: sqft x base_rate (varies by service complexity) x (1 + markup/100)
2. Add line items for materials, labor, and any extras (prep work, finishing, cleanup)
3. Factor in complexity (obstacles, grade, access difficulty)
4. Use historical data to calibrate your pricing — match similar past jobs
5. If you're unsure about sqft, estimate conservatively and note your assumption
6. Always provide a confidence level (high/medium/low)

RESPOND WITH ONLY valid JSON in this exact format:
{
  "items": [
    { "desc": "Line item description", "qty": 1, "rate": 500, "total": 500 }
  ],
  "total": 2500,
  "notes": "Brief notes about the estimate, assumptions made",
  "confidence": "high|medium|low",
  "reasoning": "Brief explanation of how you arrived at this price"
}`;

  if (pastJobs.length > 0) {
    prompt += "\n\nHISTORICAL COMPLETED JOBS (use for pricing calibration):\n";
    for (const j of pastJobs.slice(0, 20)) {
      const parts = [j.service, j.sqft ? `${j.sqft} sqft` : null, `$${j.cost}`, j.finish].filter(Boolean);
      prompt += `- ${parts.join(" · ")}\n`;
    }
  }

  if (pastQuotes.length > 0) {
    prompt += "\n\nRECENT QUOTES (approved = customer accepted this price):\n";
    for (const q of pastQuotes.slice(0, 15)) {
      const parts = [q.service, q.sqft ? `${q.sqft} sqft` : null, `$${q.total}`, q.status, q.finish].filter(Boolean);
      prompt += `- ${parts.join(" · ")}\n`;
    }
  }

  return prompt;
}

/**
 * Parse the JSON estimate from Claude's response.
 */
function parseEstimateResponse(text) {
  // Extract JSON from the response (handle markdown code blocks)
  let jsonStr = text;
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  } else {
    // Try to find raw JSON object
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) jsonStr = braceMatch[0];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    // Normalize items to canonical {desc, qty, rate, total} format
    const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
    const items = rawItems.map(i => {
      const desc = i.desc || i.description || i.name || i.label || "";
      const qty = Math.max(1, parseInt(i.qty || i.quantity, 10) || 1);
      const nRate = (i.rate != null && i.rate !== "") ? Number(i.rate) : null;
      const nAmount = (i.amount != null && i.amount !== "") ? Number(i.amount) : null;
      const nTotal = (i.total != null && i.total !== "") ? Number(i.total) : null;
      const total = (nTotal != null && nTotal > 0) ? nTotal : (nAmount != null && nAmount > 0) ? nAmount : (nRate != null && nRate > 0) ? nRate * qty : 0;
      const rate = (nRate != null && nRate > 0) ? nRate : (nAmount != null && nAmount > 0) ? nAmount : (total > 0) ? total / qty : 0;
      return { desc, qty, rate, total };
    });
    return {
      items,
      total: Number(parsed.total) || 0,
      notes: parsed.notes || "",
      confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "medium",
      reasoning: parsed.reasoning || "",
    };
  } catch {
    // Fallback if JSON parsing fails
    return {
      items: [],
      total: 0,
      notes: "Unable to generate structured estimate. Please review manually.",
      confidence: "low",
      reasoning: text.slice(0, 500),
    };
  }
}

/**
 * Log an estimation for future training/accuracy tracking.
 */
async function logEstimation(orgId, request, estimate) {
  await db.collection("orgs").doc(orgId).collection("agentActivity").add({
    agent: "estimator",
    type: "estimate_generated",
    request: {
      description: request.description || "",
      service: request.service || "",
      sqft: request.sqft || "",
      finish: request.finish || "",
      customerName: request.customerName || "",
    },
    estimate: {
      total: estimate.total,
      confidence: estimate.confidence,
      itemCount: estimate.items.length,
    },
    createdAt: Date.now(),
  });
}

module.exports = { generateEstimate, getEstimatorConfig };
