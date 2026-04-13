// ════════════════════════════════════════════════
// SWFT Settings Loader
// Loads user settings and applies them globally
// Include via: <script src="swft-settings-loader.js"></script>
// ════════════════════════════════════════════════

(function () {
  // Cache written by swft-login.html immediately after auth succeeds.
  // Fresh cache (< 60 s) is applied instantly — no API round-trip needed.
  const ME_CACHE_KEY = 'swft_me_cache';
  const ME_CACHE_TTL = 60 * 1000;

  function applySettings(settings) {
    window._swftSettings = settings;

    // ── Service type dropdowns ──
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
  }

  async function fetchAndApplySettings() {
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
      // Update the cache so subsequent navigations are also fast
      sessionStorage.setItem(ME_CACHE_KEY, JSON.stringify({ data: settings, ts: Date.now() }));
      applySettings(settings);
    } catch (e) {
      // Settings load failed — use defaults silently
    }
  }

  function run() {
    // Try to serve from the prefetch cache synchronously (no delay).
    try {
      const raw = sessionStorage.getItem(ME_CACHE_KEY);
      if (raw) {
        const { data, ts } = JSON.parse(raw);
        if (Date.now() - ts < ME_CACHE_TTL) {
          applySettings(data);
          // Background refresh so the cache stays warm
          setTimeout(fetchAndApplySettings, 5000);
          return;
        }
      }
    } catch (_) { /* corrupt cache — fall through */ }

    // No fresh cache — fetch normally (small delay to let auth settle)
    setTimeout(fetchAndApplySettings, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
