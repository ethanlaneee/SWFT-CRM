// ════════════════════════════════════════════════
// SWFT Agent Inbox
// Proactive AI actions — drop-down next to the bell
// ════════════════════════════════════════════════

(function () {
  var style = document.createElement("style");
  style.textContent = `
    .agent-dropdown {
      position: fixed;
      top: 56px; right: 80px;
      width: 400px;
      max-height: 520px;
      background: #111111;
      border: 1px solid #2c2c2c;
      border-radius: 14px;
      z-index: 8400;
      opacity: 0; pointer-events: none;
      transform: translateY(-8px);
      transition: opacity 0.2s, transform 0.2s;
      box-shadow: 0 16px 64px rgba(0,0,0,0.5);
      overflow: hidden;
      display: flex; flex-direction: column;
    }
    .agent-dropdown.open { opacity: 1; pointer-events: all; transform: translateY(0); }
    .agent-drop-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 18px;
      border-bottom: 1px solid #1f1f1f;
      flex-shrink: 0;
    }
    .agent-drop-header h4 {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 16px; letter-spacing: 1.5px; color: #f0f0f0; margin: 0;
      display: flex; align-items: center; gap: 8px;
    }
    .agent-drop-badge {
      font-family: 'JetBrains Mono', monospace;
      font-size: 9.5px; font-weight: 700;
      background: rgba(200,241,53,0.15); color: #c8f135;
      padding: 2px 7px; border-radius: 10px; letter-spacing: 0.3px;
    }
    .agent-scan-btn {
      font-size: 11px; color: #c8f135; cursor: pointer; font-weight: 500;
      background: none; border: none; font-family: 'DM Sans', sans-serif;
    }
    .agent-scan-btn:hover { text-decoration: underline; }
    .agent-drop-list { flex: 1; overflow-y: auto; }
    .agent-drop-list::-webkit-scrollbar { width: 4px; }
    .agent-drop-list::-webkit-scrollbar-thumb { background: #2c2c2c; border-radius: 2px; }
    .agent-action-item {
      padding: 13px 16px;
      border-bottom: 1px solid #1a1a1a;
      display: flex; flex-direction: column; gap: 7px;
    }
    .agent-action-item:last-child { border-bottom: none; }
    .agent-action-top {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
    }
    .agent-action-meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
    .agent-action-customer { font-size: 13px; font-weight: 600; color: #f0f0f0; }
    .agent-action-type {
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
      padding: 2px 7px; border-radius: 6px;
    }
    .agent-action-type.quote_followup   { background: rgba(77,159,255,0.12); color: #4d9fff; }
    .agent-action-type.invoice_followup { background: rgba(245,166,35,0.12); color: #f5a623; }
    .agent-action-type.review_request   { background: rgba(200,241,53,0.12); color: #c8f135; }
    .agent-action-subject {
      font-size: 12px; font-weight: 600; color: #cccccc; line-height: 1.3;
    }
    .agent-action-preview {
      font-size: 12px; color: #666; line-height: 1.45;
    }
    .agent-action-btns {
      display: flex; align-items: center; gap: 6px; margin-top: 2px;
    }
    .agent-btn-send {
      font-size: 11.5px; font-weight: 700; padding: 5px 13px;
      border-radius: 7px; background: #c8f135; color: #0a0a0a;
      border: none; cursor: pointer; font-family: 'DM Sans', sans-serif;
      transition: background 0.12s;
    }
    .agent-btn-send:hover { background: #d5ff40; }
    .agent-btn-send:disabled { opacity: 0.5; cursor: default; }
    .agent-btn-view {
      font-size: 11.5px; padding: 5px 11px;
      border-radius: 7px; background: transparent; color: #888;
      border: 1px solid #2c2c2c; cursor: pointer; font-family: 'DM Sans', sans-serif;
      transition: all 0.12s; text-decoration: none; display: inline-flex; align-items: center;
    }
    .agent-btn-view:hover { background: #1a1a1a; color: #f0f0f0; border-color: #444; }
    .agent-btn-dismiss {
      margin-left: auto;
      font-size: 11.5px; padding: 5px 9px;
      border-radius: 7px; background: transparent; color: #555;
      border: 1px solid #222; cursor: pointer; font-family: 'DM Sans', sans-serif;
      transition: all 0.12s;
    }
    .agent-btn-dismiss:hover { color: #888; background: #1a1a1a; }
    .agent-drop-empty {
      text-align: center; padding: 40px 20px; color: #444; font-size: 13px;
    }
    .agent-inbox-btn-badge {
      position: absolute; top: 5px; right: 5px;
      width: 7px; height: 7px; background: #c8f135;
      border-radius: 50%; border: 2px solid var(--bg, #0a0a0a);
      display: none;
    }
  `;
  document.head.appendChild(style);

  var _actions = [];
  var _isOpen = false;
  var _inboxBtn = null;

  var TYPE_LABELS = {
    quote_followup:   'Quote follow-up',
    invoice_followup: 'Invoice reminder',
    review_request:   'Review request',
  };

  var TYPE_LINKS = {
    quote_followup:   'swft-quotes',
    invoice_followup: 'swft-invoices',
    review_request:   'swft-jobs',
  };

  // ── Build dropdown ────────────────────────────────────────────────────────
  var dropdown = document.createElement('div');
  dropdown.className = 'agent-dropdown';
  dropdown.id = 'agent-dropdown';
  dropdown.innerHTML =
    '<div class="agent-drop-header">' +
      '<h4>AGENT INBOX <span class="agent-drop-badge" id="agent-drop-badge" style="display:none"></span></h4>' +
      '<button class="agent-scan-btn" id="agent-scan-btn">Scan now</button>' +
    '</div>' +
    '<div class="agent-drop-list" id="agent-drop-list"></div>';
  document.body.appendChild(dropdown);

  document.getElementById('agent-scan-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    triggerScan();
  });

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    var list = document.getElementById('agent-drop-list');
    var badge = document.getElementById('agent-drop-badge');
    if (!list) return;

    if (!_actions.length) {
      list.innerHTML = '<div class="agent-drop-empty">Your agent is watching — no pending actions</div>';
      badge.style.display = 'none';
      updateBtnBadge(false);
      return;
    }

    badge.textContent = _actions.length;
    badge.style.display = '';
    updateBtnBadge(true);

    list.innerHTML = _actions.map(function(a) {
      var typeClass = a.type || '';
      var typeLabel = TYPE_LABELS[a.type] || a.type;
      var viewPage  = TYPE_LINKS[a.type] || '';
      var preview   = (a.draftMessage || '').replace(/\n/g, ' ').slice(0, 110);
      if ((a.draftMessage || '').length > 110) preview += '…';
      var viewBtn = viewPage
        ? '<a class="agent-btn-view" href="' + viewPage + '" onclick="event.stopPropagation()">View &#8594;</a>'
        : '';
      return '<div class="agent-action-item" id="aitem-' + a.id + '">' +
        '<div class="agent-action-top">' +
          '<div class="agent-action-meta">' +
            '<span class="agent-action-customer">' + esc(a.customerName || 'Customer') + '</span>' +
            '<span class="agent-action-type ' + typeClass + '">' + typeLabel + '</span>' +
          '</div>' +
        '</div>' +
        (a.draftSubject ? '<div class="agent-action-subject">' + esc(a.draftSubject) + '</div>' : '') +
        '<div class="agent-action-preview">' + esc(preview) + '</div>' +
        '<div class="agent-action-btns">' +
          '<button class="agent-btn-send" id="asend-' + a.id + '" onclick="_agentApprove(\'' + a.id + '\')">Send</button>' +
          viewBtn +
          '<button class="agent-btn-dismiss" onclick="_agentDismiss(\'' + a.id + '\')">&#10005;</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function updateBtnBadge(hasItems) {
    if (_inboxBtn) {
      var dot = _inboxBtn.querySelector('.agent-inbox-btn-badge');
      if (dot) dot.style.display = hasItems ? '' : 'none';
    }
  }

  // ── API calls ─────────────────────────────────────────────────────────────
  async function loadActions() {
    try {
      if (typeof API === 'undefined' || !API.agentActions) return;
      var data = await API.agentActions.list();
      _actions = data.actions || [];
      render();
    } catch(e) { /* silently fail */ }
  }

  window._agentApprove = async function(id) {
    var btn = document.getElementById('asend-' + id);
    if (btn) { btn.textContent = 'Sending…'; btn.disabled = true; }
    try {
      await API.agentActions.approve(id);
      _actions = _actions.filter(function(a) { return a.id !== id; });
      render();
      if (typeof showToast === 'function') showToast('Email sent');
    } catch(e) {
      if (btn) { btn.textContent = 'Send'; btn.disabled = false; }
      if (typeof showToast === 'function') showToast('Send failed: ' + (e.message || 'error'));
    }
  };

  window._agentDismiss = async function(id) {
    try {
      await API.agentActions.dismiss(id);
      _actions = _actions.filter(function(a) { return a.id !== id; });
      render();
    } catch(e) { /* ignore */ }
  };

  async function triggerScan() {
    var btn = document.getElementById('agent-scan-btn');
    if (btn) btn.textContent = 'Scanning…';
    try {
      var result = await API.agentActions.scan();
      if (btn) btn.textContent = 'Scan now';
      await loadActions();
      if (typeof showToast === 'function') {
        showToast(result.drafted > 0
          ? result.drafted + ' new action' + (result.drafted > 1 ? 's' : '') + ' drafted'
          : 'Nothing new found');
      }
    } catch(e) {
      if (btn) btn.textContent = 'Scan now';
    }
  }

  // ── Inject button next to bell ────────────────────────────────────────────
  function injectButton() {
    var bellBtn = null;
    document.querySelectorAll('.icon-btn').forEach(function(btn) {
      if (btn.innerHTML.indexOf('M18 8A6') > -1 || btn.querySelector('.badge-dot')) {
        bellBtn = btn;
      }
    });
    if (!bellBtn) return;

    var btn = document.createElement('div');
    btn.className = 'icon-btn';
    btn.id = 'agent-inbox-btn';
    btn.title = 'Agent Inbox';
    // Sparkle / AI icon
    btn.innerHTML =
      '<svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
        '<path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" stroke-width="1.8" stroke-linejoin="round"/>' +
      '</svg>' +
      '<div class="agent-inbox-btn-badge"></div>';

    bellBtn.parentNode.insertBefore(btn, bellBtn);
    _inboxBtn = btn;

    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      _isOpen = !_isOpen;
      dropdown.classList.toggle('open', _isOpen);
      if (_isOpen) {
        var rect = btn.getBoundingClientRect();
        dropdown.style.top  = (rect.bottom + 8) + 'px';
        dropdown.style.right = (window.innerWidth - rect.right) + 'px';
        loadActions();
      }
    });
  }

  document.addEventListener('click', function(e) {
    if (_isOpen && !dropdown.contains(e.target)) {
      _isOpen = false;
      dropdown.classList.remove('open');
    }
  });

  function init() {
    injectButton();
    setTimeout(loadActions, 2200);
    setInterval(loadActions, 5 * 60 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
