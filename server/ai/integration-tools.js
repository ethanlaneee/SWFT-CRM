// ════════════════════════════════════════════════
// Integration Tools — Claude tools powered by user's connected services
// These tools are dynamically added based on what the user has connected
// ════════════════════════════════════════════════

const { google } = require("googleapis");
const { db } = require("../firebase");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "https://goswft.com/api/auth/google/callback";

function getOAuthClient(tokens) {
  const client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  client.setCredentials(tokens);
  return client;
}

// ── Tool definitions (added to Claude when user has the integration) ──

const GOOGLE_CALENDAR_TOOLS = [
  {
    name: "list_calendar_events",
    description: "List upcoming events from the user's Google Calendar. Use when the user asks about their schedule, upcoming meetings, or what's on their calendar.",
    input_schema: {
      type: "object",
      properties: {
        days_ahead: { type: "number", description: "How many days ahead to look (default 7)" },
      },
    },
  },
  {
    name: "create_calendar_event",
    description: "Create a new event on the user's Google Calendar. Use when the user wants to schedule something on their calendar, add a meeting, or book time.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title" },
        date: { type: "string", description: "Date in YYYY-MM-DD format" },
        start_time: { type: "string", description: "Start time in HH:MM format (24h)" },
        end_time: { type: "string", description: "End time in HH:MM format (24h)" },
        description: { type: "string", description: "Event description or notes" },
        location: { type: "string", description: "Event location or address" },
      },
      required: ["title", "date", "start_time", "end_time"],
    },
  },
];

const GMAIL_TOOLS = [
  {
    name: "check_gmail_inbox",
    description: "Check the user's Gmail inbox for recent messages. Use when the user asks about their emails, inbox, or recent messages.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to filter emails (e.g., 'from:client@example.com' or 'is:unread')" },
        max_results: { type: "number", description: "Max emails to return (default 5)" },
      },
    },
  },
  {
    name: "send_gmail",
    description: "Send an email via the user's Gmail. Use when the user asks to send an email, follow up with someone, or email a client.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body (plain text)" },
      },
      required: ["to", "subject", "body"],
    },
  },
];

const GOOGLE_SHEETS_TOOLS = [
  {
    name: "export_to_sheets",
    description: "Export data to a new Google Sheets spreadsheet. Use when the user asks to export customers, jobs, invoices, or quotes to a spreadsheet or Google Sheets.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Spreadsheet title (e.g., 'Customer Export March 2026')" },
        data_type: { type: "string", enum: ["customers", "jobs", "quotes", "invoices"], description: "What data to export" },
        status: { type: "string", description: "Optional status filter (e.g., 'active', 'open', 'paid')" },
      },
      required: ["title", "data_type"],
    },
  },
];

// ── Tool execution ──

