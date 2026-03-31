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

  // Default notifications (sample data)
  const notifications = [
    { icon: "🤖", bg: "rgba(200,241,53,0.1)", text: "<strong>AI Receptionist</strong> booked an estimate for Nguyen — driveway resurface", time: "9 min ago", unread: true },
    { icon: "💳", bg: "rgba(77,159,255,0.1)", text: "<strong>Deposit received</strong> — Kim Driveway Resurface · $775 via card", time: "42 min ago", unread: true },
    { icon: "📋", bg: "rgba(245,166,35,0.1)", text: "<strong>Quote #1042 sent</strong> to Martinez — $4,800 stamped driveway", time: "2 hrs ago", unread: false },
    { icon: "⭐", bg: "rgba(200,241,53,0.08)", text: "<strong>New 5-star review</strong> from Chen — \"Professional, fast, and clean work.\"", time: "Yesterday", unread: false },
    { icon: "✅", bg: "rgba(100,100,100,0.1)", text: "<strong>Job completed</strong> — Chen Garage Floor · Invoice #1038 sent · $2,600", time: "Mar 25", unread: false },
    { icon: "🔔", bg: "rgba(245,166,35,0.1)", text: "<strong>Invoice overdue</strong> — Chen Garage Floor · $2,600 past due", time: "Mar 28", unread: false },
  ];

  // Build dropdown
  const dropdown = document.createElement("div");
  dropdown.className = "notif-dropdown";
  dropdown.innerHTML = `
    <div class="notif-header">
      <h4>NOTIFICATIONS</h4>
      <button class="notif-mark-read" onclick="markAllRead()">Mark all read</button>
    </div>
    <div class="notif-list" id="notif-list"></div>
  `;
  document.body.appendChild(dropdown);

  // Render notifications
  function renderNotifications() {
    const list = document.getElementById("notif-list");
    if (notifications.length === 0) {
      list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
      return;
    }
    list.innerHTML = notifications
      .map(
        (n) => `
      <div class="notif-item ${n.unread ? "unread" : ""}">
        <div class="notif-icon" style="background:${n.bg};">${n.icon}</div>
        <div class="notif-body">
          <div class="notif-text">${n.text}</div>
          <div class="notif-time">${n.time}</div>
        </div>
      </div>
    `
      )
      .join("");
  }
  // Check if all were previously marked as read
  const readAt = localStorage.getItem('swft_notifs_read_at');
  if (readAt) {
    notifications.forEach(n => n.unread = false);
    document.querySelectorAll('.badge-dot').forEach(d => d.style.display = 'none');
  }
  renderNotifications();

  // Toggle
  let isOpen = false;

  function wireIconBtns() {
    document.querySelectorAll(".icon-btn").forEach((btn) => {
      // Only wire bells (has the badge-dot or bell SVG)
      if (btn.querySelector(".badge-dot") || btn.innerHTML.includes("M18 8A6")) {
        btn.onclick = (e) => {
          e.stopPropagation();
          isOpen = !isOpen;
          dropdown.classList.toggle("open", isOpen);
          if (isOpen) {
            // Position near the bell
            const rect = btn.getBoundingClientRect();
            dropdown.style.top = rect.bottom + 8 + "px";
            dropdown.style.right = window.innerWidth - rect.right + "px";
          }
        };
      }
    });
  }

  // Close on outside click
  document.addEventListener("click", (e) => {
    if (isOpen && !dropdown.contains(e.target)) {
      isOpen = false;
      dropdown.classList.remove("open");
    }
  });

  // Mark all read
  window.markAllRead = function () {
    localStorage.setItem('swft_notifs_read_at', Date.now().toString());
    notifications.forEach((n) => (n.unread = false));
    renderNotifications();
    document.querySelectorAll(".badge-dot").forEach((d) => (d.style.display = "none"));
  };

  // Wire after DOM loads
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireIconBtns);
  } else {
    wireIconBtns();
  }
})();
