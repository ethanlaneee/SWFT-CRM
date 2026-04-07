const Anthropic = require("@anthropic-ai/sdk");
const { db } = require("../firebase");
const crmTools = require("./tools");
const getSystemPrompt = require("./system-prompt");
const { getConversationHistory, saveMessage } = require("./memory");
const { getIntegrationTools, executeIntegrationTool, syncJobToCalendar } = require("./integration-tools");
const { sendSms, getUserTwilioConfig } = require("../twilio");
const { getPlan } = require("../plans");
const { getUsage, incrementSms, incrementAiMessage } = require("../usage");
const { generateEstimate } = require("./estimator-agent");
const { normalizeItems } = require("../utils/normalizeItems");

const client = new Anthropic();

// Integration tool names — if a tool call matches one of these, route to integration handler
const INTEGRATION_TOOL_NAMES = [
  "list_calendar_events", "create_calendar_event",
  "check_gmail_inbox", "send_gmail",
  "export_to_sheets",
];

// ── Tool execution — maps tool names to Firestore operations ──

async function executeTool(toolName, input, uid, orgId) {
  // Default orgId to uid for solo users (backward compat)
  const oid = orgId || uid;

  switch (toolName) {
    case "create_customer": {
      const data = {
        orgId: oid,
        userId: uid,
        name: input.name || "",
        email: input.email || "",
        phone: input.phone || "",
        address: input.address || "",
        notes: input.notes || "",
        tags: input.tags || [],
        createdAt: Date.now(),
      };
      const ref = await db.collection("customers").add(data);
      return { id: ref.id, ...data };
    }

    case "search_customers": {
      const snap = await db.collection("customers").where("orgId", "==", oid).get();
      const q = (input.query || "").toLowerCase();
      const results = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(c =>
          c.name.toLowerCase().includes(q) ||
          (c.email && c.email.toLowerCase().includes(q)) ||
          (c.phone && c.phone.includes(q))
        );
      return { count: results.length, customers: results.slice(0, 10) };
    }

    case "update_customer": {
      const { customerId, ...updates } = input;
      const cDoc = await db.collection("customers").doc(customerId).get();
      if (!cDoc.exists || cDoc.data().orgId !== oid) return { error: "Customer not found" };
      updates.updatedAt = Date.now();
      await db.collection("customers").doc(customerId).update(updates);
      const updated = await db.collection("customers").doc(customerId).get();
      return { id: updated.id, ...updated.data() };
    }

    case "create_quote": {
      const normalizedItems = normalizeItems(input.items);
      const total = normalizedItems.reduce((sum, i) => sum + i.total, 0);
      const data = {
        orgId: oid,
        userId: uid,
        customerId: input.customerId || "",
        customerName: input.customerName || "",
        items: normalizedItems,
        total,
        notes: input.notes || "",
        status: "draft",
        createdAt: Date.now(),
      };
      const ref = await db.collection("quotes").add(data);
      return { id: ref.id, ...data };
    }

    case "list_quotes": {
      const snap = await db.collection("quotes").where("orgId", "==", oid).get();
      let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (input.status) results = results.filter(r => r.status === input.status);
      results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return { quotes: results.slice(0, 20) };
    }

    case "send_quote": {
      const qDoc = await db.collection("quotes").doc(input.quoteId).get();
      if (!qDoc.exists || qDoc.data().orgId !== oid) return { error: "Quote not found" };
      await db.collection("quotes").doc(input.quoteId).update({ status: "sent", sentAt: Date.now() });
      return { success: true, quoteId: input.quoteId, status: "sent" };
    }

    case "create_invoice": {
      const normalizedInvItems = normalizeItems(input.items);
      const total = normalizedInvItems.reduce((sum, i) => sum + i.total, 0);
      const data = {
        orgId: oid,
        userId: uid,
        customerId: input.customerId || "",
        customerName: input.customerName || "",
        quoteId: input.quoteId || null,
        items: normalizedInvItems,
        total,
        notes: input.notes || "",
        status: "open",
        dueDate: input.dueDate || null,
        createdAt: Date.now(),
      };
      const ref = await db.collection("invoices").add(data);
      return { id: ref.id, ...data };
    }

    case "list_invoices": {
      const snap = await db.collection("invoices").where("orgId", "==", oid).get();
      let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (input.status) results = results.filter(r => r.status === input.status);
      results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return { invoices: results.slice(0, 20) };
    }

    case "create_job": {
      const data = {
        orgId: oid,
        userId: uid,
        customerId: input.customerId || "",
        customerName: input.customerName || "",
        quoteId: input.quoteId || null,
        title: input.title || "",
        description: input.description || "",
        service: input.service || "",
        status: input.status || "scheduled",
        scheduledDate: input.scheduledDate || null,
        cost: input.cost || 0,
        address: input.address || "",
        assignedTo: input.assignedTo || null,
        createdAt: Date.now(),
      };
      const ref = await db.collection("jobs").add(data);

      // Auto-sync to Google Calendar if connected
      const calEvent = await syncJobToCalendar(uid, data, ref.id);

      return { id: ref.id, ...data, calendarSynced: !!calEvent };
    }

    case "list_jobs": {
      const snap = await db.collection("jobs").where("orgId", "==", oid).get();
      let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (input.status) results = results.filter(r => r.status === input.status);
      results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return { jobs: results.slice(0, 20) };
    }

    case "update_job": {
      const { jobId, ...updates } = input;
      const jDoc = await db.collection("jobs").doc(jobId).get();
      if (!jDoc.exists || jDoc.data().orgId !== oid) return { error: "Job not found" };
      updates.updatedAt = Date.now();
      await db.collection("jobs").doc(jobId).update(updates);
      const updated = await db.collection("jobs").doc(jobId).get();
      return { id: updated.id, ...updated.data() };
    }

    case "schedule_job": {
      const data = {
        orgId: oid,
        userId: uid,
        jobId: input.jobId || null,
        title: input.title || "",
        date: input.date || null,
        startTime: input.startTime || null,
        endTime: input.endTime || null,
        location: input.location || "",
        notes: input.notes || "",
        createdAt: Date.now(),
      };
      const ref = await db.collection("schedule").add(data);

      // Auto-sync to Google Calendar if connected
      const calEvent = await syncJobToCalendar(uid, data);

      return { id: ref.id, ...data, calendarSynced: !!calEvent };
    }

    case "get_dashboard_stats": {
      const [jobsSnap, quotesSnap, invoicesSnap, scheduleSnap] = await Promise.all([
        db.collection("jobs").where("orgId", "==", oid).get(),
        db.collection("quotes").where("orgId", "==", oid).get(),
        db.collection("invoices").where("orgId", "==", oid).get(),
        db.collection("schedule").where("orgId", "==", oid).get(),
      ]);

      const jobs = jobsSnap.docs.map(d => d.data());
      const invoices = invoicesSnap.docs.map(d => d.data());
      const now = Date.now();
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

      return {
        totalJobs: jobs.length,
        activeJobs: jobs.filter(j => j.status === "active").length,
        completedJobs: jobs.filter(j => j.status === "complete").length,
        monthlyRevenue: invoices
          .filter(i => i.status === "paid" && i.paidAt && i.paidAt >= thirtyDaysAgo)
          .reduce((sum, i) => sum + (i.total || 0), 0),
        totalRevenue: invoices
          .filter(i => i.status === "paid")
          .reduce((sum, i) => sum + (i.total || 0), 0),
        activeQuotes: quotesSnap.docs.filter(d => ["draft", "sent"].includes(d.data().status)).length,
        openInvoices: invoices.filter(i => i.status === "open").length,
        upcomingTasks: scheduleSnap.size,
      };
    }

    case "navigate_to_customer": {
      let address = "";
      let name = "";

      if (input.customerId) {
        const cDoc = await db.collection("customers").doc(input.customerId).get();
        if (!cDoc.exists || cDoc.data().orgId !== oid) return { error: "Customer not found" };
        address = cDoc.data().address || "";
        name = cDoc.data().name || "";
      } else if (input.customerName) {
        const snap = await db.collection("customers").where("orgId", "==", oid).get();
        const q = (input.customerName || "").toLowerCase();
        const match = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .find(c => c.name.toLowerCase().includes(q));
        if (!match) return { error: `No customer found matching "${input.customerName}"` };
        address = match.address || "";
        name = match.name || "";
      }

      if (!address) return { error: `${name || "Customer"} doesn't have an address on file` };

      const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
      return { name, address, mapsUrl };
    }

    case "send_sms": {
      try {
        // Enforce SMS cap based on user's plan
        const userDoc = await db.collection("users").doc(uid).get();
        const userPlan = getPlan(userDoc.exists ? userDoc.data().plan : undefined);
        if (userPlan.smsLimit !== Infinity) {
          const usage = await getUsage(uid);
          if (usage.smsCount >= userPlan.smsLimit) {
            return { error: `SMS limit reached (${userPlan.smsLimit}/month on the ${userPlan.name} plan). The user needs to upgrade their plan for more SMS.` };
          }
        }
        const userData = userDoc.exists ? userDoc.data() : {};
        const result = await sendSms(input.to, input.body, getUserTwilioConfig(userData));
        await incrementSms(uid);
        // Save to messages collection
        await db.collection("messages").add({
          orgId: oid,
          userId: uid,
          type: "sms",
          direction: "outbound",
          to: input.to,
          body: input.body,
          twilioSid: result.sid,
          status: result.status,
          createdAt: Date.now(),
        });
        return { success: true, to: input.to, status: result.status };
      } catch (err) {
        return { error: `SMS failed: ${err.message}` };
      }
    }

    case "get_weather": {
      try {
        // Default to Dallas, TX if no location provided
        let lat = input.latitude || 32.78;
        let lon = input.longitude || -96.80;

        // If city provided, geocode it via Open-Meteo
        if (input.city && !input.latitude) {
          const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(input.city)}&count=1&language=en&format=json`);
          const geoData = await geoRes.json();
          if (geoData.results && geoData.results[0]) {
            lat = geoData.results[0].latitude;
            lon = geoData.results[0].longitude;
          }
        }

        const weatherRes = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
          `&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m` +
          `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max` +
          `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
          `&timezone=America%2FChicago&forecast_days=3`
        );
        const weather = await weatherRes.json();

        const WMO = {
          0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
          45: "Foggy", 48: "Icy fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
          61: "Light rain", 63: "Rain", 65: "Heavy rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow",
          80: "Light showers", 81: "Showers", 82: "Heavy showers", 95: "Thunderstorm",
          96: "Thunderstorm with hail", 99: "Severe thunderstorm",
        };

        return {
          current: {
            temperature: weather.current?.temperature_2m + "°F",
            conditions: WMO[weather.current?.weather_code] || "Unknown",
            wind: weather.current?.wind_speed_10m + " mph",
            humidity: weather.current?.relative_humidity_2m + "%",
          },
          forecast: (weather.daily?.time || []).map((date, i) => ({
            date,
            high: weather.daily.temperature_2m_max[i] + "°F",
            low: weather.daily.temperature_2m_min[i] + "°F",
            conditions: WMO[weather.daily.weather_code[i]] || "Unknown",
            rain_chance: weather.daily.precipitation_probability_max[i] + "%",
          })),
        };
      } catch (err) {
        return { error: `Weather lookup failed: ${err.message}` };
      }
    }

    case "get_directions": {
      try {
        const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
        if (!MAPS_KEY) return { error: "Google Maps not configured — ask your admin to add GOOGLE_MAPS_API_KEY" };

        const params = new URLSearchParams({
          origin: input.origin,
          destination: input.destination,
          key: MAPS_KEY,
        });

        const res = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`);
        const data = await res.json();

        if (data.status !== "OK" || !data.routes?.length) {
          return { error: `Could not find directions: ${data.status}` };
        }

        const route = data.routes[0];
        const leg = route.legs[0];

        return {
          origin: leg.start_address,
          destination: leg.end_address,
          distance: leg.distance.text,
          duration: leg.duration.text,
          steps: leg.steps.slice(0, 8).map(s => s.html_instructions.replace(/<[^>]*>/g, "")),
        };
      } catch (err) {
        return { error: `Directions failed: ${err.message}` };
      }
    }

    case "list_team_members": {
      const snap = await db.collection("team").where("orgId", "==", oid).get();
      const members = snap.docs.map(d => {
        const data = d.data();
        return { id: d.id, name: data.name || "", email: data.email || "", role: data.role || "technician", status: data.status || "active" };
      });
      const roleOrder = { owner: 0, admin: 1, office: 2, technician: 3 };
      members.sort((a, b) => (roleOrder[a.role] ?? 4) - (roleOrder[b.role] ?? 4) || a.name.localeCompare(b.name));
      return { members };
    }

    case "assign_job": {
      const jDoc = await db.collection("jobs").doc(input.jobId).get();
      if (!jDoc.exists || jDoc.data().orgId !== oid) return { error: "Job not found" };
      // Verify the assignee is on this org's team
      const teamSnap = await db.collection("team").where("orgId", "==", oid).where("uid", "==", input.assigneeUid).limit(1).get();
      if (teamSnap.empty) return { error: "Team member not found" };
      const member = teamSnap.docs[0].data();
      await db.collection("jobs").doc(input.jobId).update({ assignedTo: input.assigneeUid, updatedAt: Date.now() });
      return { success: true, jobId: input.jobId, assignedTo: input.assigneeUid, assigneeName: member.name || member.email };
    }

    case "generate_estimate": {
      const estimate = await generateEstimate(oid, input);
      return estimate;
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Main agent loop — handles tool calling with Claude ──

async function runAgent(uid, userMessage, userProfile, orgId) {
  // Enforce AI message cap based on user's plan
  const plan = getPlan(userProfile.plan);
  if (plan.aiMessageLimit !== Infinity) {
    const usage = await getUsage(uid);
    if (usage.aiMessageCount >= plan.aiMessageLimit) {
      return {
        message: `You've reached your AI message limit (${plan.aiMessageLimit}/month on the ${plan.name} plan). Upgrade your plan for more AI messages.`,
        actions: [],
      };
    }
  }
  await incrementAiMessage(uid);

  // Get conversation history
  const history = await getConversationHistory(uid);

  // Save the user's message
  await saveMessage(uid, "user", userMessage);

  // Build messages array
  const messages = [
    ...history,
    { role: "user", content: userMessage },
  ];

  const systemPrompt = getSystemPrompt(userProfile.name, userProfile.company, userProfile);

  // Dynamically add integration tools based on user's connected services
  const integrationTools = await getIntegrationTools(uid);
  const allTools = [...crmTools, ...integrationTools];
  console.log("Agent tools for", uid, ":", allTools.map(t => t.name).join(", "));

  // Agent loop — keep calling Claude until it stops using tools
  let response;
  const actionsTaken = [];

  for (let i = 0; i < 10; i++) { // Max 10 tool-use rounds
    response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      tools: allTools,
      messages,
    });

    // If no tool use, we're done
    if (response.stop_reason === "end_turn" || !response.content.some(b => b.type === "tool_use")) {
      break;
    }

    // Process tool calls
    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    const toolResults = [];
    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        // Route to integration handler or CRM handler
        let result;
        try {
          result = INTEGRATION_TOOL_NAMES.includes(block.name)
            ? await executeIntegrationTool(block.name, block.input, uid)
            : await executeTool(block.name, block.input, uid, orgId);
        } catch (toolErr) {
          console.error(`Tool ${block.name} failed:`, toolErr.message);
          result = { error: `Tool failed: ${toolErr.message}` };
        }
        actionsTaken.push({ tool: block.name, input: block.input, result });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Extract the final text response
  const textBlocks = response.content.filter(b => b.type === "text");
  const finalText = textBlocks.map(b => b.text).join("\n");

  // Save assistant response
  await saveMessage(uid, "assistant", finalText);

  return {
    message: finalText,
    actions: actionsTaken,
  };
}

module.exports = { runAgent };
