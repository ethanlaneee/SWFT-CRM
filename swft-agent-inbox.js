// ════════════════════════════════════════════════
// SWFT Agent Inbox
// Proactive AI actions — drops down from AI Active pill
// ════════════════════════════════════════════════

(function () {
  var style = document.createElement("style");
  style.textContent = `
    .agent-dropdown {
      position: fixed;
      top: 56px; right: 80px;
      width: 400px;
      max-width: calc(100vw - 16px);
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
    .ai-pill.agent-has-actions {
      background: rgba(200,241,53,0.13);
      border-color: rgba(200,241,53,0.35);
    }
    .ai-pill-count {
      font-family: 'JetBrains Mono', monospace;
      font-size: 9.5px; font-weight: 700;
      background: rgba(200,241,53,0.2); color: #c8f135;
      padding: 1px 6px; border-radius: 8px; letter-spacing: 0.3px;
      margin-left: 2px;
    }
  `;
  document.head.appendChild(style);

  var _actions = [];
  var _isOpen = false;
  var _pill = null;

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
      updatePill(0);
      return;
    }

    badge.textContent = _actions.length;
    badge.style.display = '';
    updatePill(_actions.length);

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

  function updatePill(count) {
    if (!_pill) return;
    _pill.classList.toggle('agent-has-actions', count > 0);
    var countEl = _pill.querySelector('.ai-pill-count');
    if (count > 0) {
      if (!countEl) {
        countEl = document.createElement('span');
        countEl.className = 'ai-pill-count';
        _pill.appendChild(countEl);
      }
      countEl.textContent = count;
    } else if (countEl) {
      countEl.remove();
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

  // ── Wire to AI Active pill ────────────────────────────────────────────────
  function wirePill() {
    _pill = document.querySelector('.ai-pill');
    if (!_pill) return;

    _pill.addEventListener('click', function(e) {
      e.stopPropagation();
      _isOpen = !_isOpen;
      dropdown.classList.toggle('open', _isOpen);
      if (_isOpen) {
        var rect = _pill.getBoundingClientRect();
        dropdown.style.top = (rect.bottom + 8) + 'px';
        if (window.innerWidth < 480) {
          dropdown.style.left = '8px';
          dropdown.style.right = '8px';
          dropdown.style.width = 'auto';
        } else {
          dropdown.style.left = '';
          dropdown.style.right = (window.innerWidth - rect.right) + 'px';
          dropdown.style.width = '';
        }
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
    wirePill();
    setTimeout(loadActions, 2200);
    setInterval(loadActions, 5 * 60 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
