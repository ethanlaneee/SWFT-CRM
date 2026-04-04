// ════════════════════════════════════════════════
// Manus API Client
// Handles communication with the Manus AI agent API
// ════════════════════════════════════════════════

const MANUS_BASE_URL = "https://api.manus.ai/v2";
const MANUS_API_KEY = process.env.MANUS_API_KEY || "";

const POLL_INTERVAL = 2000; // 2 seconds between polls
const MAX_POLL_TIME = 120000; // 2 minute max wait

// ── Helper: make authenticated Manus API requests ──

async function manusRequest(method, endpoint, body) {
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-manus-api-key": MANUS_API_KEY,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${MANUS_BASE_URL}${endpoint}`, opts);
  const data = await res.json();

  if (!data.ok) {
    const code = data.error?.code || "unknown";
    const msg = data.error?.message || "Manus API error";
    throw new Error(`Manus ${code}: ${msg}`);
  }
  return data;
}

// ── Create a new task ──

async function createTask(prompt, connectorIds = []) {
  const message = {
    content: [{ type: "text", text: prompt }],
  };
  if (connectorIds.length > 0) {
    message.connectors = connectorIds;
  }

  return manusRequest("POST", "/task.create", {
    message,
    interactive_mode: false,
  });
}

// ── Get task details ──

async function getTaskDetail(taskId) {
  return manusRequest("GET", `/task.detail?task_id=${encodeURIComponent(taskId)}`);
}

// ── List messages for a task ──

async function listMessages(taskId, order = "desc", limit = 20) {
  const params = new URLSearchParams({ task_id: taskId, order, limit: String(limit) });
  return manusRequest("GET", `/task.listMessages?${params}`);
}

// ── Send a follow-up message to an existing task ──

async function sendMessage(taskId, text) {
  return manusRequest("POST", "/task.sendMessage", {
    task_id: taskId,
    message: {
      content: [{ type: "text", text }],
    },
  });
}

// ── List available connectors for this API key ──

async function listConnectors() {
  return manusRequest("GET", "/connector.list");
}

// ── Poll a task until it completes or times out ──
// Returns the final assistant message text

async function pollTaskUntilDone(taskId) {
  const start = Date.now();

  while (Date.now() - start < MAX_POLL_TIME) {
    const detail = await getTaskDetail(taskId);
    const status = detail.task?.status;

    if (status === "stopped") {
      // Task completed — get the assistant's response
      return extractFinalResponse(taskId);
    }

    if (status === "error") {
      throw new Error("Manus task failed — please try again");
    }

    if (status === "waiting") {
      // Agent is asking for user input — we can't handle this in auto mode
      // Return what we have so far
      return extractFinalResponse(taskId);
    }

    // Still running — wait and poll again
    await sleep(POLL_INTERVAL);
  }

  // Timed out — return whatever we have
  return extractFinalResponse(taskId);
}

// ── Extract the final assistant response from task messages ──

async function extractFinalResponse(taskId) {
  const data = await listMessages(taskId, "desc", 20);
  const messages = data.messages || data.data || [];

  // Look for the last assistant message
  for (const msg of messages) {
    if (msg.role === "assistant" || msg.type === "assistant_message") {
      const content = msg.content || msg.text || msg.message || "";
      if (typeof content === "string" && content.trim()) return content.trim();
      if (Array.isArray(content)) {
        const text = content
          .filter(c => c.type === "text")
          .map(c => c.text)
          .join("\n");
        if (text.trim()) return text.trim();
      }
    }
  }

  return "I'm still working on that — check back in a moment.";
}

// ── Run a complete Manus task: create → poll → return response ──

async function runManusTask(prompt, connectorIds = []) {
  const task = await createTask(prompt, connectorIds);
  const taskId = task.task_id;
  const taskUrl = task.task_url || null;

  const message = await pollTaskUntilDone(taskId);

  return {
    message,
    taskId,
    taskUrl,
    source: "manus",
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  createTask,
  getTaskDetail,
  listMessages,
  sendMessage,
  listConnectors,
  pollTaskUntilDone,
  runManusTask,
};
