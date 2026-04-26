// ════════════════════════════════════════════════
// SWFT User Sync
// Syncs the sidebar user tile with the logged-in account
// Include via: <script type="module" src="swft-user-sync.js"></script>
// Must be loaded AFTER Firebase is initialized
// ════════════════════════════════════════════════

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js";

const auth = getAuth();
const db = getFirestore();

function applyProfile(fullName, initials, email) {
  document.querySelectorAll(".user-name").forEach((el) => { el.textContent = fullName; });
  document.querySelectorAll(".s-avatar, .avatar").forEach((el) => { el.textContent = initials; });
  document.querySelectorAll(".user-role").forEach((el) => { el.textContent = email || ""; });
}

// Apply cached profile immediately at DOM-ready — before auth resolves
// This ensures the profile appears instantly on all pages, even heavy CRM ones
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

onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  let firstName = "";
  let lastName = "";

  // Prefer Firestore profile — it's what the user updates via /api/me and
  // stays in sync with the name they signed up with. Firebase Auth
  // `displayName` is set once at signup and has no edit UI, so it can drift
  // (e.g. left as a Google OAuth profile name) and shouldn't override the
  // Firestore source of truth.
  //
  // NOTE: never read `data.email` here — the sidebar shows the user's
  // login identity, which is Firebase Auth `user.email`. The Firestore
  // `email` field has historically doubled as the company email and will
  // diverge from the login email as soon as the owner sets a separate
  // Company Profile → Email in Settings.
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists()) {
      const data = snap.data();
      firstName = data.firstName || data.name?.split(" ")[0] || "";
      lastName = data.lastName || data.name?.split(" ").slice(1).join(" ") || "";
    }
  } catch (e) { /* ignore */ }

  // Fall back to Firebase Auth displayName if Firestore had nothing
  if (!firstName && user.displayName) {
    const parts = user.displayName.split(" ");
    firstName = parts[0] || "";
    lastName = parts.slice(1).join(" ") || "";
  }

  // Fallback to email
  if (!firstName && user.email) {
    firstName = user.email.split("@")[0];
  }

  if (!firstName) firstName = "User";

  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  const initials = ((firstName[0] || "") + (lastName[0] || "")).toUpperCase() || "?";
  const displayEmail = user.email || "";

  // Update cache under a simple key (no uid needed for lookup)
  sessionStorage.setItem("swft_profile", JSON.stringify({ fullName, initials, email: displayEmail }));

  applyProfile(fullName, initials, displayEmail);
});
