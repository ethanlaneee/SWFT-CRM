// ════════════════════════════════════════════════
// SWFT AI Chat Panel
// Floating chat interface that appears on every page
// Include via: <script src="swft-chat.js"></script>
// ════════════════════════════════════════════════

(function () {
  // Don't show chat bubble on dashboard (AI is embedded there)
  if (window.location.pathname.endsWith('swft-dashboard') || window.location.pathname.endsWith('swft-dashboard.html') || window.location.pathname === '/' || window.location.pathname === '') return;

  const isMessagesPage = window.location.pathname.endsWith('swft-messages') || window.location.pathname.endsWith('swft-messages.html');
  const isTeamChatPage = window.location.pathname.endsWith('swft-team-chat') || window.location.pathname.endsWith('swft-team-chat.html');
  const hasBottomComposer = isMessagesPage || isTeamChatPage;

  const API_BASE = ""; // Uses same origin

  // ── Inject styles ──
  const style = document.createElement("style");
  style.textContent = `
    /* ── Chat Pill (bottom-center, shimmering) ── */
    .swft-chat-fab {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      height: 44px;
      min-width: 168px;
      padding: 0 20px;
      border-radius: 999px;
      background: linear-gradient(135deg, #c8f135 0%, #a8d12a 100%);
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      box-shadow: 0 4px 24px rgba(200, 241, 53, 0.35), 0 0 0 1px rgba(200, 241, 53, 0.4) inset;
      transition: transform 0.2s, box-shadow 0.2s, background 0.25s;
      z-index: 9999;
      overflow: hidden;
      font-family: 'DM Sans', sans-serif;
    }
    .swft-chat-fab:hover {
      transform: translateX(-50%) translateY(-2px);
      box-shadow: 0 8px 32px rgba(200, 241, 53, 0.5), 0 0 0 1px rgba(200, 241, 53, 0.5) inset;
    }
    .swft-chat-fab .pill-label {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      color: #0a0a0a;
      position: relative;
      z-index: 2;
    }
    .swft-chat-fab .pill-icon {
      width: 16px;
      height: 16px;
      stroke: #0a0a0a;
      fill: none;
      stroke-width: 2;
      position: relative;
      z-index: 2;
      flex-shrink: 0;
    }
    /* Moving highlight sweep across the pill */
    .swft-chat-fab::before {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(110deg, transparent 25%, rgba(255,255,255,0.55) 48%, rgba(255,255,255,0.55) 52%, transparent 75%);
      transform: translateX(-120%);
      animation: swft-pill-shimmer 3.2s ease-in-out infinite;
      pointer-events: none;
      z-index: 1;
    }
    @keyframes swft-pill-shimmer {
      0%   { transform: translateX(-120%); }
      55%  { transform: translateX(120%); }
      100% { transform: translateX(120%); }
    }
    /* Recording state — red, pulsing, "Listening…" */
    .swft-chat-fab.recording {
      background: linear-gradient(135deg, #ff5252 0%, #c43838 100%);
      box-shadow: 0 4px 24px rgba(255, 82, 82, 0.5), 0 0 0 1px rgba(255, 82, 82, 0.5) inset;
      animation: swft-pill-listen 1.4s ease-in-out infinite;
    }
    .swft-chat-fab.recording .pill-label,
    .swft-chat-fab.recording .pill-icon { color: #fff; stroke: #fff; }
    .swft-chat-fab.recording::before { animation: none; opacity: 0; }
    @keyframes swft-pill-listen {
      0%, 100% { box-shadow: 0 4px 24px rgba(255, 82, 82, 0.5), 0 0 0 1px rgba(255, 82, 82, 0.5) inset; }
      50%      { box-shadow: 0 6px 36px rgba(255, 82, 82, 0.75), 0 0 0 2px rgba(255, 82, 82, 0.65) inset; }
    }
    /* Transcribing state — amber spinner */
    .swft-chat-fab.transcribing {
      background: linear-gradient(135deg, #f5a623 0%, #c17a0b 100%);
      box-shadow: 0 4px 24px rgba(245, 166, 35, 0.45);
    }
    .swft-chat-fab.transcribing .pill-label { color: #0a0a0a; }
    .swft-chat-fab.transcribing::before { animation: swft-pill-shimmer 1.2s linear infinite; }

    /* ── Chat Panel ── */
    .swft-chat-panel {
      position: fixed;
      bottom: 80px;
      left: 50%;
      width: 400px;
      max-width: calc(100vw - 32px);
      max-height: 480px;
      background: #111111;
      border: 1px solid #222;
      border-radius: 16px;
      display: flex;
      flex-direction: column;
      z-index: 9998;
      opacity: 0;
      transform: translateX(-50%) translateY(20px) scale(0.95);
      pointer-events: none;
      transition: opacity 0.25s, transform 0.25s;
      box-shadow: 0 12px 48px rgba(0,0,0,0.6);
    }
    .swft-chat-panel.visible {
      opacity: 1;
      transform: translateX(-50%) translateY(0) scale(1);
      pointer-events: all;
    }

    /* ── Header ── */
    .swft-chat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid #222;
    }
    .swft-chat-header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .swft-chat-header-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #c8f135;
      animation: swft-pulse 2s infinite;
    }
    @keyframes swft-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .swft-chat-header h3 {
      margin: 0;
      font-family: 'Bebas Neue', sans-serif;
      font-size: 18px;
      color: #fff;
      letter-spacing: 1px;
    }
    .swft-chat-clear {
      background: none;
      border: 1px solid #333;
      color: #7a7a7a;
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-family: 'DM Sans', sans-serif;
      transition: color 0.15s, border-color 0.15s;
    }
    .swft-chat-clear:hover {
      color: #fff;
      border-color: #555;
    }
    .swft-chat-voice {
      background: #1a1a1a;
      border: 1px solid #333;
      color: #aaa;
      font-size: 11px;
      padding: 4px 6px;
      border-radius: 6px;
      font-family: 'DM Sans', sans-serif;
      outline: none;
      cursor: pointer;
      max-width: 110px;
    }
    .swft-chat-voice:hover { color: #c8f135; border-color: #555; }
    .swft-chat-voice:focus { border-color: #c8f135; }

    /* ── Messages ── */
    .swft-chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 300px;
      max-height: 420px;
    }
    .swft-chat-messages::-webkit-scrollbar { width: 4px; }
    .swft-chat-messages::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }

    .swft-chat-msg {
      max-width: 85%;
      padding: 10px 14px;
      border-radius: 12px;
      font-family: 'DM Sans', sans-serif;
      font-size: 13.5px;
      line-height: 1.5;
      word-wrap: break-word;
    }
    .swft-chat-msg.user {
      align-self: flex-end;
      background: #c8f135;
      color: #0a0a0a;
      border-bottom-right-radius: 4px;
    }
    .swft-chat-msg.assistant {
      align-self: flex-start;
      background: #1a1a1a;
      color: #e0e0e0;
      border: 1px solid #222;
      border-bottom-left-radius: 4px;
    }

    /* ── Action cards ── */
    .swft-chat-action {
      align-self: flex-start;
      background: #0f1a0a;
      border: 1px solid #2a3d1a;
      border-radius: 10px;
      padding: 8px 12px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: #c8f135;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .swft-chat-action .action-icon {
      font-size: 14px;
    }

    /* ── Typing indicator ── */
    .swft-chat-typing {
      align-self: flex-start;
      display: none;
      gap: 4px;
      padding: 12px 16px;
    }
    .swft-chat-typing.active { display: flex; }
    .swft-chat-typing span {
      width: 6px;
      height: 6px;
      background: #555;
      border-radius: 50%;
      animation: swft-typing 1.4s infinite;
    }
    .swft-chat-typing span:nth-child(2) { animation-delay: 0.2s; }
    .swft-chat-typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes swft-typing {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30% { transform: translateY(-6px); opacity: 1; }
    }

    /* ── Welcome message ── */
    .swft-chat-welcome {
      text-align: center;
      padding: 40px 20px;
      color: #555;
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
    }
    .swft-chat-welcome h4 {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 22px;
      color: #c8f135;
      margin: 0 0 8px 0;
      letter-spacing: 1px;
    }
    .swft-chat-welcome p {
      margin: 4px 0;
      line-height: 1.5;
    }
    .swft-chat-suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: center;
      margin-top: 16px;
    }
    .swft-chat-suggestion {
      background: #1a1a1a;
      border: 1px solid #222;
      color: #aaa;
      font-family: 'DM Sans', sans-serif;
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 20px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .swft-chat-suggestion:hover {
      background: #222;
      color: #c8f135;
      border-color: #c8f135;
    }

    /* ── Input ── */
    .swft-chat-input-area {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid #222;
    }
    .swft-chat-input {
      flex: 1;
      background: #1a1a1a;
      border: 1px solid #222;
      border-radius: 10px;
      padding: 10px 14px;
      color: #fff;
      font-family: 'DM Sans', sans-serif;
      font-size: 13.5px;
      outline: none;
      transition: border-color 0.15s;
    }
    .swft-chat-input::placeholder { color: #555; }
    .swft-chat-input:focus { border-color: #c8f135; }
    .swft-chat-send {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: #c8f135;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: opacity 0.15s;
    }
    .swft-chat-send:disabled { opacity: 0.4; cursor: not-allowed; }
    .swft-chat-send svg { width: 18px; height: 18px; fill: #0a0a0a; }

    .swft-chat-mic {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: #181818;
      border: 1px solid #2c2c2c;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
      flex-shrink: 0;
    }
    .swft-chat-mic:hover { border-color: #c8f135; }
    .swft-chat-mic.recording { background: #ff5252; border-color: #ff5252; }
    .swft-chat-mic svg { width: 16px; height: 16px; stroke: #7a7a7a; fill: none; }
    .swft-chat-mic.recording svg { stroke: #fff; }


    /* Subtle darken of the pill while the panel is open so it reads as "active" */
    .swft-chat-fab.open {
      filter: brightness(0.92);
    }

    /* ── Acknowledgment message ── */
    .swft-chat-ack {
      align-self: flex-start;
      color: #777;
      font-family: 'DM Sans', sans-serif;
      font-size: 12px;
      font-style: italic;
      padding: 4px 14px;
    }

    /* ── Connect Tools Tab ── */
    .swft-chat-tools-tab {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 16px;
      border-top: 1px solid #222;
      cursor: pointer;
      transition: background 0.15s;
      font-family: 'DM Sans', sans-serif;
      font-size: 12px;
      color: #7a7a7a;
      background: #0d0d0d;
      border-radius: 0 0 16px 16px;
    }
    .swft-chat-tools-tab:hover {
      background: #1a1a1a;
      color: #c8f135;
    }
    .swft-chat-tools-tab svg {
      width: 14px;
      height: 14px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
    }

    /* ── Tools Drawer ── */
    .swft-chat-tools-drawer {
      display: none;
      flex-direction: column;
      gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid #222;
      background: #0d0d0d;
      max-height: 180px;
      overflow-y: auto;
    }
    .swft-chat-tools-drawer.open {
      display: flex;
    }
    .swft-chat-tools-drawer h5 {
      margin: 0;
      font-family: 'Bebas Neue', sans-serif;
      font-size: 14px;
      color: #c8f135;
      letter-spacing: 0.5px;
    }
    .swft-chat-tool-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      background: #151515;
      border: 1px solid #222;
      border-radius: 8px;
      font-family: 'DM Sans', sans-serif;
      font-size: 12px;
      color: #ccc;
    }
    .swft-chat-tool-item .tool-name {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .swft-chat-tool-item .tool-icon {
      font-size: 16px;
    }
    .swft-chat-tool-toggle {
      width: 32px;
      height: 18px;
      background: #333;
      border-radius: 9px;
      border: none;
      cursor: pointer;
      position: relative;
      transition: background 0.2s;
    }
    .swft-chat-tool-toggle::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #666;
      transition: transform 0.2s, background 0.2s;
    }
    .swft-chat-tool-toggle.active {
      background: #2a3d1a;
    }
    .swft-chat-tool-toggle.active::after {
      transform: translateX(14px);
      background: #c8f135;
    }
    .swft-chat-tools-empty {
      color: #555;
      font-family: 'DM Sans', sans-serif;
      font-size: 12px;
      text-align: center;
      padding: 8px 0;
    }

    /* ── Mobile ── */
    @media (max-width: 480px) {
      .swft-chat-panel {
        left: 8px;
        right: 8px;
        width: auto;
        max-width: none;
        max-height: calc(100vh - 120px);
        transform: translateY(20px) scale(0.95);
      }
      .swft-chat-panel.visible {
        transform: translateY(0) scale(1);
      }
      .swft-chat-fab {
        min-width: 144px;
        padding: 0 16px;
      }
    }
  `;

  // The pill sits in the same spot on every page — bottom-center, fixed.
  // No per-page offsets; consistency wins.

  document.head.appendChild(style);

  // ── Build DOM ──
  const panel = document.createElement("div");
  panel.className = "swft-chat-panel";
  panel.innerHTML = `
    <div class="swft-chat-header">
      <div class="swft-chat-header-left">
        <div class="swft-chat-header-dot"></div>
        <h3>SWFT AI</h3>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <select class="swft-chat-voice" title="Voice">
          <optgroup label="Conversational">
            <option value="matilda">Matilda</option>
            <option value="freya">Freya</option>
            <option value="charlotte">Charlotte</option>
          </optgroup>
          <optgroup label="Warm">
            <option value="rachel">Rachel</option>
            <option value="sarah">Sarah</option>
            <option value="lily">Lily</option>
          </optgroup>
          <optgroup label="Male">
            <option value="brian">Brian</option>
            <option value="daniel">Daniel</option>
            <option value="antoni">Antoni</option>
            <option value="adam">Adam</option>
          </optgroup>
        </select>
        <button class="swft-chat-clear">Clear</button>
      </div>
    </div>
    <div class="swft-chat-messages">
      <div class="swft-chat-welcome">
        <h4>SWFT AI</h4>
        <p>Hey, I'm SWFT your personal AI assistant. How can I help you?</p>
        <div class="swft-chat-suggestions">
          <button class="swft-chat-suggestion">Add a new customer</button>
          <button class="swft-chat-suggestion">Create a quote</button>
          <button class="swft-chat-suggestion">How's business?</button>
          <button class="swft-chat-suggestion">Show open invoices</button>
        </div>
      </div>
      <div class="swft-chat-typing">
        <span></span><span></span><span></span>
      </div>
    </div>
    <div class="swft-chat-input-area">
      <input class="swft-chat-input" placeholder="Ask SWFT anything..." />
      <button class="swft-chat-mic" id="swft-chat-mic" title="Voice input">
        <svg viewBox="0 0 24 24" stroke-width="1.8"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
      </button>
      <button class="swft-chat-send" disabled>
        <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
    </div>
  `;

  const fab = document.createElement("button");
  fab.className = "swft-chat-fab";
  fab.setAttribute("aria-label", "Open SWFT AI");
  fab.setAttribute("title", "Click to chat · Hold Ctrl+Win to talk · Ctrl+Win+Space to toggle");
  fab.innerHTML = `
    <svg class="pill-icon" viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
    <span class="pill-label">SWFT AI</span>
  `;

  document.body.appendChild(panel);
  document.body.appendChild(fab);

  // ── State ──
  let isOpen = false;
  let isSending = false;
  let hasMessages = false;

  const messagesContainer = panel.querySelector(".swft-chat-messages");
  const welcomeEl = panel.querySelector(".swft-chat-welcome");
  const typingEl = panel.querySelector(".swft-chat-typing");
  const input = panel.querySelector(".swft-chat-input");
  const sendBtn = panel.querySelector(".swft-chat-send");
  const clearBtn = panel.querySelector(".swft-chat-clear");
  const suggestions = panel.querySelectorAll(".swft-chat-suggestion");
  const voiceSelect = panel.querySelector(".swft-chat-voice");

  // Voice preference — persists across sessions per browser
  const VOICE_KEY = "swft_tts_voice";
  function getVoice() {
    try { return localStorage.getItem(VOICE_KEY) || "matilda"; } catch (_) { return "matilda"; }
  }
  if (voiceSelect) {
    voiceSelect.value = getVoice();
    voiceSelect.addEventListener("change", () => {
      try { localStorage.setItem(VOICE_KEY, voiceSelect.value); } catch (_) {}
    });
  }

  // ── Toggle panel ──
  // If a voice session is active (push-to-talk or toggle), a click cancels it
  // instead of opening the panel.
  fab.addEventListener("click", () => {
    if (typeof _isRecording !== 'undefined' && _isRecording) {
      if (typeof stopRecording === 'function') stopRecording();
      return;
    }
    isOpen = !isOpen;
    panel.classList.toggle("visible", isOpen);
    fab.classList.toggle("open", isOpen);
    if (isOpen) input.focus();
  });

  // ── Input handling ──
  input.addEventListener("input", () => {
    sendBtn.disabled = !input.value.trim() || isSending;
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && input.value.trim() && !isSending) {
      e.preventDefault();
      sendMessage(input.value.trim());
    }
  });

  sendBtn.addEventListener("click", () => {
    if (input.value.trim() && !isSending) sendMessage(input.value.trim());
  });

  // ── Suggestion chips ──
  suggestions.forEach((btn) => {
    btn.addEventListener("click", () => {
      sendMessage(btn.textContent);
    });
  });

  // ── Clear history ──
  clearBtn.addEventListener("click", async () => {
    try {
      const token = await getToken();
      await fetch(`${API_BASE}/api/ai/history`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) { /* ignore */ }

    // Reset UI
    messagesContainer.querySelectorAll(".swft-chat-msg, .swft-chat-action").forEach(el => el.remove());
    welcomeEl.style.display = "";
    hasMessages = false;
  });

  // ── Get auth token ──
  async function getToken() {
    const { getAuth } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
    const auth = getAuth();
    // Wait for auth to be ready if user isn't loaded yet
    if (!auth.currentUser) {
      await new Promise((resolve, reject) => {
        const { onAuthStateChanged } = auth.constructor;
        const unsub = auth.onAuthStateChanged(u => {
          unsub();
          if (u) resolve(u);
          else reject(new Error("Not authenticated"));
        });
      });
    }
    return auth.currentUser.getIdToken();
  }

  // ── Add message bubble ──
  function addMessage(role, text) {
    if (!hasMessages) {
      welcomeEl.style.display = "none";
      hasMessages = true;
    }
    const el = document.createElement("div");
    el.className = `swft-chat-msg ${role}`;
    // Strip markdown formatting for clean display
    const cleaned = text.replace(/\*\*/g, "").replace(/\*/g, "").replace(/^[-•]\s/gm, "").replace(/^#+\s/gm, "");
    el.textContent = cleaned;
    messagesContainer.insertBefore(el, typingEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return el;
  }

  // ── Add navigation button for maps links ──
  function addNavButton(address, mapsUrl) {
    const el = document.createElement("a");
    el.href = mapsUrl;
    el.target = "_blank";
    el.rel = "noopener";
    el.className = "swft-chat-action";
    el.style.cssText = "text-decoration:none;cursor:pointer;";
    el.innerHTML = '<span class="action-icon">📍</span> Open in Google Maps — ' +
      address.substring(0, 40) + (address.length > 40 ? '...' : '');
    messagesContainer.insertBefore(el, typingEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // ── Add action card ──
  function addAction(toolName, input) {
    const labels = {
      create_customer: ["+ Customer", input.name],
      search_customers: ["Search", input.query],
      update_customer: ["Updated", "customer"],
      create_quote: ["+ Quote", `$${(input.items || []).reduce((s, i) => s + (i.amount || 0), 0).toLocaleString()}`],
      list_quotes: ["Quotes", input.status || "all"],
      send_quote: ["Sent", "quote"],
      create_invoice: ["+ Invoice", `$${(input.items || []).reduce((s, i) => s + (i.amount || 0), 0).toLocaleString()}`],
      list_invoices: ["Invoices", input.status || "all"],
      create_job: ["+ Job", input.title],
      list_jobs: ["Jobs", input.status || "all"],
      update_job: ["Updated", "job"],
      schedule_job: ["Scheduled", input.date],
      get_dashboard_stats: ["Dashboard", "stats"],
      send_sms: ["SMS sent", input.to || ""],
      get_weather: ["Weather", input.city || "forecast"],
      navigate_to_customer: ["Navigate", input.customerName || "customer"],
      get_directions: ["Directions", input.destination || "route"],
      list_calendar_events: ["Calendar", "events"],
      create_calendar_event: ["Calendar", input.title || "event"],
      check_gmail_inbox: ["Gmail", input.query || "inbox"],
      send_gmail: ["Email sent", input.to || ""],
      export_to_sheets: ["Exported", input.data_type || "data"],
    };

    const [label, detail] = labels[toolName] || [toolName, ""];
    const el = document.createElement("div");
    el.className = "swft-chat-action";
    el.innerHTML = `<span class="action-icon">&#9889;</span> ${label}${detail ? " — " + detail : ""}`;
    messagesContainer.insertBefore(el, typingEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // Acknowledgment removed — the typing indicator (three dots) is enough
  // visual feedback that the AI is working. Keep a stub so callers don't
  // crash; it returns a detached placeholder that remove() no-ops on.
  function showAck() { return { parentNode: null, remove() {} }; }

  // ── Send message ──
  async function sendMessage(text) {
    isSending = true;
    sendBtn.disabled = true;
    input.value = "";

    addMessage("user", text);
    const ackEl = showAck();
    typingEl.classList.add("active");

    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: text }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "AI error");

      // Remove acknowledgment
      if (ackEl && ackEl.parentNode) ackEl.remove();

      // Show action cards + navigation buttons
      if (data.actions && data.actions.length > 0) {
        data.actions.forEach((a) => {
          addAction(a.tool, a.input);
          // If navigate_to_customer returned a maps URL, show a clickable button
          if (a.tool === "navigate_to_customer" && a.result && a.result.mapsUrl) {
            addNavButton(a.result.address, a.result.mapsUrl);
          }
        });
      }

      // Show response and speak it
      addMessage("assistant", data.message);
      speak(data.message);

      // Dispatch event so current page can refresh data
      window.dispatchEvent(new CustomEvent("swft-ai-action", {
        detail: { actions: data.actions || [] },
      }));

      // Push notifications for AI actions
      if (data.actions && data.actions.length > 0 && typeof swftNotify === 'function') {
        data.actions.forEach(function(a) {
          var labels = {
            create_customer: 'Customer created',
            search_customers: 'Customer search',
            update_customer: 'Customer updated',
            create_quote: 'Quote created',
            create_invoice: 'Invoice created',
            create_job: 'Job created',
            schedule_job: 'Job scheduled',
            get_dashboard_stats: 'Dashboard stats pulled'
          };
          var label = labels[a.tool] || a.tool;
          swftNotify('<strong>SWFT AI</strong> ' + label, '🤖', 'rgba(200,241,53,0.1)');
        });
      }

    } catch (err) {
      if (ackEl && ackEl.parentNode) ackEl.remove();
      addMessage("assistant", `Something went wrong: ${err.message}`);
    } finally {
      typingEl.classList.remove("active");
      isSending = false;
      sendBtn.disabled = !input.value.trim();
    }
  }


  // ── Text-to-speech ────────────────────────────────────────────────────
  // Uses OpenAI's tts-1 (via /api/tts) for a natural-sounding voice.
  // Falls back to the browser's SpeechSynthesis API if the fetch fails
  // (offline, 500 error, etc.) so the user still hears the reply.
  let _ttsAudio = null;
  let _ttsAbort = null;

  function stopSpeak() {
    if (_ttsAbort) { try { _ttsAbort.abort(); } catch (_) {} _ttsAbort = null; }
    if (_ttsAudio) {
      try { _ttsAudio.pause(); } catch (_) {}
      try { if (_ttsAudio.src && _ttsAudio.src.startsWith('blob:')) URL.revokeObjectURL(_ttsAudio.src); } catch (_) {}
      _ttsAudio = null;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  async function speak(text) {
    stopSpeak();
    const clean = String(text || '')
      .replace(/\*\*/g, '').replace(/\*/g, '')
      .replace(/^[-•]\s/gm, '').replace(/^#+\s/gm, '')
      .trim();
    if (!clean) return;

    // Try OpenAI TTS first
    try {
      const token = await getToken();
      _ttsAbort = new AbortController();
      const res = await fetch(`${API_BASE}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: clean, voice: getVoice() }),
        signal: _ttsAbort.signal,
      });
      if (!res.ok) throw new Error('TTS ' + res.status);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      _ttsAudio = new Audio(url);
      _ttsAudio.onended = () => { try { URL.revokeObjectURL(url); } catch (_) {} };
      await _ttsAudio.play();
      _ttsAbort = null;
      return;
    } catch (err) {
      // Swallow abort errors — they just mean a newer reply is speaking
      if (err && err.name === 'AbortError') return;
      console.warn('[tts] falling back to browser voice:', err.message || err);
    }

    // Fallback: browser SpeechSynthesis
    if (!window.speechSynthesis) return;
    const utt = new SpeechSynthesisUtterance(clean);
    utt.rate = 1.05;
    utt.pitch = 1;
    window.speechSynthesis.speak(utt);
  }

  // ── Voice Input — MediaRecorder → Whisper ──────────────────────────────
  // One shared pipeline for three entry points:
  //   • in-panel mic button (fills the input, doesn't auto-send)
  //   • Ctrl+Win push-to-talk (auto-sends on release)
  //   • Ctrl+Win+Space toggle  (auto-sends when toggled off)
  const micBtn = document.getElementById('swft-chat-mic');
  const micIconSvg = '<svg viewBox="0 0 24 24" stroke-width="1.8"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';

  let _mediaRecorder = null;
  let _audioChunks = [];
  let _isRecording = false;
  let _recordingAutoSend = false;  // set by whichever trigger started recording
  let _recordingStream = null;

  const PILL_DEFAULT_LABEL = 'SWFT AI';

  // Single source of truth for the pill's visual state. Precedence:
  // transcribing > recording > default. This way the label never gets stuck.
  function refreshPillLabel() {
    const label = fab.querySelector('.pill-label');
    if (!label) return;
    if (fab.classList.contains('transcribing')) label.textContent = 'Transcribing…';
    else if (fab.classList.contains('recording'))  label.textContent = 'Listening…';
    else                                            label.textContent = PILL_DEFAULT_LABEL;
  }

  function setRecordingState(recording) {
    _isRecording = recording;
    fab.classList.toggle('recording', recording);
    if (micBtn) micBtn.classList.toggle('recording', recording);
    refreshPillLabel();
  }

  function setTranscribingState(on) {
    fab.classList.toggle('transcribing', on);
    refreshPillLabel();
  }

  async function startRecording(autoSend) {
    if (_isRecording) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (typeof showToast === 'function') showToast('Microphone not supported in this browser');
      return;
    }

    _recordingAutoSend = !!autoSend;

    // Stop any ongoing TTS (OpenAI audio or browser fallback) so we don't
    // record the AI's own voice back into the next utterance.
    stopSpeak();

    try {
      _recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (typeof showToast === 'function') showToast('Microphone blocked — check browser settings');
      return;
    }

    // Brief pause to let speakers clear before recording starts
    await new Promise(r => setTimeout(r, 300));

    _audioChunks = [];
    _mediaRecorder = new MediaRecorder(_recordingStream);

    _mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) _audioChunks.push(e.data);
    };

    _mediaRecorder.onstop = async () => {
      if (_recordingStream) {
        _recordingStream.getTracks().forEach((t) => t.stop());
        _recordingStream = null;
      }

      const mimeType = _mediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(_audioChunks, { type: mimeType });
      _audioChunks = [];

      // ~1.5KB ≈ half a second of webm/opus. Below that it's a reflex tap.
      // Short phone-number utterances ("five five five, zero one nine nine")
      // still land comfortably above this threshold.
      if (blob.size < 1500) {
        setTranscribingState(false);
        return;
      }

      setTranscribingState(true);
      if (micBtn) {
        micBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.8" style="animation:swft-typing 0.8s infinite"><circle cx="12" cy="12" r="9" stroke="#c8f135" fill="none"/></svg>';
        micBtn.disabled = true;
      }

      try {
        const token = await getToken();
        const formData = new FormData();
        formData.append('audio', blob, 'recording.' + (mimeType.includes('mp4') ? 'm4a' : 'webm'));

        const res = await fetch(`${API_BASE}/api/transcribe`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Transcription failed');

        // Require at least a few characters with a real word, otherwise
        // ignore — prevents "you" / "." / empty strings from being sent.
        const transcribed = (data.text || '').trim();
        const isMeaningful = transcribed.length >= 3 && /\b[a-z]{2,}\b/i.test(transcribed);
        if (isMeaningful) {
          if (_recordingAutoSend) {
            // Hotkey path — send straight to the AI, open the panel to show the reply
            if (!isOpen) {
              isOpen = true;
              panel.classList.add('visible');
              fab.classList.add('open');
            }
            sendMessage(transcribed);
          } else {
            input.value = transcribed;
            sendBtn.disabled = false;
            input.focus();
          }
        }
      } catch (err) {
        if (typeof showToast === 'function') showToast('Voice transcription failed — try again');
        console.error('[voice]', err);
      } finally {
        setTranscribingState(false);
        if (micBtn) {
          micBtn.innerHTML = micIconSvg;
          micBtn.disabled = false;
        }
      }
    };

    _mediaRecorder.start();
    setRecordingState(true);
  }

  function stopRecording() {
    if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
      _mediaRecorder.stop();
    }
    setRecordingState(false);
  }

  // In-panel mic button — fills the input, doesn't auto-send (user reviews + hits Send)
  if (micBtn) {
    micBtn.addEventListener('click', function () {
      if (_isRecording) stopRecording();
      else startRecording(false);
    });
  }

  // ── Global hotkeys ───────────────────────────────────────────────────────
  // Ctrl + Win (Meta) held       → push-to-talk; release to send
  // Ctrl + Win (Meta) + Space    → toggle recording on/off; auto-sends on stop
  //
  // Caveat: these only fire while a SWFT tab is focused. Browser pages can't
  // intercept keys while another app is on top — that requires a desktop
  // wrapper. On macOS, Ctrl+Cmd+Space also opens the character viewer; we
  // still try to preventDefault but OS-level shortcuts may win.
  let _hotkeyHoldActive = false;

  // Skip the hotkey if the user is typing into a regular text input/textarea
  // that isn't part of the SWFT AI panel itself. The chat panel's own input
  // is fine — we want voice to work while it's focused.
  function hotkeyShouldFire(e) {
    const t = e.target;
    if (!t) return true;
    if (t === input) return true; // chat panel input — OK
    if (panel.contains(t)) return true;
    const tag = t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable) return false;
    return true;
  }

  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (!e.ctrlKey || !e.metaKey) return;
    if (!hotkeyShouldFire(e)) return;

    // Toggle: Ctrl+Win+Space
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      if (_isRecording) stopRecording();
      else startRecording(true);
      return;
    }

    // Push-to-talk: pressing the SECOND of Ctrl/Win completes the combo.
    // Start recording at that moment unless Space is also in the mix.
    if ((e.key === 'Control' || e.key === 'Meta') && !_hotkeyHoldActive && !_isRecording) {
      _hotkeyHoldActive = true;
      startRecording(true);
    }
  });

  document.addEventListener('keyup', (e) => {
    // Releasing either Ctrl or Win ends push-to-talk
    if (_hotkeyHoldActive && (e.key === 'Control' || e.key === 'Meta')) {
      _hotkeyHoldActive = false;
      if (_isRecording) stopRecording();
    }
  });

  // Safety: if the tab loses focus mid-hold, the matching keyup never fires,
  // so cancel the recording cleanly.
  window.addEventListener('blur', () => {
    if (_hotkeyHoldActive) {
      _hotkeyHoldActive = false;
      if (_isRecording) stopRecording();
    }
  });
})();
