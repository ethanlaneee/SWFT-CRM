// ════════════════════════════════════════════════
// SWFT — Frontend API Client
// Include this in every page before page-specific JS
//
// <script src="swft-api.js"></script>
//
// Usage:
//   const jobs = await API.jobs.list();
//   const job  = await API.jobs.get(id);
//   await API.jobs.create({ title, service, ... });
//   await API.jobs.update(id, { status: 'complete' });
// ════════════════════════════════════════════════

const API_BASE = ""; // Uses same origin (works for both localhost and deployed)

// ── Get the Firebase ID token for the current user ──
// Requires Firebase SDK to be loaded on the page
// Caches token and reuses for 5 minutes to avoid hammering Firebase
let _cachedToken = null;
let _cachedTokenTime = 0;
const TOKEN_CACHE_MS = 5 * 60 * 1000; // 5 minutes

async function getAuthToken() {
  const { getAuth } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
  const user = getAuth().currentUser;
  if (!user) {
    window.location.href = "swft-login";
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

// ── Base fetch wrapper ──
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
    // On 401, force-refresh the token and retry once
    if (res.status === 401 && !_retried) {
      _cachedToken = null;
      _cachedTokenTime = 0;
      const { getAuth } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
      const user = getAuth().currentUser;
      if (user) {
        const freshToken = await user.getIdToken(true);
        _cachedToken = freshToken;
        _cachedTokenTime = Date.now();
        return apiFetch(path, options, true);
      }
    }
    const msg = data.error || "API error";
    if (res.status === 403 && typeof window !== "undefined" && typeof window.swftNoPermission === "function") {
      window.swftNoPermission(msg);
    }
    throw new Error(msg);
  }
  return data;
}

// ════════════════════════════════════════════════
// API NAMESPACES
// ════════════════════════════════════════════════