async function executeIntegrationTool(toolName, input, uid) {
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) return { error: "User not found" };
  const userData = userDoc.data();
  const integrations = userData.integrations || {};

  switch (toolName) {
    case "list_calendar_events": {
      const gcal = integrations.google_calendar;
      if (!gcal?.connected || !gcal?.tokens) return { error: "Google Calendar not connected" };

      const auth = getOAuthClient(gcal.tokens);
      const calendar = google.calendar({ version: "v3", auth });

      const now = new Date();
      const future = new Date();
      future.setDate(future.getDate() + (input.days_ahead || 7));

      const res = await calendar.events.list({
        calendarId: "primary",
        timeMin: now.toISOString(),
        timeMax: future.toISOString(),
        maxResults: 15,
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = (res.data.items || []).map(e => ({
        title: e.summary || "(No title)",
        start: e.start?.dateTime || e.start?.date || "",
        end: e.end?.dateTime || e.end?.date || "",
        location: e.location || "",
        description: e.description || "",
      }));

      return { count: events.length, events };
    }

    case "create_calendar_event": {
      const gcal = integrations.google_calendar;
      if (!gcal?.connected || !gcal?.tokens) return { error: "Google Calendar not connected" };

      const auth = getOAuthClient(gcal.tokens);
      const calendar = google.calendar({ version: "v3", auth });

      const startDateTime = `${input.date}T${input.start_time}:00`;
      const endDateTime = `${input.date}T${input.end_time}:00`;

      const res = await calendar.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: input.title,
          description: input.description || "",
          location: input.location || "",
          start: { dateTime: startDateTime, timeZone: "America/Chicago" },
          end: { dateTime: endDateTime, timeZone: "America/Chicago" },
        },
      });

      return {
        success: true,
        eventId: res.data.id,
        title: res.data.summary,
        link: res.data.htmlLink,
      };
    }

    case "check_gmail_inbox": {
      const gmail = integrations.gmail;
      // Also check legacy tokens
      const tokens = gmail?.tokens || userData.gmailTokens;
      const connected = gmail?.connected || userData.gmailConnected;
      if (!connected || !tokens) return { error: "Gmail not connected" };

      const auth = getOAuthClient(tokens);
      const gmailApi = google.gmail({ version: "v1", auth });

      const query = input.query || "is:inbox";
      const maxResults = input.max_results || 5;

      const list = await gmailApi.users.messages.list({
        userId: "me",
        q: query,
        maxResults,
      });

      const messages = [];
      for (const msg of (list.data.messages || []).slice(0, maxResults)) {
        const full = await gmailApi.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        });

        const headers = full.data.payload?.headers || [];
        messages.push({
          from: headers.find(h => h.name === "From")?.value || "",
          subject: headers.find(h => h.name === "Subject")?.value || "",
          date: headers.find(h => h.name === "Date")?.value || "",
          snippet: full.data.snippet || "",
        });
      }

      return { count: messages.length, messages };
    }

    case "send_gmail": {
      const gmail = integrations.gmail;
      const tokens = gmail?.tokens || userData.gmailTokens;
      const connected = gmail?.connected || userData.gmailConnected;
      if (!connected || !tokens) return { error: "Gmail not connected" };

      const auth = getOAuthClient(tokens);
      const gmailApi = google.gmail({ version: "v1", auth });

      const raw = Buffer.from(
        `To: ${input.to}\r\n` +
        `Subject: ${input.subject}\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
        input.body
      ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

      await gmailApi.users.messages.send({
        userId: "me",
        requestBody: { raw },
      });

      return { success: true, to: input.to, subject: input.subject };
    }

    case "export_to_sheets": {
      const sheets = integrations.google_sheets;
      if (!sheets?.connected || !sheets?.tokens) return { error: "Google Sheets not connected" };

      const auth = getOAuthClient(sheets.tokens);
      const sheetsApi = google.sheets({ version: "v4", auth });
      const driveApi = google.drive({ version: "v3", auth });

      // Fetch data from Firestore based on type
      const collection = input.data_type;
      let snap = await db.collection(collection).where("userId", "==", uid).get();
      let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      if (input.status) {
        rows = rows.filter(r => r.status === input.status);
      }

      if (rows.length === 0) return { error: `No ${collection} found to export` };

      // Build header row from first item's keys
      const exclude = ["userId"];
      const keys = Object.keys(rows[0]).filter(k => !exclude.includes(k));
      const headerRow = keys;
      const dataRows = rows.map(r => keys.map(k => {
        const val = r[k];
        if (val === null || val === undefined) return "";
        if (typeof val === "object") return JSON.stringify(val);
        return String(val);
      }));

      // Create spreadsheet
      const spreadsheet = await sheetsApi.spreadsheets.create({
        requestBody: {
          properties: { title: input.title },
          sheets: [{ properties: { title: collection } }],
        },
      });

      const spreadsheetId = spreadsheet.data.spreadsheetId;
      const sheetUrl = spreadsheet.data.spreadsheetUrl;

      // Write data
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range: `${collection}!A1`,
        valueInputOption: "RAW",
        requestBody: {
          values: [headerRow, ...dataRows],
        },
      });

      return {
        success: true,
        spreadsheetId,
        url: sheetUrl,
        title: input.title,
        rows_exported: rows.length,
      };
    }

    default:
      return { error: `Unknown integration tool: ${toolName}` };
  }
}

// ── Get available tools for a user based on their connections ──

async function getIntegrationTools(uid) {
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) return [];

  const userData = userDoc.data();
  const integrations = userData.integrations || {};
  const tools = [];

  if (integrations.google_calendar?.connected) {
    tools.push(...GOOGLE_CALENDAR_TOOLS);
  }

  if (integrations.gmail?.connected || userData.gmailConnected) {
    tools.push(...GMAIL_TOOLS);
  }

  if (integrations.google_sheets?.connected) {
    tools.push(...GOOGLE_SHEETS_TOOLS);
  }

  return tools;
}

module.exports = { getIntegrationTools, executeIntegrationTool };
