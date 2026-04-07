// ════════════════════════════════════════════════
// SWFT Settings Loader
// Loads user settings and applies them globally
// Include via: <script src="swft-settings-loader.js"></script>
// ════════════════════════════════════════════════

(function () {
  async function loadAndApplySettings() {
    try {
      const { getAuth } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
      const auth = getAuth();
      if (!auth.currentUser) {
        await new Promise((r) => {
          const u = auth.onAuthStateChanged((user) => { u(); r(user); });
        });
      }
      if (!auth.currentUser) return;

      const token = await auth.currentUser.getIdToken();
      const res = await fetch("/api/me", {
        headers: { Authorization: "Bearer " + token },
      });
      const settings = await res.json();
      window._swftSettings = settings;

      // ── Service type dropdowns ──
      // Always rebuild from settings. If blank/missing, leave just an empty option.
      const serviceTypes = (settings.serviceTypes || "")
        .split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      document.querySelectorAll("#e-service, #nj-service").forEach(function (sel) {
        const current = sel.value;
        sel.innerHTML = "";
        if (serviceTypes.length === 0) {
          const blank = document.createElement("option");
          blank.value = ""; blank.textContent = "—";
          sel.appendChild(blank);
        } else {
          serviceTypes.forEach(function (t) {
            const opt = document.createElement("option");
            opt.value = t; opt.textContent = t;
            sel.appendChild(opt);
          });
          const other = document.createElement("option");
          other.value = "Other"; other.textContent = "Other";
          sel.appendChild(other);
          if (current) sel.value = current;
        }
      });

      // ── Line item description dropdowns ──
      // Rebuild from settings.lineItemTypes if set, otherwise use built-in defaults.
      const defaultLineItems = [
        "Materials", "Labor", "Equipment Rental",
        "Delivery / Haul-Off", "Disposal / Cleanup",
        "Permit Fee", "Misc"
      ];
      const lineItemTypes = (settings.lineItemTypes || "")
        .split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      const lineItems = lineItemTypes.length > 0 ? lineItemTypes : defaultLineItems;

      document.querySelectorAll(".swft-desc-select").forEach(function (sel) {
        const current = sel.value;
        // Keep the blank placeholder option, replace everything else
        sel.innerHTML = '<option value="">Select description…</option>';
        lineItems.forEach(function (t) {
          const opt = document.createElement("option");
          opt.value = t; opt.textContent = t;
          sel.appendChild(opt);
        });
        const custom = document.createElement("option");
        custom.value = "__custom__"; custom.textContent = "Custom…";
        sel.appendChild(custom);
        if (current) sel.value = current;
      });

      // ── Crew name dropdowns ──
      // Always rebuild; if blank/missing, leave just an empty option.
      const crewNames = (settings.crewNames || "")
        .split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      document.querySelectorAll("#e-crew, #nj-crew").forEach(function (sel) {
        const current = sel.value;
        sel.innerHTML = "";
        if (crewNames.length === 0) {
          const blank = document.createElement("option");
          blank.value = ""; blank.textContent = "—";
          sel.appendChild(blank);
        } else {
          crewNames.forEach(function (c) {
            const opt = document.createElement("option");
            opt.value = c; opt.textContent = c;
            sel.appendChild(opt);
          });
          var ua = document.createElement("option");
          ua.value = "Unassigned"; ua.textContent = "Unassigned";
          sel.appendChild(ua);
          var other = document.createElement("option");
          other.value = "Other"; other.textContent = "Other";
          sel.appendChild(other);
          if (current) sel.value = current;
        }
      });
    } catch (e) {
      // Settings load failed — use defaults silently
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(loadAndApplySettings, 500);
    });
  } else {
    setTimeout(loadAndApplySettings, 500);
  }
})();
