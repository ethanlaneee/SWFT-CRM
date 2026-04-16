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

  // ── Plan upgrade modal ────────────────────────────────────────────────────
  var upgradeStyle = document.createElement("style");
  upgradeStyle.textContent = `
    .upgrade-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.75);
      backdrop-filter: blur(6px);
      z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; pointer-events: none;
      transition: opacity 0.2s;
    }
    .upgrade-overlay.open { opacity: 1; pointer-events: all; }
    .upgrade-modal {
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
    .upgrade-overlay.open .upgrade-modal { transform: scale(1) translateY(0); }
    .upgrade-icon {
      width: 52px; height: 52px; border-radius: 14px;
      background: rgba(200,241,53,0.1);
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 16px;
      font-size: 24px;
    }
    .upgrade-title {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 20px; letter-spacing: 2px;
      color: #f0f0f0; margin: 0 0 8px;
    }
    .upgrade-body {
      font-size: 13px; color: #7a7a7a;
      line-height: 1.5; margin: 0 0 24px;
    }
    .upgrade-btns { display: flex; gap: 10px; justify-content: center; }
    .upgrade-btn-cta {
      background: #c8f135; border: none;
      border-radius: 10px; padding: 10px 24px;
      color: #0a0a0a; font-size: 13px; font-weight: 700;
      font-family: 'DM Sans', sans-serif;
      cursor: pointer; transition: all 0.14s;
    }
    .upgrade-btn-cta:hover { background: #d4f75a; }
    .upgrade-btn-close {
      background: #181818; border: 1px solid #2c2c2c;
      border-radius: 10px; padding: 10px 24px;
      color: #f0f0f0; font-size: 13px; font-weight: 600;
      font-family: 'DM Sans', sans-serif;
      cursor: pointer; transition: all 0.14s;
    }
    .upgrade-btn-close:hover { background: #222; }
    .nav-pro-badge {
      font-size: 9px; font-weight: 700; letter-spacing: 1px;
      color: #c8f135; background: rgba(200,241,53,0.1);
      padding: 2px 6px; border-radius: 4px; margin-left: auto;
    }
  `;
  document.head.appendChild(upgradeStyle);

  var upgradeOverlay = document.createElement("div");
  upgradeOverlay.className = "upgrade-overlay";
  upgradeOverlay.innerHTML = `
    <div class="upgrade-modal">
      <div class="upgrade-icon">&#9889;</div>
      <div class="upgrade-title">UPGRADE TO PRO</div>
      <div class="upgrade-body" id="upgrade-msg">This feature is available on the Pro plan and higher.</div>
      <div class="upgrade-btns">
        <button class="upgrade-btn-close" onclick="swftUpgradeClose()">Go back</button>
        <a href="/swft-checkout?plan=pro" class="upgrade-btn-cta" style="text-decoration:none;">Upgrade now</a>
      </div>
    </div>
  `;
  document.body.appendChild(upgradeOverlay);
  upgradeOverlay.addEventListener("click", function (e) { if (e.target === upgradeOverlay) swftUpgradeClose(); });

  window.SWFT_PLAN = null; // set after auth

  window.swftUpgradeRequired = function (msg, plan) {
    document.getElementById("upgrade-msg").textContent = msg || "This feature is available on the Pro plan and higher.";
    var cta = upgradeOverlay.querySelector(".upgrade-btn-cta");
    if (cta) cta.href = "/swft-checkout?plan=" + (plan || "pro");
    upgradeOverlay.querySelector(".upgrade-title").textContent = "UPGRADE TO " + (plan || "pro").toUpperCase();
    upgradeOverlay.classList.add("open");
  };
  window.swftUpgradeClose = function () {
    upgradeOverlay.classList.remove("open");
  };

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
          <div class="account-avatar-info">Your profile — managed in Settings</div>
        </div>

        <div class="account-field">
          <label class="account-label">First Name</label>
          <input class="account-input" id="acct-first" readonly style="opacity:0.7;cursor:default;"/>
        </div>
        <div class="account-field">
          <label class="account-label">Last Name</label>
          <input class="account-input" id="acct-last" readonly style="opacity:0.7;cursor:default;"/>
        </div>
        <div class="account-field">
          <label class="account-label">Company Name</label>
          <input class="account-input" id="acct-company" readonly style="opacity:0.7;cursor:default;"/>
        </div>
        <div class="account-field">
          <label class="account-label">Email</label>
          <input class="account-input" id="acct-email" readonly style="opacity:0.7;cursor:default;"/>
        </div>

      </div>
      <div class="account-footer">
        <button class="account-btn" onclick="logoutAccount()" style="color:#ff5252;border-color:rgba(255,82,82,0.3);">Log Out</button>
        <button class="account-btn" onclick="closeAccountPanel()">Close</button>
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

  // Save — no longer used (profile is read-only), kept for safety
  window.saveAccount = function () { closeAccountPanel(); };

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
    "swft-team-chat":   "teamchat.view",
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

  // Plan hierarchy for comparison
  const PLAN_LEVEL = { starter: 0, pro: 1, business: 2 };
  function planMeetsMin(userPlan, requiredPlan) {
    return (PLAN_LEVEL[userPlan] || 0) >= (PLAN_LEVEL[requiredPlan] || 0);
  }

  // Pages / nav items that require a minimum plan (Pro+)
  const PLAN_GATE = {
    "swft-ai-agents":   "pro",
    "swft-automations": "pro",
    "swft-broadcasts":  "pro",
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
    "swft-team-chat":   "teamchat.view",
    "swft-settings":    "settings.manage",
    "swft-ai-agents":   "automations.view",
    "swft-automations": "automations.view",
    "swft-broadcasts":  "broadcasts.view",
    "swft-connect":     "integrations.manage",
    "swft-reviews":     "reviews.view",
    "swft-import":      "import.use",
    "swft-intake":      "intake.manage",
  };

  // ── Immediately hide permission-gated nav items to prevent flash ──
  // This runs synchronously before auth resolves, so restricted items
  // are never visible. applyPermGuard() will reveal the allowed ones.
  (function hideGatedNavItems() {
    function doHide() {
      document.querySelectorAll(".nav-item[onclick]").forEach(function (el) {
        var oc = el.getAttribute("onclick") || "";
        for (var key in NAV_PERM) {
          if (oc.indexOf(key) > -1) {
            el.style.display = "none";
            el.setAttribute("data-perm-gated", "1");
            break;
          }
        }
      });
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", doHide);
    } else {
      doHide();
    }
  })();

  function applyPermGuard(perms, plan) {
    window.SWFT_PERMS = perms; // null = owner (unrestricted)
    if (plan) window.SWFT_PLAN = plan;
    var userPlan = window.SWFT_PLAN || "starter";

    // ── Cache for instant page transitions ──
    try {
      sessionStorage.setItem("swft_perms", perms === null ? "__owner__" : JSON.stringify(perms));
      sessionStorage.setItem("swft_plan", userPlan);
    } catch (_) {}

    // ── Show allowed nav items (all were hidden on load) ─────────────────
    document.querySelectorAll('.nav-item[data-perm-gated="1"]').forEach(function (el) {
      var oc = el.getAttribute("onclick") || "";
      var blocked = false;
      if (perms !== null) {
        for (var key in NAV_PERM) {
          if (oc.indexOf(key) > -1 && !perms.includes(NAV_PERM[key])) {
            blocked = true;
            break;
          }
        }
      }
      // Plan-based nav gating: hide or badge nav items gated to a higher plan
      if (!blocked) {
        for (var pkey in PLAN_GATE) {
          if (oc.indexOf(pkey) > -1 && !planMeetsMin(userPlan, PLAN_GATE[pkey])) {
            blocked = true;
            // Show with PRO badge instead of hiding completely
            el.style.display = "";
            el.style.opacity = "0.5";
            el.removeAttribute("data-perm-gated");
            if (!el.querySelector(".nav-pro-badge")) {
              var badge = document.createElement("span");
              badge.className = "nav-pro-badge";
              badge.textContent = "PRO";
              el.appendChild(badge);
            }
            // Intercept click to show upgrade modal
            (function (requiredPlan) {
              el.setAttribute("onclick", "");
              el.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                window.swftUpgradeRequired("This feature is available on the " + requiredPlan.charAt(0).toUpperCase() + requiredPlan.slice(1) + " plan and higher.", requiredPlan);
              };
            })(PLAN_GATE[pkey]);
            break;
          }
        }
      }
      if (!blocked) {
        el.style.display = "";
        el.style.opacity = "";
        el.removeAttribute("data-perm-gated");
      }
    });

    // ── Plan-based page redirect (check before role-based) ──────────────
    var page = window.location.pathname.split("/").pop().replace(/\.html$/, "");
    var planReq = PLAN_GATE[page];
    if (planReq && !planMeetsMin(userPlan, planReq)) {
      document.body.style.visibility = "visible";
      window.swftUpgradeRequired("This feature is available on the " + planReq.charAt(0).toUpperCase() + planReq.slice(1) + " plan and higher.", planReq);
      setTimeout(function () { window.location.href = "swft-dashboard"; }, 2500);
      return;
    }

    if (perms === null) {
      // Owner — show page immediately, skip remaining restrictions
      document.body.style.visibility = "visible";
      return;
    }

    // ── Role-based page redirect ────────────────────────────────────────
    var pageReq = PAGE_PERM[page];
    if (pageReq && !perms.includes(pageReq)) {
      document.body.style.visibility = "visible";
      window.swftNoPermission("You don't have permission to access this area.");
      setTimeout(function () { window.location.href = "swft-dashboard"; }, 1800);
      return;
    }

    // ── Intercept restricted action buttons ─────────────────────────────
    // Instead of hiding, replace onclick so they show the permission popup
    document.querySelectorAll("[onclick]").forEach(function (el) {
      var oc = el.getAttribute("onclick") || "";
      for (var fn in ONCLICK_PERM) {
        if (oc.indexOf(fn + "(") > -1 && !perms.includes(ONCLICK_PERM[fn])) {
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

    // ── Page is ready — reveal body after all permissions are applied ──
    document.body.style.visibility = "visible";
  }

  async function initRoleGuard() {
    // ── Instant apply from cache (no network wait on page transitions) ──
    var _appliedFromCache = false;
    try {
      var cached = sessionStorage.getItem("swft_perms");
      var cachedPlan = sessionStorage.getItem("swft_plan");
      if (cachedPlan) window.SWFT_PLAN = cachedPlan;
      if (cached !== null) {
        var cachedPerms = cached === "__owner__" ? null : JSON.parse(cached);
        applyPermGuard(cachedPerms, cachedPlan);
        _appliedFromCache = true;
      }
    } catch (_) {}

    // Safety fallback: if permissions take too long, show page anyway
    // (backend still enforces access — this only prevents a blank screen)
    var _permTimer = _appliedFromCache ? null : setTimeout(function () {
      if (document.body.style.visibility !== "visible") {
        document.body.style.visibility = "visible";
      }
    }, 3500);

    try {
      const { getAuth, onAuthStateChanged } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
      onAuthStateChanged(getAuth(), async function (user) {
        if (!user) {
          if (_permTimer) clearTimeout(_permTimer);
          sessionStorage.removeItem("swft_perms");
          sessionStorage.removeItem("swft_plan");
          document.body.style.visibility = "visible";
          return;
        }
        try {
          const token = await user.getIdToken();
          const res = await fetch(`${API_BASE}/api/me`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = await res.json();
          // Build permissions array from role + BUILT_IN defaults
          var BUILT_IN = {
            owner: null, // null = all
            admin: ["dashboard.view","customers.view","customers.add","customers.edit","customers.delete","jobs.view","jobs.viewAll","jobs.add","jobs.edit","jobs.delete","quotes.view","quotes.add","quotes.edit","quotes.delete","invoices.view","invoices.add","invoices.edit","invoices.delete","billing.view","billing.manage","schedule.view","schedule.add","schedule.edit","schedule.delete","messages.view","messages.send","messages.delete","email.send","email.templates","photos.upload","photos.delete","ai.use","broadcasts.view","broadcasts.send","broadcasts.delete","automations.view","automations.manage","reviews.view","reviews.respond","intake.view","intake.manage","import.use","team.manage","integrations.manage","settings.manage","teamchat.view","teamchat.send"],
            office: ["dashboard.view","customers.view","customers.add","customers.edit","customers.delete","jobs.view","jobs.viewAll","jobs.add","jobs.edit","jobs.delete","quotes.view","quotes.add","quotes.edit","quotes.delete","invoices.view","invoices.add","invoices.edit","invoices.delete","schedule.view","schedule.add","schedule.edit","schedule.delete","messages.view","messages.send","email.send","email.templates","photos.upload","ai.use","broadcasts.view","broadcasts.send","automations.view","reviews.view","reviews.respond","intake.view","teamchat.view","teamchat.send"],
            technician: ["dashboard.view","jobs.view","jobs.edit","schedule.view","messages.view","messages.send","ai.use","teamchat.view","teamchat.send"],
          };
          var role = data.role || "owner";
          var userPlan = data.plan || "starter";
          window.SWFT_PLAN = userPlan;
          var perms;
          if (role === "owner" || !BUILT_IN[role]) {
            perms = null; // unrestricted
          } else {
            perms = data.permissions || BUILT_IN[role];
          }
          if (_permTimer) clearTimeout(_permTimer);
          applyPermGuard(perms, userPlan);
        } catch (e) {
          if (_permTimer) clearTimeout(_permTimer);
          if (!_appliedFromCache) document.body.style.visibility = "visible";
        }
      });
    } catch (e) {
      if (_permTimer) clearTimeout(_permTimer);
      if (!_appliedFromCache) document.body.style.visibility = "visible";
    }
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
