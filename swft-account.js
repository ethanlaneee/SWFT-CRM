// ════════════════════════════════════════════════
// SWFT Account Settings Panel
// Injected on every page via <script src="swft-account.js"></script>
// Click the user tile in sidebar to open
// ════════════════════════════════════════════════

(function () {
  const API_BASE = "";

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
      color: #444; font-weight: 600; font-family: 'DM Sans', sans-serif;
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
      color: #444; margin-top: 8px; padding-top: 16px;
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

        <div class="account-section-title">Gmail Integration</div>
        <div class="account-field">
          <label class="account-label">Gmail Address</label>
          <input class="account-input" id="acct-gmail" placeholder="you@gmail.com"/>
        </div>
        <div class="account-field">
          <label class="account-label">Gmail App Password</label>
          <input class="account-input" id="acct-gmail-pw" type="password" placeholder="16-char app password"/>
        </div>
      </div>
      <div class="account-footer">
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

  // Open
  window.openAccountPanel = async function () {
    overlay.classList.add("open");
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();

      document.getElementById("acct-first").value = data.name?.split(" ")[0] || data.firstName || "";
      document.getElementById("acct-last").value = data.name?.split(" ").slice(1).join(" ") || data.lastName || "";
      document.getElementById("acct-company").value = data.company || "";
      document.getElementById("acct-phone").value = data.phone || "";
      document.getElementById("acct-email").value = data.email || "";
      document.getElementById("acct-gmail").value = data.gmailAddress || "";
      document.getElementById("acct-gmail-pw").value = data.gmailAppPassword ? "••••••••••••" : "";

      const first = (data.name?.split(" ")[0] || data.firstName || "?")[0];
      const last = (data.name?.split(" ")[1] || data.lastName || "")[0] || "";
      document.getElementById("acct-avatar").textContent = (first + last).toUpperCase();
    } catch (e) { /* ignore load errors */ }
  };

  // Close
  window.closeAccountPanel = function () {
    overlay.classList.remove("open");
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

      // Save Gmail if provided
      const gmail = document.getElementById("acct-gmail").value.trim();
      const gmailPw = document.getElementById("acct-gmail-pw").value.trim();
      if (gmail && gmailPw && !gmailPw.startsWith("••")) {
        await fetch(`${API_BASE}/api/email/configure`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ gmailAddress: gmail, gmailAppPassword: gmailPw }),
        });
      }

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

  // Wire tiles after DOM loads
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireUserTiles);
  } else {
    wireUserTiles();
  }
})();
