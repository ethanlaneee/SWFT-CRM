// ════════════════════════════════════════════════
// SWFT Notification Dropdown
// Injected on every page via <script src="swft-notifications.js"></script>
// Click the bell icon in the topbar to open
// ════════════════════════════════════════════════

(function () {
  const style = document.createElement("style");
  style.textContent = `
    .notif-dropdown {
      position: fixed;
      top: 56px; right: 80px;
      width: 360px;
      max-height: 460px;
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

    .notif-list {
      flex: 1; overflow-y: auto; padding: 6px 0;
    }
    .notif-list::-webkit-scrollbar { width: 4px; }
    .notif-list::-webkit-scrollbar-thumb { background: #2c2c2c; border-radius: 2px; }

    .notif-item {
      display: flex; align-items: flex-start; gap: 12px;
      padding: 12px 18px;
      cursor: pointer; transition: background 0.12s;
      border-bottom: 1px solid #1a1a1a;
    }
    .notif-item:last-child { border-bottom: none; }
    .notif-item:hover { background: #181818; }
    .notif-item.unread { background: rgba(200,241,53,0.02); }
    .notif-item.unread::before {
      content: '';
      width: 6px; height: 6px; border-radius: 50%;
      background: #c8f135; flex-shrink: 0; margin-top: 6px;
    }
    .notif-item:not(.unread)::before {
      content: '';
      width: 6px; height: 6px; flex-shrink: 0; margin-top: 6px;
    }
    .notif-icon {
      width: 32px; height: 32px; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 15px; flex-shrink: 0;
    }
    .notif-body { flex: 1; min-width: 0; }
    .notif-text {
      font-size: 12.5px; color: #c8c8c8; line-height: 1.4;
    }
    .notif-text strong { color: #f0f0f0; }
    .notif-time {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px; color: #444; margin-top: 3px;
    }

    .notif-empty {
      text-align: center; padding: 40px 20px;
      color: #444; font-size: 13px;
    }
  `;
  document.head.appendChild(style);

  var notifications = [];

  // Build dropdown
  var dropdown = document.createElement("div");
  dropdown.className = "notif-dropdown";
  dropdown.innerHTML =
    '<div class="notif-header">' +
      '<h4>NOTIFICATIONS</h4>' +
      '<button class="notif-mark-read" onclick="markAllRead()">Mark all read</button>' +
    '</div>' +
    '<div class="notif-list" id="notif-list"></div>';
  document.body.appendChild(dropdown);

  function renderNotifications() {
    var list = document.getElementById("notif-list");
    if (!list) return;
    if (notifications.length === 0) {
      list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
    } else {
      list.innerHTML = notifications.map(function(n) {
        return '<div class="notif-item ' + (n.unread ? 'unread' : '') + '" onclick="' + (n.href ? "window.location.href='" + n.href + "'" : '') + '">' +
          '<div class="notif-icon" style="background:' + (n.bg || 'rgba(200,241,53,0.1)') + ';">' + (n.icon || '🔔') + '</div>' +
          '<div class="notif-body">' +
            '<div class="notif-text">' + n.text + '</div>' +
            '<div class="notif-time">' + (n.time || '') + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }
    updateBadge();
  }

  function updateBadge() {
    var hasUnread = notifications.some(function(n) { return n.unread; });
    document.querySelectorAll('.badge-dot').forEach(function(d) {
      d.style.display = hasUnread ? '' : 'none';
    });
  }

  function formatTimeAgo(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // Load saved notifications from localStorage
  try {
    var saved = JSON.parse(localStorage.getItem('swft_notifs') || '[]');
    saved.forEach(function(n) { notifications.push(n); });
  } catch (e) {}

  // Save notifications
  function saveNotifs() {
    try {
      localStorage.setItem('swft_notifs', JSON.stringify(notifications.slice(0, 50)));
    } catch (e) {}
  }

  // Check for new inbound messages
  async function checkNewMessages() {
    try {
      // Need auth token
      if (typeof getAuthToken !== 'function') return;
      var token = await getAuthToken();
      var res = await fetch('/api/messages', {
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
      });
      if (!res.ok) return;
      var messages = await res.json();

      var lastChecked = parseInt(localStorage.getItem('swft_notif_last_checked') || '0');
      var newInbound = messages.filter(function(m) {
        return m.direction === 'inbound' && (m.sentAt || 0) > lastChecked;
      });

      if (newInbound.length > 0) {
        // Add notifications for each new inbound message
        newInbound.forEach(function(m) {
          var isSms = m.type === 'sms';
          var icon = isSms ? '💬' : '✉️';
          var bg = isSms ? 'rgba(200,241,53,0.1)' : 'rgba(77,159,255,0.1)';
          var name = m.customerName || m.from || 'Unknown';
          var preview = (m.body || '').substring(0, 60);
          if (preview.length >= 60) preview += '…';
          var text = '<strong>' + name + '</strong> ' + (isSms ? 'sent an SMS' : 'sent an email');
          if (m.subject) text += ': ' + m.subject;
          if (preview && !m.subject) text += ': ' + preview;

          // Check if already exists (avoid duplicates)
          var msgId = m.id || m.gmailMessageId || m.twilioMessageSid || '';
          var exists = notifications.some(function(n) { return n.msgId === msgId; });
          if (!exists) {
            notifications.unshift({
              icon: icon,
              bg: bg,
              text: text,
              time: formatTimeAgo(m.sentAt),
              unread: true,
              msgId: msgId,
              href: 'swft-messages.html',
              sentAt: m.sentAt || 0
            });
          }
        });

        // Update last checked to the most recent message time
        var maxTime = Math.max.apply(null, newInbound.map(function(m) { return m.sentAt || 0; }));
        localStorage.setItem('swft_notif_last_checked', maxTime.toString());
        saveNotifs();
        renderNotifications();
      }
    } catch (e) {
      // Silently fail — user may not be logged in
    }
  }

  renderNotifications();

  // Toggle
  var isOpen = false;

  function wireIconBtns() {
    document.querySelectorAll(".icon-btn").forEach(function(btn) {
      if (btn.querySelector(".badge-dot") || btn.innerHTML.indexOf("M18 8A6") > -1) {
        btn.onclick = function(e) {
          e.stopPropagation();
          isOpen = !isOpen;
          dropdown.classList.toggle("open", isOpen);
          if (isOpen) {
            var rect = btn.getBoundingClientRect();
            dropdown.style.top = rect.bottom + 8 + "px";
            dropdown.style.right = window.innerWidth - rect.right + "px";
          }
        };
      }
    });
  }

  // Close on outside click
  document.addEventListener("click", function(e) {
    if (isOpen && !dropdown.contains(e.target)) {
      isOpen = false;
      dropdown.classList.remove("open");
    }
  });

  // Mark all read
  window.markAllRead = function () {
    notifications.forEach(function(n) { n.unread = false; });
    saveNotifs();
    renderNotifications();
  };

  // Public function to add notifications from anywhere
  window.swftNotify = function(text, icon, bg, href) {
    notifications.unshift({
      icon: icon || '🔔',
      bg: bg || 'rgba(200,241,53,0.1)',
      text: text,
      time: 'Just now',
      unread: true,
      href: href || ''
    });
    saveNotifs();
    renderNotifications();
  };

  // Wire after DOM loads, then check messages
  function init() {
    wireIconBtns();
    updateBadge();
    // Check for new messages after a short delay (let auth load)
    setTimeout(checkNewMessages, 1500);
    // Poll every 60 seconds
    setInterval(checkNewMessages, 60000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
