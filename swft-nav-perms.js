// ════════════════════════════════════════════════
// SWFT Nav Permissions
// Hides sidebar nav items and redirects pages the current user cannot access.
// Include via: <script type="module" src="swft-nav-perms.js"></script>
// Must be loaded AFTER Firebase is initialized (place after swft-user-sync.js)
// ════════════════════════════════════════════════

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";

// Map from URL slug (no leading slash) → required permission
const PAGE_PERM = {
  "swft-customers":   "customers.view",
  "swft-jobs":        "jobs.view",
  "swft-billing":     "invoices.view",
  "swft-invoices":    "invoices.view",
  "swft-quotes":      "quotes.view",
  "swft-schedule":    "schedule.view",
  "swft-messages":    "messages.view",
  "swft-broadcasts":  "broadcasts.view",
  "swft-ai-agents":   "automations.view",
  "swft-reviews":     "reviews.view",
  "swft-connect":     "connect.view",
  "swft-team":        "team.manage",
  "swft-settings":    "settings.manage",
};

const CACHE_KEY_PREFIX = "swft_perms_";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedPerms(uid) {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY_PREFIX + uid);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.ts > CACHE_TTL) return null;
    return obj.permissions; // null means owner (all), array means specific perms
  } catch {
    return undefined; // undefined = not found / error
  }
}

function setCachedPerms(uid, permissions) {
  try {
    sessionStorage.setItem(CACHE_KEY_PREFIX + uid, JSON.stringify({ permissions, ts: Date.now() }));
  } catch {}
}

function applyNavPerms(permissions) {
  // null permissions = owner (unrestricted) — nothing to hide
  if (permissions === null) return;

  const permSet = new Set(permissions);

  // Hide nav items the user cannot access
  document.querySelectorAll(".nav-item").forEach(el => {
    const onclick = el.getAttribute("onclick") || "";
    const match = onclick.match(/['"]([^'"]+)['"]/);
    if (!match) return;
    const slug = match[1].replace(/^\//, "").split("?")[0];
    const perm = PAGE_PERM[slug];
    if (perm && !permSet.has(perm)) {
      el.style.display = "none";
    }
  });

  // Redirect if the current page requires a permission the user lacks
  const slug = window.location.pathname.replace(/^\//, "").replace(/\.html$/, "");
  const requiredPerm = PAGE_PERM[slug];
  if (requiredPerm && !permSet.has(requiredPerm)) {
    window.location.replace("/swft-dashboard");
  }
}

const auth = getAuth();

// Apply cached permissions immediately (before auth resolves) to avoid flash
const _fastUid = sessionStorage.getItem("swft_uid");
if (_fastUid) {
  const cached = getCachedPerms(_fastUid);
  if (cached !== undefined && cached !== null) {
    // Array of permissions — apply right away
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => applyNavPerms(cached));
    } else {
      applyNavPerms(cached);
    }
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  // Remember uid for next-page fast path
  sessionStorage.setItem("swft_uid", user.uid);

  // Check cache first
  const cached = getCachedPerms(user.uid);
  if (cached !== undefined) {
    // cached is either null (owner) or array
    applyNavPerms(cached);
    return;
  }

  // Fetch from server
  try {
    const token = await user.getIdToken();
    const res = await fetch("/api/team/me", {
      headers: { Authorization: "Bearer " + token },
    });
    if (!res.ok) return;
    const data = await res.json();
    const permissions = data.permissions; // null or array
    setCachedPerms(user.uid, permissions);
    applyNavPerms(permissions);
  } catch {
    // Non-fatal — leave nav fully visible on error
  }
});
