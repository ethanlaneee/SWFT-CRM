// ════════════════════════════════════════════════
// AI Router — decides whether a message goes to Claude or Manus
//
// Claude handles: CRM operations (customers, jobs, quotes, invoices, schedule, stats)
// Manus handles: external tool tasks, cross-app automation, web lookups, anything
//                the user's connected tools can help with
// ════════════════════════════════════════════════

// Keywords and patterns that indicate CRM operations → route to Claude
const CRM_PATTERNS = [
  // Customers
  /\b(add|create|new|find|search|update|edit|delete|remove)\b.*\b(customer|client|contact|homeowner)\b/i,
  /\bcustomer/i,
  // Quotes
  /\b(create|new|send|list|show|draft)\b.*\b(quote|estimate|proposal)\b/i,
  /\bquote/i,
  /\bestimate/i,
  // Invoices
  /\b(create|new|send|list|show|open|paid|overdue)\b.*\b(invoice|bill)\b/i,
  /\binvoice/i,
  // Jobs
  /\b(create|new|schedule|list|show|active|complete|update)\b.*\b(job|work order|service call)\b/i,
  /\bjob/i,
  // Schedule
  /\bschedule\b/i,
  /\bcalendar\b/i,
  // Dashboard / stats
  /\b(how'?s?\s+business|dashboard|stats|revenue|performance|overview)\b/i,
  /\bhow\s+(are|is)\s+(things|it|everything)\s+(going|looking)\b/i,
  // Direct CRM data actions
  /\b(show|list|get|pull|find)\s+(me\s+)?(my\s+)?(all\s+)?(open|active|pending|overdue|recent|draft|sent|approved)\b/i,
];

// Keywords that indicate external tool / Manus tasks
const MANUS_PATTERNS = [
  /\b(quickbooks|xero|freshbooks|wave)\b/i,
  /\b(sync|integrate|connect|import|export)\b.*\b(to|from|with)\b/i,
  /\b(slack|notion|trello|asana|zapier|hubspot|mailchimp)\b/i,
  /\b(google\s+sheets?|google\s+docs?|google\s+drive|spreadsheet)\b/i,
  /\b(look\s+up|research|browse|search\s+the\s+web|find\s+online)\b/i,
  /\b(email|gmail)\b.*\b(check|read|send|draft|inbox)\b/i,
  /\bconnected\s+tools?\b/i,
];

/**
 * Determines whether a message should be routed to Claude or Manus.
 *
 * @param {string} message - The user's message
 * @param {string[]} userConnectors - Connector IDs the user has enabled
 * @returns {"claude" | "manus"}
 */
function routeMessage(message, userConnectors = []) {
  // If Manus isn't configured, always use Claude
  if (!process.env.MANUS_API_KEY) return "claude";

  const crmScore = CRM_PATTERNS.reduce((score, pattern) => score + (pattern.test(message) ? 1 : 0), 0);
  const manusScore = MANUS_PATTERNS.reduce((score, pattern) => score + (pattern.test(message) ? 1 : 0), 0);

  // If the user has connectors and the message looks external, prefer Manus
  if (userConnectors.length > 0 && manusScore > 0) return "manus";

  // Strong CRM signal → Claude
  if (crmScore > 0 && manusScore === 0) return "claude";

  // Strong Manus signal → Manus
  if (manusScore > 0 && crmScore === 0) return "manus";

  // Both signals → CRM wins (it's faster and more reliable for CRM tasks)
  if (crmScore >= manusScore) return "claude";

  // Default: Claude handles general chat
  return "claude";
}

module.exports = { routeMessage };
