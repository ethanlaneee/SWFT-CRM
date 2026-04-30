// ════════════════════════════════════════════════
// SWFT User Sync
// Syncs the sidebar user tile with the logged-in account.
// Include via: <script type="module" src="swft-user-sync.js"></script>
// Must be loaded AFTER Firebase is initialized.
//
// Source of truth: /api/me (the server route, which self-heals firstName/
// lastName/name from the Firebase Auth displayName captured at signup).
// We deliberately do NOT read users/{uid} via the Firestore client SDK —
// rules can block that, the read fails silently, and the email-prefix
// fallback would then overwrite the correct cached name.
// ════════════════════════════════════════════════

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";

const auth = getAuth();

function applyProfile(fullName, initials, email) {
  document.querySelectorAll(".user-name").forEach((el) => { el.textContent = fullName; });
  document.querySelectorAll(".s-avatar, .avatar").forEach((el) => { el.textContent = initials; });
  document.querySelectorAll(".user-role").forEach((el) => { el.textContent = email || ""; });
}

// Apply cached profile immediately at DOM-ready — before auth/network resolves.
// This makes the name appear instantly on every page transition.
const _cached = sessionStorage.getItem("swft_profile");
if (_cached) {
  try {
    const p = JSON.parse(_cached);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => applyProfile(p.fullName, p.initials, p.email));
    } else {
      applyProfile(p.fullName, p.initials, p.email);
    }
  } catch (e) { /* ignore bad cache */ }
}

function deriveNameParts(data) {
  let firstName = data.firstName || "";
  let lastName  = data.lastName  || "";
  if (!firstName && !lastName && data.name) {
    const parts = String(data.name).trim().split(/\s+/);
    firstName = parts[0] || "";
    lastName  = parts.slice(1).join(" ") || "";
  }
  return { firstName, lastName };
}

// ── Demo account cleanup ──
// If this is a demo session, fire a beacon to delete the account when the user leaves.
function setupDemoCleanup(uid) {
  if (!uid || !uid.startsWith("demo-")) return;
  const payload = JSON.stringify({ uid });
  const fire = () => navigator.sendBeacon("/api/demo-cleanup", new Blob([payload], { type: "application/json" }));
  window.addEventListener("beforeunload", fire);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") fire(); });
}

onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  let firstName = "";
  let lastName = "";

  // Primary: /api/me — same source the Settings page reads/writes, so the
  // sidebar can never disagree with what's shown in "Your Profile".
  try {
    const token = await user.getIdToken();
    const res = await fetch("/api/me", { headers: { Authorization: "Bearer " + token } });
    if (res.ok) {
      const data = await res.json();
      const parts = deriveNameParts(data);
      firstName = parts.firstName;
      lastName  = parts.lastName;
    }
  } catch (e) { /* network failure — fall through to local fallbacks */ }

  // Fallback 1: Firebase Auth displayName (set at signup).
  if (!firstName && user.displayName) {
    const parts = user.displayName.trim().split(/\s+/);
    firstName = parts[0] || "";
    lastName  = parts.slice(1).join(" ") || "";
  }

  // Fallback 2: email prefix. ONLY use this when no cached name is already
  // displayed — otherwise we'd overwrite the user's real name with their
  // login slug just because /api/me hiccupped on this load.
  if (!firstName && user.email) {
    let cachedName = "";
    try { cachedName = (JSON.parse(sessionStorage.getItem("swft_profile") || "{}").fullName) || ""; } catch (_) {}
    if (!cachedName) {
      firstName = user.email.split("@")[0];
    } else {
      // Keep whatever the cache shows; don't downgrade to the email prefix.
      // Email below will still update so login identity stays correct.
      const fullName = cachedName;
      const initials = (fullName.split(/\s+/).map(p => p[0] || "").join("").slice(0, 2)).toUpperCase() || "?";
      const displayEmail = user.email || "";
      sessionStorage.setItem("swft_profile", JSON.stringify({ fullName, initials, email: displayEmail }));
      applyProfile(fullName, initials, displayEmail);
      return;
    }
  }

  if (!firstName) firstName = "User";

  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  const initials = ((firstName[0] || "") + (lastName[0] || "")).toUpperCase() || "?";
  const displayEmail = user.email || "";

  sessionStorage.setItem("swft_profile", JSON.stringify({ fullName, initials, email: displayEmail }));
  applyProfile(fullName, initials, displayEmail);
  setupDemoCleanup(user.uid);
});