const API = {

  // ── Dashboard ──
  dashboard: {
    stats: () => apiFetch("/api/dashboard"),
  },

  // ── Dev (admin only) ──
  dev: {
    stats:  ()   => apiFetch("/api/dev/stats"),
    users:  ()   => apiFetch("/api/dev/users"),
    user:   (id) => apiFetch(`/api/dev/user/${id}`),
  },

  // ── User ──
  user: {
    me:     ()       => apiFetch("/api/me"),
    update: (data)   => apiFetch("/api/me", { method: "PUT", body: JSON.stringify(data) }),
  },

  // ── Customers ──
  customers: {
    list:   ()       => apiFetch("/api/customers"),
    get:    (id)     => apiFetch(`/api/customers/${id}`),
    create: (data)   => apiFetch("/api/customers",      { method: "POST",   body: JSON.stringify(data) }),
    update: (id, data) => apiFetch(`/api/customers/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    delete: (id)     => apiFetch(`/api/customers/${id}`, { method: "DELETE" }),
    bulkDelete: (ids)=> apiFetch("/api/customers/bulk-delete", { method: "POST", body: JSON.stringify({ ids }) }),
  },

  // ── Jobs ──
  jobs: {
    list:     (status) => apiFetch(`/api/jobs${status ? `?status=${status}` : ""}`),
    get:      (id)     => apiFetch(`/api/jobs/${id}`),
    create:   (data)   => apiFetch("/api/jobs",         { method: "POST",   body: JSON.stringify(data) }),
    update:   (id, data) => apiFetch(`/api/jobs/${id}`, { method: "PUT",    body: JSON.stringify(data) }),
    complete: (id)     => apiFetch(`/api/jobs/${id}/complete`, { method: "POST", body: JSON.stringify({}) }),
    delete:   (id)     => apiFetch(`/api/jobs/${id}`,   { method: "DELETE" }),
  },

  // ── Quotes ──
  quotes: {
    list:    (status) => apiFetch(`/api/quotes${status ? `?status=${status}` : ""}`),
    get:     (id)     => apiFetch(`/api/quotes/${id}`),
    create:  (data)   => apiFetch("/api/quotes",         { method: "POST",   body: JSON.stringify(data) }),
    update:  (id, data) => apiFetch(`/api/quotes/${id}`, { method: "PUT",    body: JSON.stringify(data) }),
    send:    (id)     => apiFetch(`/api/quotes/${id}/send`,    { method: "POST", body: JSON.stringify({}) }),
    email:   (id, msg) => apiFetch(`/api/quotes/${id}/email`,  { method: "POST", body: JSON.stringify({ message: msg || "" }) }),
    approve: (id)     => apiFetch(`/api/quotes/${id}/approve`, { method: "POST", body: JSON.stringify({}) }),
    delete:  (id)     => apiFetch(`/api/quotes/${id}`,   { method: "DELETE" }),
  },

  // ── Invoices ──
  invoices: {
    list:   (status) => apiFetch(`/api/invoices${status ? `?status=${status}` : ""}`),
    get:    (id)     => apiFetch(`/api/invoices/${id}`),
    create: (data)   => apiFetch("/api/invoices",         { method: "POST",   body: JSON.stringify(data) }),
    update: (id, data) => apiFetch(`/api/invoices/${id}`, { method: "PUT",    body: JSON.stringify(data) }),
    send:   (id)     => apiFetch(`/api/invoices/${id}/send`,  { method: "POST", body: JSON.stringify({}) }),
    email:  (id, msg) => apiFetch(`/api/invoices/${id}/email`, { method: "POST", body: JSON.stringify({ message: msg || "" }) }),
    pay:    (id, data) => apiFetch(`/api/invoices/${id}/pay`, { method: "POST", body: JSON.stringify(data) }),
    delete: (id)     => apiFetch(`/api/invoices/${id}`,   { method: "DELETE" }),
  },

  // ── Schedule ──
  schedule: {
    list:   ()         => apiFetch("/api/schedule"),
    create: (data)     => apiFetch("/api/schedule",         { method: "POST",   body: JSON.stringify(data) }),
    update: (id, data) => apiFetch(`/api/schedule/${id}`,   { method: "PUT",    body: JSON.stringify(data) }),
    delete: (id)       => apiFetch(`/api/schedule/${id}`,   { method: "DELETE" }),
  },

  // ── AI Agent ──
  ai: {
    chat:         (message) => apiFetch("/api/ai/chat", { method: "POST", body: JSON.stringify({ message }) }),
    clearHistory: ()        => apiFetch("/api/ai/history", { method: "DELETE" }),
  },

  // ── AI Agents ──
  agents: {
    list:     ()           => apiFetch("/api/agents"),
    get:      (id)         => apiFetch(`/api/agents/${id}`),
    update:   (id, data)   => apiFetch(`/api/agents/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    toggle:   (id)         => apiFetch(`/api/agents/${id}/toggle`, { method: "POST", body: JSON.stringify({}) }),
    activity: (id)         => apiFetch(`/api/agents/${id}/activity`),
    automationStats: ()    => apiFetch("/api/agents/automations/stats"),
    conversationMode:    (customerId)       => apiFetch(`/api/agents/conversations/${encodeURIComponent(customerId)}/mode`),
    setConversationMode: (customerId, mode) => apiFetch(`/api/agents/conversations/${encodeURIComponent(customerId)}/mode`, { method: "PUT", body: JSON.stringify({ mode }) }),
    estimate:  (data)      => apiFetch("/api/agents/estimator/estimate", { method: "POST", body: JSON.stringify(data) }),
  },

  // ── Email ──
  email: {
    send:      (data) => apiFetch("/api/email/send", { method: "POST", body: JSON.stringify(data) }),
    configure: (data) => apiFetch("/api/email/configure", { method: "POST", body: JSON.stringify(data) }),
  },

  // ── Messages ──
  messages: {
    list:      ()     => apiFetch("/api/messages"),
    send:      (data) => apiFetch("/api/messages/send", { method: "POST", body: JSON.stringify(data) }),
    schedule:  (data) => apiFetch("/api/messages/schedule", { method: "POST", body: JSON.stringify(data) }),
    scheduled: ()     => apiFetch("/api/messages/scheduled"),
    delete:    (id)   => apiFetch(`/api/messages/${id}`, { method: "DELETE" }),
  },

  // ── Notifications ──
  notifications: {
    list:    ()   => apiFetch("/api/notifications"),
    readAll: ()   => apiFetch("/api/notifications/read-all", { method: "POST", body: JSON.stringify({}) }),
    read:    (id) => apiFetch(`/api/notifications/${id}/read`, { method: "POST", body: JSON.stringify({}) }),
    delete:  (id) => apiFetch(`/api/notifications/${id}`, { method: "DELETE" }),
  },

  // ── Photos ──
  photos: {
    list:   (jobId)        => apiFetch(`/api/photos/job/${jobId}`),
    upload: (jobId, form)  => getAuthToken().then(t => fetch(`/api/photos/job/${jobId}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${t}` },
      body: form,
    }).then(r => r.json())),
    delete: (photoId)      => apiFetch(`/api/photos/${photoId}`, { method: "DELETE" }),
  },

  // ── Payments (Stripe) ──
  payments: {
    invoiceLink: (id) => apiFetch(`/api/payments/invoice/${id}/link`, { method: "POST", body: JSON.stringify({}) }),
  },

  // ── Square ──
  square: {
    invoiceLink: (id) => apiFetch(`/api/square/invoice/${id}/link`, { method: "POST", body: JSON.stringify({}) }),
  },

  // ── Google Business Profile ──
  googleBusiness: {
    accounts: ()                             => apiFetch("/api/google-business/accounts"),
    reviews:  (accountId, locationId)        => apiFetch(`/api/google-business/reviews?accountId=${accountId}&locationId=${locationId}`),
    reply:    (reviewId, accountId, locationId, comment) => apiFetch(`/api/google-business/reviews/${reviewId}/reply`, { method: "POST", body: JSON.stringify({ accountId, locationId, comment }) }),
    deleteReply: (reviewId, accountId, locationId) => apiFetch(`/api/google-business/reviews/${reviewId}/reply?accountId=${accountId}&locationId=${locationId}`, { method: "DELETE" }),
  },

  // ── Import ──
  import: {
    customers: (rows) => apiFetch("/api/import/customers", { method: "POST", body: JSON.stringify({ rows }) }),
    jobs:      (rows) => apiFetch("/api/import/jobs",      { method: "POST", body: JSON.stringify({ rows }) }),
  },

  // ── Team ──
  team: {
    list:         ()           => apiFetch("/api/team"),
    invite:       (data)       => apiFetch("/api/team/invite", { method: "POST", body: JSON.stringify(data) }),
    updateRole:   (id, role)   => apiFetch(`/api/team/${id}`, { method: "PUT", body: JSON.stringify({ role }) }),
    remove:       (id)         => apiFetch(`/api/team/${id}`, { method: "DELETE" }),
    join:         (token)      => apiFetch("/api/team/join", { method: "POST", body: JSON.stringify({ token }) }),
    validateInvite: (token)    => fetch(`/api/team/invite/${token}`).then(r => r.json()),
    getRoles:     ()           => apiFetch("/api/team/roles"),
    saveRole:     (data)       => apiFetch("/api/team/roles", { method: "POST", body: JSON.stringify(data) }),
    deleteRole:   (roleId)     => apiFetch(`/api/team/roles/${roleId}`, { method: "DELETE" }),
  },

  // ── Automations ──
  automations: {
    list:    ()         => apiFetch("/api/automations"),
    create:  (data)     => apiFetch("/api/automations", { method: "POST", body: JSON.stringify(data) }),
    update:  (id, data) => apiFetch(`/api/automations/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    delete:        (id) => apiFetch(`/api/automations/${id}`, { method: "DELETE" }),
    pending:        ()  => apiFetch("/api/automations/pending"),
    deletePending: (id) => apiFetch(`/api/automations/pending/${id}`, { method: "DELETE" }),
    retryPending:  (id) => apiFetch(`/api/automations/pending/${id}/retry`, { method: "POST" }),
  },

  // ── Survey (public — no auth) ──
  survey: {
    get:    (token) => fetch(`/api/survey/${token}`).then(r => r.json()),
    submit: (token, rating) => fetch(`/api/survey/${token}`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ rating }) }).then(r => r.json()),
  },

  // ── Service Requests ──
  serviceRequests: {
    list:    (status) => apiFetch(`/api/service-requests${status ? `?status=${status}` : ""}`),
    get:     (id)     => apiFetch(`/api/service-requests/${id}`),
    approve: (id, data) => apiFetch(`/api/service-requests/${id}/approve`, { method: "POST", body: JSON.stringify(data || {}) }),
    deny:    (id, reason) => apiFetch(`/api/service-requests/${id}/deny`, { method: "POST", body: JSON.stringify({ reason: reason || "" }) }),
    delete:  (id)     => apiFetch(`/api/service-requests/${id}`, { method: "DELETE" }),
  },

  // ── Intake Forms (config for QR code / public form) ──
  intakeForms: {
    get:    ()       => apiFetch("/api/intake-forms"),
    save:   (data)   => apiFetch("/api/intake-forms", { method: "PUT", body: JSON.stringify(data) }),
    qrUrl:  ()       => apiFetch("/api/intake-forms/qr-url"),
  },

};

// ── Auth guard — call on every protected page ──
// Redirects to login if not signed in
async function requireAuth() {
  const { getAuth, onAuthStateChanged } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
  return new Promise((resolve) => {
    onAuthStateChanged(getAuth(), (user) => {
      if (!user) window.location.href = "swft-login";
      else resolve(user);
    });
  });
}
