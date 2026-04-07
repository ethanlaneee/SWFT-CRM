// ════════════════════════════════════════════════
// SWFT Mobile — API Client
// Mirrors the web app's swft-api.js but configured
// for the mobile app environment
// ════════════════════════════════════════════════

const API_BASE = "https://goswft.com";

let _cachedToken = null;
let _cachedTokenTime = 0;
const TOKEN_CACHE_MS = 5 * 60 * 1000;

async function getAuthToken() {
  const { getAuth } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
  const user = getAuth().currentUser;
  if (!user) {
    window.App.navigate("login");
    throw new Error("Not authenticated");
  }
  const now = Date.now();
  if (_cachedToken && (now - _cachedTokenTime) < TOKEN_CACHE_MS) {
    return _cachedToken;
  }
  const token = await user.getIdToken();
  _cachedToken = token;
  _cachedTokenTime = now;
  return token;
}

function clearTokenCache() {
  _cachedToken = null;
  _cachedTokenTime = 0;
}

async function apiFetch(path, options = {}, _retried) {
  const token = await getAuthToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error(res.ok ? "Empty response from server" : `Server error (${res.status})`);
  }
  if (!res.ok) {
    if (res.status === 401 && !_retried) {
      clearTokenCache();
      const { getAuth } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
      const user = getAuth().currentUser;
      if (user) {
        const freshToken = await user.getIdToken(true);
        _cachedToken = freshToken;
        _cachedTokenTime = Date.now();
        return apiFetch(path, options, true);
      }
    }
    throw new Error(data.error || "API error");
  }
  return data;
}

const API = {
  dashboard: {
    stats: () => apiFetch("/api/dashboard"),
  },
  user: {
    me:     ()     => apiFetch("/api/me"),
    update: (data) => apiFetch("/api/me", { method: "PUT", body: JSON.stringify(data) }),
  },
  customers: {
    list:   ()         => apiFetch("/api/customers"),
    get:    (id)       => apiFetch(`/api/customers/${id}`),
    create: (data)     => apiFetch("/api/customers", { method: "POST", body: JSON.stringify(data) }),
    update: (id, data) => apiFetch(`/api/customers/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    delete: (id)       => apiFetch(`/api/customers/${id}`, { method: "DELETE" }),
  },
  jobs: {
    list:     (status) => apiFetch(`/api/jobs${status ? `?status=${status}` : ""}`),
    get:      (id)     => apiFetch(`/api/jobs/${id}`),
    create:   (data)   => apiFetch("/api/jobs", { method: "POST", body: JSON.stringify(data) }),
    update:   (id, data) => apiFetch(`/api/jobs/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    complete: (id)     => apiFetch(`/api/jobs/${id}/complete`, { method: "POST", body: JSON.stringify({}) }),
    delete:   (id)     => apiFetch(`/api/jobs/${id}`, { method: "DELETE" }),
  },
  quotes: {
    list:    (status) => apiFetch(`/api/quotes${status ? `?status=${status}` : ""}`),
    get:     (id)     => apiFetch(`/api/quotes/${id}`),
    create:  (data)   => apiFetch("/api/quotes", { method: "POST", body: JSON.stringify(data) }),
    update:  (id, data) => apiFetch(`/api/quotes/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    send:    (id)     => apiFetch(`/api/quotes/${id}/send`, { method: "POST", body: JSON.stringify({}) }),
    delete:  (id)     => apiFetch(`/api/quotes/${id}`, { method: "DELETE" }),
  },
  invoices: {
    list:   (status)   => apiFetch(`/api/invoices${status ? `?status=${status}` : ""}`),
    get:    (id)       => apiFetch(`/api/invoices/${id}`),
    create: (data)     => apiFetch("/api/invoices", { method: "POST", body: JSON.stringify(data) }),
    update: (id, data) => apiFetch(`/api/invoices/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    send:   (id)       => apiFetch(`/api/invoices/${id}/send`, { method: "POST", body: JSON.stringify({}) }),
    delete: (id)       => apiFetch(`/api/invoices/${id}`, { method: "DELETE" }),
  },
  schedule: {
    list:   ()         => apiFetch("/api/schedule"),
    create: (data)     => apiFetch("/api/schedule", { method: "POST", body: JSON.stringify(data) }),
    update: (id, data) => apiFetch(`/api/schedule/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    delete: (id)       => apiFetch(`/api/schedule/${id}`, { method: "DELETE" }),
  },
  messages: {
    list:     ()     => apiFetch("/api/messages"),
    send:     (data) => apiFetch("/api/messages/send", { method: "POST", body: JSON.stringify(data) }),
    schedule: (data) => apiFetch("/api/messages/schedule", { method: "POST", body: JSON.stringify(data) }),
  },
  notifications: {
    list:    ()   => apiFetch("/api/notifications"),
    readAll: ()   => apiFetch("/api/notifications/read-all", { method: "POST", body: JSON.stringify({}) }),
    read:    (id) => apiFetch(`/api/notifications/${id}/read`, { method: "POST", body: JSON.stringify({}) }),
  },
  ai: {
    chat:         (message) => apiFetch("/api/ai/chat", { method: "POST", body: JSON.stringify({ message }) }),
    clearHistory: ()        => apiFetch("/api/ai/history", { method: "DELETE" }),
  },
  agents: {
    list:   ()         => apiFetch("/api/agents"),
    get:    (id)       => apiFetch(`/api/agents/${id}`),
    update: (id, data) => apiFetch(`/api/agents/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    toggle: (id)       => apiFetch(`/api/agents/${id}/toggle`, { method: "POST", body: JSON.stringify({}) }),
  },
  photos: {
    list:   (jobId)       => apiFetch(`/api/photos/job/${jobId}`),
    upload: (jobId, form) => getAuthToken().then(t => fetch(`${API_BASE}/api/photos/job/${jobId}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${t}` },
      body: form,
    }).then(r => r.json())),
    delete: (photoId) => apiFetch(`/api/photos/${photoId}`, { method: "DELETE" }),
  },
  payments: {
    invoiceLink: (id) => apiFetch(`/api/payments/invoice/${id}/link`, { method: "POST", body: JSON.stringify({}) }),
  },
  team: {
    list:       ()         => apiFetch("/api/team"),
    invite:     (data)     => apiFetch("/api/team/invite", { method: "POST", body: JSON.stringify(data) }),
    updateRole: (id, role) => apiFetch(`/api/team/${id}`, { method: "PUT", body: JSON.stringify({ role }) }),
    remove:     (id)       => apiFetch(`/api/team/${id}`, { method: "DELETE" }),
  },
  automations: {
    list:   ()         => apiFetch("/api/automations"),
    create: (data)     => apiFetch("/api/automations", { method: "POST", body: JSON.stringify(data) }),
    update: (id, data) => apiFetch(`/api/automations/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    delete: (id)       => apiFetch(`/api/automations/${id}`, { method: "DELETE" }),
  },
};

export { API, getAuthToken, clearTokenCache, API_BASE };
