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

      // Apply service types to all service dropdowns on the page
      if (settings.serviceTypes) {
        const types = settings.serviceTypes.split(",").map(function (s) { return s.trim(); });
        document.querySelectorAll("#e-service, #nj-service").forEach(function (sel) {
          const current = sel.value;
          sel.innerHTML = "";
          types.forEach(function (t) {
            const opt = document.createElement("option");
            opt.value = t;
            opt.textContent = t;
            sel.appendChild(opt);
          });
          // Add "Other" option
          const other = document.createElement("option");
          other.value = "Other";
          other.textContent = "Other";
          sel.appendChild(other);
          if (current) sel.value = current;
        });
      }

      // Apply crew names to all crew dropdowns
      if (settings.crewNames) {
        const crews = settings.crewNames.split(",").map(function (s) { return s.trim(); });
        document.querySelectorAll("#e-crew, #nj-crew").forEach(function (sel) {
          const current = sel.value;
          sel.innerHTML = "";
          crews.forEach(function (c) {
            const opt = document.createElement("option");
            opt.value = c;
            opt.textContent = c;
            sel.appendChild(opt);
          });
          // Add Unassigned and Other
          var ua = document.createElement("option");
          ua.value = "Unassigned";
          ua.textContent = "Unassigned";
          sel.appendChild(ua);
          var other = document.createElement("option");
          other.value = "Other";
          other.textContent = "Other";
          sel.appendChild(other);
          if (current) sel.value = current;
        });
      }
    } catch (e) {
      // Settings load failed - use defaults
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
