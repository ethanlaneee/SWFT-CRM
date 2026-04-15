// ════════════════════════════════════════════════
// SWFT Account Settings Panel
// Injected on every page via <script src="swft-account.js"></script>
// Click the user tile in sidebar to open
// ════════════════════════════════════════════════

(function () {
  const API_BASE = "";

  // ── Permission denied modal ───────────────────────────────────────────────
  const permStyle = document.createElement("style");
  permStyle.textContent = `
    .perm-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.75);
      backdrop-filter: blur(6px);
      z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; pointer-events: none;
      transition: opacity 0.2s;
    }
    .perm-overlay.open { opacity: 1; pointer-events: all; }
    .perm-modal {
      background: #111111;
      border: 1px solid #2c2c2c;
      border-radius: 16px;
      width: 100%; max-width: 380px;
      padding: 32px 28px 24px;
      text-align: center;
      transform: scale(0.95) translateY(10px);
      transition: transform 0.22s cubic-bezier(0.22,1,0.36,1);
      box-shadow: 0 24px 80px rgba(0,0,0,0.6);
    }
    .perm-overlay.open .perm-modal { transform: scale(1) translateY(0); }
    .perm-icon {
      width: 52px; height: 52px; border-radius: 14px;
      background: rgba(255,82,82,0.1);
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 16px;
      font-size: 24px;
    }
    .perm-title {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 20px; letter-spacing: 2px;
      color: #f0f0f0; margin: 0 0 8px;
    }
    .perm-body {
      font-size: 13px; color: #7a7a7a;
      line-height: 1.5; margin: 0 0 24px;
    }
    .perm-close {
      background: #181818; border: 1px solid #2c2c2c;
      border-radius: 10px; padding: 10px 28px;
      color: #f0f0f0; font-size: 13px; font-weight: 600;
      font-family: 'DM Sans', sans-serif;
      cursor: pointer; transition: all 0.14s;
    }
    .perm-close:hover { background: #222; }
  `;
  document.head.appendChild(permStyle);

  const permOverlay = document.createElement("div");
  permOverlay.className = "perm-overlay";
  permOverlay.innerHTML = `
    <div class="perm-modal">
      <div class="perm-icon">🔒</div>
      <div class="perm-title">ACCESS DENIED</div>
      <div class="perm-body" id="perm-msg">You don't have permission to perform this action. Contact your admin to request access.</div>
      <button class="perm-close" onclick="swftPermClose()">Got it</button>
    </div>
  `;
  document.body.appendChild(permOverlay);
  permOverlay.addEventListener("click", function (e) { if (e.target === permOverlay) swftPermClose(); });

  window.swftNoPermission = function (msg) {
    document.getElementById("perm-msg").textContent = msg || "You don't have permission to perform this action.";
    permOverlay.classList.add("open");
  };
  window.swftPermClose = function () { permOverlay.classList.remove("open"); };

  // ── Permissions cache ─────────────────────────────────────────────────────
  window.SWFT_PERMS = null; // Set after auth, array of permission IDs

  window.can = function (perm) {
    if (window.SWFT_PERMS === undefined) return true; // not loaded yet — don't block
    if (window.SWFT_PERMS === null) return true;      // owner — unrestricted
    return window.SWFT_PERMS.includes(perm);
  };

  const style = document.createElement("style");
  style.textContent = `
    .account-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(6px);
      z-index: 8000;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; pointer-events: none;
      transition: opacity 0.22s;
    }
    .account-overlay.open { opacity: 1; pointer-events: all; }

    .account-modal {
      background: #111111;
      border: 1px solid #2c2c2c;
      border-radius: 18px;
      width: 100%; max-width: 480px;
      max-height: 85vh;
      overflow-y: auto;
      transform: scale(0.96) translateY(12px);
      transition: transform 0.25s cubic-bezier(0.22,1,0.36,1);
      box-shadow: 0 24px 80px rgba(0,0,0,0.6);
      padding: 0;
    }
    .account-overlay.open .account-modal { transform: scale(1) translateY(0); }

    .account-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 22px 24px 16px;
      border-bottom: 1px solid #1f1f1f;
    }
    .account-header h3 {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 22px; letter-spacing: 2px; color: #f0f0f0; margin: 0;
    }
    .account-close {
      width: 30px; height: 30px; border-radius: 8px;
      border: 1px solid #2c2c2c; background: transparent;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; color: #7a7a7a; transition: all 0.14s;
    }
    .account-close:hover { background: #181818; color: #f0f0f0; }

    .account-body { padding: 20px 24px; display: flex; flex-direction: column; gap: 16px; }

    .account-field { display: flex; flex-direction: column; gap: 5px; }
    .account-label {
      font-size: 10px; letter-spacing: 1.2px; text-transform: uppercase;
      color: #f0f0f0; font-weight: 600; font-family: 'DM Sans', sans-serif;
    }
    .account-input {
      background: #181818; border: 1px solid #2c2c2c; border-radius: 8px;
      padding: 10px 12px; color: #f0f0f0;
      font-family: 'DM Sans', sans-serif; font-size: 13px;
      outline: none; transition: border-color 0.15s;
    }
    .account-input:focus { border-color: #c8f135; }

    .account-section-title {
      font-size: 9.5px; letter-spacing: 2px; text-transform: uppercase;
      color: #f0f0f0; margin-top: 8px; padding-top: 16px;
      border-top: 1px solid #1f1f1f;
    }

    .account-footer {
      padding: 16px 24px; border-top: 1px solid #1f1f1f;
      display: flex; gap: 10px;
    }
    .account-btn {
      flex: 1; padding: 10px; border-radius: 10px;
      border: 1px solid #2c2c2c; background: transparent;
      color: #7a7a7a; font-size: 12.5px; font-family: 'DM Sans', sans-serif;
      cursor: pointer; transition: all 0.14s; font-weight: 500; text-align: center;
    }
    .account-btn:hover { background: #181818; color: #f0f0f0; }
    .account-btn.primary {
      background: #c8f135; color: #0a0a0a; font-weight: 700; border-color: #c8f135;
    }
    .account-btn.primary:hover { background: #d5ff40; }

    .account-avatar-row {
      display: flex; align-items: center; gap: 14px; padding-bottom: 8px;
    }
    .account-avatar-big {
      width: 52px; height: 52px; border-radius: 50%;
      background: #c8f135; color: #0a0a0a;
      font-size: 18px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
      font-family: 'Bebas Neue', sans-serif; letter-spacing: 1px;
    }
    .account-avatar-info {
      font-size: 12px; color: #7a7a7a;
    }
  `;
  document.head.appendChild(style);

  // Build modal
  const overlay = document.createElement("div");
  overlay.className = "account-overlay";
  overlay.innerHTML = `
    <div class="account-modal">
      <div class="account-header">
        <h3>ACCOUNT SETTINGS</h3>
        <button class="account-close" onclick="closeAccountPanel()">&times;</button>
      </div>
      <div class="account-body">
        <div class="account-avatar-row">
          <div class="account-avatar-big" id="acct-avatar">?</div>
          <div class="account-avatar-info">Click save to update your profile</div>
        </div>

        <div class="account-field">
          <label class="account-label">First Name</label>
          <input class="account-input" id="acct-first" placeholder="Your first name"/>
        </div>
        <div class="account-field">
          <label class="account-label">Last Name</label>
          <input class="account-input" id="acct-last" placeholder="Your last name"/>
        </div>
        <div class="account-field">
          <label class="account-label">Company Name</label>
          <input class="account-input" id="acct-company" placeholder="e.g. SWFT Concrete"/>
        </div>
        <div class="account-field">
          <label class="account-label">Phone</label>
          <input class="account-input" id="acct-phone" placeholder="(512) 555-1234"/>
        </div>
        <div class="account-field">
          <label class="account-label">Email</label>
          <input class="account-input" id="acct-email" placeholder="you@example.com" readonly style="opacity:0.6;"/>
        </div>

      </div>
      <div class="account-footer">
        <button class="account-btn" onclick="logoutAccount()" style="color:#ff5252;border-color:rgba(255,82,82,0.3);">Log Out</button>
        <button class="account-btn" onclick="closeAccountPanel()">Cancel</button>
        <button class="account-btn primary" onclick="saveAccount()">Save Changes</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Close on overlay click
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeAccountPanel();
  });

  // Wire up all user-tile clicks
  function wireUserTiles() {
    document.querySelectorAll(".user-tile").forEach((tile) => {
      tile.onclick = (e) => {
        e.preventDefault();
        openAccountPanel();
      };
    });
  }

  // Get auth token
  async function getToken() {
    const { getAuth } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
    const auth = getAuth();
    if (!auth.currentUser) {
      await new Promise((resolve) => {
        const unsub = auth.onAuthStateChanged((u) => { unsub(); resolve(u); });
      });
    }
    return auth.currentUser.getIdToken();
  }

  // Open — instant fill from Firebase Auth, then enhance from Firestore
  window.openAccountPanel = async function () {
    overlay.classList.add("open");

    // Step 1: Instant fill from Firebase Auth (no network call)
    try {
      const { getAuth } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
      const user = getAuth().currentUser;
      if (user) {
        const displayName = user.displayName || "";
        const parts = displayName.split(" ");
        document.getElementById("acct-first").value = parts[0] || "";
        document.getElementById("acct-last").value = parts.slice(1).join(" ") || "";
        document.getElementById("acct-email").value = user.email || "";
        const initials = ((parts[0] || "?")[0] + (parts[1] || "")[0]).toUpperCase();
        document.getElementById("acct-avatar").textContent = initials || "?";
      }
    } catch (e) {}

    // Step 2: Enhance from Firestore (has company, phone, gmail)
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();

      if (data.firstName || data.name) {
        document.getElementById("acct-first").value = data.firstName || data.name?.split(" ")[0] || "";
        document.getElementById("acct-last").value = data.lastName || data.name?.split(" ").slice(1).join(" ") || "";
      }
      document.getElementById("acct-company").value = data.company || "";
      document.getElementById("acct-phone").value = data.phone || "";
      if (data.email) document.getElementById("acct-email").value = data.email;

      const first = (data.firstName || data.name?.split(" ")[0] || "?")[0];
      const last = (data.lastName || data.name?.split(" ")[1] || "")[0] || "";
      document.getElementById("acct-avatar").textContent = (first + last).toUpperCase();
    } catch (e) { /* Firestore fetch failed, Auth data is still shown */ }
  };

  // Close
  window.closeAccountPanel = function () {
    overlay.classList.remove("open");
  };

  // Logout
  window.logoutAccount = async function () {
    try {
      const { getAuth, signOut } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
      await signOut(getAuth());
      window.location.href = "swft-landing";
    } catch (e) {
      window.location.href = "swft-landing";
    }
  };

  // Save
  window.saveAccount = async function () {
    const firstName = document.getElementById("acct-first").value.trim();
    const lastName = document.getElementById("acct-last").value.trim();
    const name = [firstName, lastName].filter(Boolean).join(" ");

    try {
      const token = await getToken();

      // Save profile
      await fetch(`${API_BASE}/api/me`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name,
          firstName,
          lastName,
          company: document.getElementById("acct-company").value.trim(),
          phone: document.getElementById("acct-phone").value.trim(),
        }),
      });

      // Update sidebar user tile
      document.querySelectorAll(".user-name").forEach((el) => {
        el.textContent = name || "User";
      });
      document.querySelectorAll(".s-avatar, .avatar").forEach((el) => {
        el.textContent = ((firstName[0] || "") + (lastName[0] || "")).toUpperCase() || "?";
      });

      closeAccountPanel();
      if (typeof showToast === "function") showToast("Account updated");
    } catch (e) {
      if (typeof showToast === "function") showToast("Error saving: " + e.message);
    }
  };

  // ── Role / permission guard ───────────────────────────────────────────────

  // Page-level restrictions: if user lacks the permission, redirect to dashboard
  const PAGE_PERM = {
    "swft-customers":   "customers.view",
    "swft-billing":     "billing.view",
    "swft-invoices":    "invoices.view",
    "swft-quotes":      "quotes.view",
    "swft-jobs":        "jobs.view",
    "swft-schedule":    "schedule.view",
    "swft-messages":    "messages.view",
    "swft-team":        "team.manage",
    "swft-settings":    "settings.manage",
    "swft-ai-agents":   "automations.view",
    "swft-automations": "automations.view",
    "swft-broadcasts":  "broadcasts.view",
    "swft-connect":     "integrations.manage",
    "swft-reviews":     "reviews.view",
    "swft-import":      "import.use",
    "swft-intake":      "intake.manage",
  };

  // onclick → permission needed to run it (used to intercept or hide buttons)
  const ONCLICK_PERM = {
    // Jobs
    "openNewJob":          "jobs.add",
    "enterEditMode":       "jobs.edit",
    "saveEdit":            "jobs.edit",
    "deleteJob":           "jobs.delete",
    "deleteJobRow":        "jobs.delete",
    // Customers
    "openNewCustomer":     "customers.add",
    "enterCustomerEdit":   "customers.edit",
    "saveCustomerEdit":    "customers.edit",
    "deleteCustomer":      "customers.delete",
    "deleteSelected":      "customers.delete",
    // Quotes
    "openNewQuote":        "quotes.add",
    "saveQuote":           "quotes.edit",
    "deleteQuote":         "quotes.delete",
    // Invoices
    "openNewInvoice":      "invoices.add",
    "saveInvoice":         "invoices.edit",
    "deleteInvoice":       "invoices.delete",
    // Schedule
    "deleteScheduleEvent": "schedule.delete",
    // Photos
    "deletePhoto":         "photos.delete",
    // Messages / Broadcasts
    "deleteMessage":       "messages.delete",
    "deleteBroadcast":     "broadcasts.delete",
    "sendBroadcast":       "broadcasts.send",
    // Reviews
    "respondToReview":     "reviews.respond",
  };

  // Nav item onclick patterns → permission needed to see that nav item
  const NAV_PERM = {
    "swft-customers":   "customers.view",
    "swft-billing":     "billing.view",
    "swft-invoices":    "invoices.view",
    "swft-quotes":      "quotes.view",
    "swft-jobs":        "jobs.view",
    "swft-schedule":    "schedule.view",
    "swft-messages":    "messages.view",
    "swft-team":        "team.manage",
    "swft-settings":    "settings.manage",
    "swft-ai-agents":   "automations.view",
    "swft-automations": "automations.view",
    "swft-broadcasts":  "broadcasts.view",
    "swft-connect":     "integrations.manage",
    "swft-reviews":     "reviews.view",
    "swft-import":      "import.use",
    "swft-intake":      "intake.manage",
  };

  function applyPermGuard(perms) {
    window.SWFT_PERMS = perms; // null = owner (unrestricted)
    if (perms === null) return; // owner — skip all restrictions

    // ── Page redirect ────────────────────────────────────────────────────
    var page = window.location.pathname.split("/").pop().replace(/\.html$/, "");
    var pageReq = PAGE_PERM[page];
    if (pageReq && !window.SWFT_PERMS.includes(pageReq)) {
      window.swftNoPermission("You don't have permission to access this area.");
      setTimeout(function () { window.location.href = "swft-dashboard"; }, 1800);
      return;
    }

    // ── Hide restricted nav items ────────────────────────────────────────
    document.querySelectorAll(".nav-item[onclick]").forEach(function (el) {
      var oc = el.getAttribute("onclick") || "";
      for (var key in NAV_PERM) {
        if (oc.indexOf(key) > -1 && !window.SWFT_PERMS.includes(NAV_PERM[key])) {
          el.style.display = "none";
          break;
        }
      }
    });

    // ── Intercept restricted action buttons ─────────────────────────────
    // Instead of hiding, replace onclick so they show the permission popup
    document.querySelectorAll("[onclick]").forEach(function (el) {
      var oc = el.getAttribute("onclick") || "";
      for (var fn in ONCLICK_PERM) {
        if (oc.indexOf(fn + "(") > -1 && !window.SWFT_PERMS.includes(ONCLICK_PERM[fn])) {
          (function (perm, label) {
            el.setAttribute("onclick", "");
            el.onclick = function (e) {
              e.stopPropagation();
              window.swftNoPermission("You don't have permission to " + label + ".");
            };
          })(ONCLICK_PERM[fn], ONCLICK_PERM[fn].replace(".", " "));
          break;
        }
      }
    });
  }

  async function initRoleGuard() {
    try {
      const { getAuth, onAuthStateChanged } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
      onAuthStateChanged(getAuth(), async function (user) {
        if (!user) return;
        try {
          const token = await user.getIdToken();
          const res = await fetch(`${API_BASE}/api/me`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = await res.json();
          // Build permissions array from role + BUILT_IN defaults
          var BUILT_IN = {
            owner: null, // null = all
            admin: ["dashboard.view","customers.view","customers.add","customers.edit","customers.delete","jobs.view","jobs.viewAll","jobs.add","jobs.edit","jobs.delete","quotes.view","quotes.add","quotes.edit","quotes.delete","invoices.view","invoices.add","invoices.edit","invoices.delete","billing.view","billing.manage","schedule.view","schedule.add","schedule.edit","schedule.delete","messages.view","messages.send","messages.delete","email.send","email.templates","photos.upload","photos.delete","ai.use","broadcasts.view","broadcasts.send","broadcasts.delete","automations.view","automations.manage","reviews.view","reviews.respond","intake.view","intake.manage","import.use","team.manage","integrations.manage","settings.manage"],
            office: ["dashboard.view","customers.view","customers.add","customers.edit","customers.delete","jobs.view","jobs.viewAll","jobs.add","jobs.edit","jobs.delete","quotes.view","quotes.add","quotes.edit","quotes.delete","invoices.view","invoices.add","invoices.edit","invoices.delete","schedule.view","schedule.add","schedule.edit","schedule.delete","messages.view","messages.send","email.send","email.templates","photos.upload","ai.use","broadcasts.view","broadcasts.send","automations.view","reviews.view","reviews.respond","intake.view"],
            technician: ["dashboard.view","jobs.view","jobs.edit","schedule.view","messages.view","messages.send","ai.use"],
          };
          var role = data.role || "owner";
          var perms;
          if (role === "owner" || !BUILT_IN[role]) {
            perms = null; // unrestricted
          } else {
            perms = data.permissions || BUILT_IN[role];
          }
          applyPermGuard(perms);
        } catch (e) { /* fail silently — backend enforces anyway */ }
      });
    } catch (e) {}
  }

  // Wire tiles after DOM loads
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      wireUserTiles();
      initRoleGuard();
    });
  } else {
    wireUserTiles();
    initRoleGuard();
  }
})();
