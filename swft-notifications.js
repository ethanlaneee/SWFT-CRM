// ════════════════════════════════════════════════
// SWFT Notification Bell
// Loads real notifications from /api/notifications
// Polls every 30s for new ones
// ════════════════════════════════════════════════

(function () {
  const style = document.createElement("style");
  style.textContent = `
    .notif-dropdown {
      position: fixed;
      top: 56px; right: 80px;
      width: 360px;
      max-height: 480px;
      background: #111111;
      border: 1px solid #2c2c2c;
      border-radius: 14px;
      z-index: 8500;
      opacity: 0; pointer-events: none;
      transform: translateY(-8px);
      transition: opacity 0.2s, transform 0.2s;
      box-shadow: 0 16px 64px rgba(0,0,0,0.5);
      overflow: hidden;
      display: flex; flex-direction: column;
    }
    .notif-dropdown.open { opacity: 1; pointer-events: all; transform: translateY(0); }
    .notif-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 18px;
      border-bottom: 1px solid #1f1f1f;
    }
    .notif-header h4 {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 16px; letter-spacing: 1.5px; color: #f0f0f0; margin: 0;
    }
    .notif-mark-read {
      font-size: 11px; color: #c8f135; cursor: pointer; font-weight: 500;
      background: none; border: none; font-family: 'DM Sans', sans-serif;
    }
    .notif-mark-read:hover { text-decoration: underline; }
    .notif-list { flex: 1; overflow-y: auto; padding: 6px 0; }
    .notif-list::-webkit-scrollbar { width: 4px; }
    .notif-list::-webkit-scrollbar-thumb { background: #2c2c2c; border-radius: 2px; }
    .notif-item {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 18px 12px 14px;
      cursor: pointer; transition: background 0.12s;
      border-bottom: 1px solid #1a1a1a; position: relative;
    }
    .notif-item:last-child { border-bottom: none; }
    .notif-item:hover { background: #181818; }
    .notif-unread-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #c8f135; flex-shrink: 0; margin-top: 7px;
    }
    .notif-read-dot { width: 6px; height: 6px; flex-shrink: 0; margin-top: 7px; }
    .notif-icon {
      width: 32px; height: 32px; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 15px; flex-shrink: 0;
    }
    .notif-body { flex: 1; min-width: 0; }
    .notif-title { font-size: 12.5px; color: #f0f0f0; font-weight: 600; margin-bottom: 1px; }
    .notif-text { font-size: 12px; color: #999; line-height: 1.4; }
    .notif-time { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #444; margin-top: 3px; }
    .notif-empty { text-align: center; padding: 40px 20px; color: #444; font-size: 13px; }
  `;
  document.head.appendChild(style);

  var _notifications = [];
  var _isOpen = false;

  // Icon map by type
  var TYPE_ICONS = {
    payment: { icon: '💰', bg: 'rgba(200,241,53,0.1)' },
    job:     { icon: '🔧', bg: 'rgba(77,159,255,0.1)' },
    message: { icon: '💬', bg: 'rgba(179,136,255,0.1)' },
    team:    { icon: '👥', bg: 'rgba(245,166,35,0.1)' },
    info:    { icon: '🔔', bg: 'rgba(200,241,53,0.07)' },
  };

  function formatTimeAgo(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // Build dropdown HTML
  var dropdown = document.createElement('div');
  dropdown.className = 'notif-dropdown';
  dropdown.id = 'notif-dropdown';
  dropdown.innerHTML =
    '<div class="notif-header">' +
      '<h4>NOTIFICATIONS</h4>' +
      '<button class="notif-mark-read" id="notif-mark-all-btn">Mark all read</button>' +
    '</div>' +
    '<div class="notif-list" id="notif-list"></div>';
  document.body.appendChild(dropdown);

  document.getElementById('notif-mark-all-btn').addEventListener('click', markAllRead);

  function render() {
    var list = document.getElementById('notif-list');
    if (!list) return;
    if (!_notifications.length) {
      list.innerHTML = '<div class="notif-empty">All caught up — no notifications</div>';
      updateBadge(false);
      return;
    }
    list.innerHTML = _notifications.map(function(n) {
      var meta = TYPE_ICONS[n.type] || TYPE_ICONS.info;
      return '<div class="notif-item" data-id="' + n.id + '" onclick="_notifClick(\'' + n.id + '\',\'' + (n.link || '') + '\')">' +
        (n.read ? '<div class="notif-read-dot"></div>' : '<div class="notif-unread-dot"></div>') +
        '<div class="notif-icon" style="background:' + meta.bg + '">' + meta.icon + '</div>' +
        '<div class="notif-body">' +
          '<div class="notif-title">' + (n.title || '') + '</div>' +
          '<div class="notif-text">' + (n.body || '') + '</div>' +
          '<div class="notif-time">' + formatTimeAgo(n.createdAt) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
    updateBadge(_notifications.some(function(n){ return !n.read; }));
  }

  function updateBadge(hasUnread) {
    document.querySelectorAll('.badge-dot').forEach(function(d) {
      d.style.display = hasUnread ? '' : 'none';
    });
  }

  window._notifClick = function(id, link) {
    // mark read
    markRead(id);
    if (link && link !== 'null' && link !== 'undefined') {
      window.location.href = link;
    }
  };

  async function loadNotifications() {
    try {
      if (typeof API === 'undefined' || !API.notifications) return;
      var notifs = await API.notifications.list();
      _notifications = notifs;
      render();
    } catch(e) {
      // silently fail if not authed yet
    }
  }

  async function markRead(id) {
    var n = _notifications.find(function(n){ return n.id === id; });
    if (!n || n.read) return;
    n.read = true;
    render();
    try { await API.notifications.read(id); } catch(e) {}
  }

  async function markAllRead() {
    _notifications.forEach(function(n) { n.read = true; });
    render();
    try { await API.notifications.readAll(); } catch(e) {}
  }

  // Toggle dropdown
  function wireIconBtns() {
    document.querySelectorAll('.icon-btn').forEach(function(btn) {
      // target the bell icon button by checking SVG content
      if (btn.innerHTML.indexOf('M18 8A6') > -1 || btn.querySelector('.badge-dot')) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          _isOpen = !_isOpen;
          dropdown.classList.toggle('open', _isOpen);
          if (_isOpen) {
            var rect = btn.getBoundingClientRect();
            dropdown.style.top  = (rect.bottom + 8) + 'px';
            dropdown.style.right = (window.innerWidth - rect.right) + 'px';
            loadNotifications(); // refresh on open
          }
        });
      }
    });
  }

  document.addEventListener('click', function(e) {
    if (_isOpen && !dropdown.contains(e.target)) {
      _isOpen = false;
      dropdown.classList.remove('open');
    }
  });

  // Public: push a local notification (used by other scripts)
  window.swftNotify = function(title, body, type, link) {
    _notifications.unshift({ id: '_local_' + Date.now(), title: title, body: body, type: type || 'info', link: link || null, read: false, createdAt: Date.now() });
    render();
  };

  function init() {
    wireIconBtns();
    // Load notifications after a short delay to let auth settle
    setTimeout(loadNotifications, 1800);
    // Poll every 30 seconds
    setInterval(loadNotifications, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
