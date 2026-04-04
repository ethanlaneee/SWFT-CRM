// ════════════════════════════════════════════════
// SWFT AI Chat Panel
// Floating chat interface that appears on every page
// Include via: <script src="swft-chat.js"></script>
// ════════════════════════════════════════════════

(function () {
  // Don't show chat bubble on dashboard (AI is embedded there)
  if (window.location.pathname.endsWith('swft-dashboard') || window.location.pathname.endsWith('swft-dashboard.html') || window.location.pathname === '/' || window.location.pathname === '') return;

  const isMessagesPage = window.location.pathname.endsWith('swft-messages') || window.location.pathname.endsWith('swft-messages.html');

  const API_BASE = ""; // Uses same origin

  // ── Inject styles ──
  const style = document.createElement("style");
  style.textContent = `
    /* ── Chat FAB ── */
    .swft-chat-fab {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: #c8f135;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 24px rgba(200, 241, 53, 0.3);
      transition: transform 0.2s, box-shadow 0.2s;
      z-index: 9999;
    }
    .swft-chat-fab:hover {
      transform: scale(1.08);
      box-shadow: 0 6px 32px rgba(200, 241, 53, 0.45);
    }
    .swft-chat-fab svg {
      width: 22px;
      height: 22px;
      fill: #0a0a0a;
    }
    .swft-chat-fab.open svg.icon-chat { display: none; }
    .swft-chat-fab:not(.open) svg.icon-close { display: none; }

    /* ── Chat Panel ── */
    .swft-chat-panel {
      position: fixed;
      bottom: 74px;
      right: 20px;
      width: 360px;
      max-height: 480px;
      background: #111111;
      border: 1px solid #222;
      border-radius: 16px;
      display: flex;
      flex-direction: column;
      z-index: 9998;
      opacity: 0;
      transform: translateY(20px) scale(0.95);
      pointer-events: none;
      transition: opacity 0.25s, transform 0.25s;
      box-shadow: 0 12px 48px rgba(0,0,0,0.5);
    }
    .swft-chat-panel.visible {
      opacity: 1;
      transform: translateY(0) scale(1);
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


    /* When panel is open, shift FAB left so it doesn't block send */
    .swft-chat-fab.open {
      right: 340px;
    }

    /* ── Mobile ── */
    @media (max-width: 480px) {
      .swft-chat-panel {
        right: 8px;
        left: 8px;
        bottom: 74px;
        width: auto;
        max-height: calc(100vh - 120px);
      }
      .swft-chat-fab.open {
        right: 20px;
        bottom: 20px;
      }
    }
  `;

  // Raise the bubble on the messages page so it doesn't cover the compose bar
  if (isMessagesPage) {
    style.textContent += `
      .swft-chat-fab { bottom: 180px !important; }
      .swft-chat-panel { bottom: 234px !important; }
    `;
  }

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
      <button class="swft-chat-clear">Clear</button>
    </div>
    <div class="swft-chat-messages">
      <div class="swft-chat-welcome">
        <h4>SWFT AI</h4>
        <p>Your AI-powered business assistant.</p>
        <p>I can manage customers, create quotes,<br>generate invoices, and more.</p>
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
  fab.innerHTML = `
    <svg class="icon-chat" viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>
    <svg class="icon-close" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
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

  // ── Toggle panel ──
  fab.addEventListener("click", () => {
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
    el.textContent = text.replace(/\*\*/g, "").replace(/\*/g, "").replace(/^[-•]\s/gm, "").replace(/^#+\s/gm, "");
    messagesContainer.insertBefore(el, typingEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return el;
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
    };

    const [label, detail] = labels[toolName] || [toolName, ""];
    const el = document.createElement("div");
    el.className = "swft-chat-action";
    el.innerHTML = `<span class="action-icon">&#9889;</span> ${label}${detail ? " — " + detail : ""}`;
    messagesContainer.insertBefore(el, typingEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // ── Send message ──
  async function sendMessage(text) {
    isSending = true;
    sendBtn.disabled = true;
    input.value = "";

    addMessage("user", text);
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

      // Show action cards
      if (data.actions && data.actions.length > 0) {
        data.actions.forEach((a) => addAction(a.tool, a.input));
      }

      // Show response
      addMessage("assistant", data.message);

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
      addMessage("assistant", `Something went wrong: ${err.message}`);
    } finally {
      typingEl.classList.remove("active");
      isSending = false;
      sendBtn.disabled = !input.value.trim();
    }
  }

  // ── Voice Recognition for Chat Bubble ──
  let _chatRecognition = null;
  let _chatListening = false;
  const micBtn = document.getElementById('swft-chat-mic');

  if (micBtn) {
    micBtn.addEventListener('click', function() {
      if (_chatListening) {
        if (_chatRecognition) _chatRecognition.stop();
        return;
      }

      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        if (typeof showToast === 'function') showToast('Voice not supported in this browser');
        return;
      }

      _chatRecognition = new SpeechRecognition();
      _chatRecognition.lang = 'en-US';
      _chatRecognition.interimResults = true;
      _chatRecognition.continuous = false;
      _chatRecognition.maxAlternatives = 1;

      _chatRecognition.onstart = function() {
        _chatListening = true;
        micBtn.classList.add('recording');
      };

      _chatRecognition.onresult = function(e) {
        let transcript = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          transcript += e.results[i][0].transcript;
        }
        input.value = transcript;
        sendBtn.disabled = !transcript.trim();
      };

      _chatRecognition.onend = function() {
        _chatListening = false;
        micBtn.classList.remove('recording');
        // Auto-send if we got text
        if (input.value.trim() && !isSending) {
          sendMessage(input.value.trim());
        }
      };

      _chatRecognition.onerror = function(e) {
        _chatListening = false;
        micBtn.classList.remove('recording');
        // Only show error for real problems, not just no-speech
        if (e.error === 'not-allowed') {
          if (typeof showToast === 'function') showToast('Microphone blocked - check browser settings');
        } else if (e.error === 'network') {
          if (typeof showToast === 'function') showToast('Voice needs internet connection');
        } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
          if (typeof showToast === 'function') showToast('Voice error: ' + e.error);
        }
      };

      _chatRecognition.start();
    });
  }
})();
