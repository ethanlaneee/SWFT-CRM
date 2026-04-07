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

onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  // Apply cached profile immediately (no flicker on page switch)
  const cacheKey = "swft_profile_" + user.uid;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) {
    try {
      const p = JSON.parse(cached);
      applyProfile(p.fullName, p.initials, p.email);
    } catch (e) { /* ignore bad cache */ }
  }

  let firstName = "";
  let lastName = "";

  // Try Firebase Auth displayName first
  if (user.displayName) {
    const parts = user.displayName.split(" ");
    firstName = parts[0] || "";
    lastName = parts.slice(1).join(" ") || "";
  }

  // Then try Firestore profile
  if (!firstName) {
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      if (snap.exists()) {
        const data = snap.data();
        firstName = data.firstName || data.name?.split(" ")[0] || "";
        lastName = data.lastName || data.name?.split(" ").slice(1).join(" ") || "";
      }
    } catch (e) { /* ignore */ }
  }

  // Fallback to email
  if (!firstName && user.email) {
    firstName = user.email.split("@")[0];
  }

  if (!firstName) firstName = "User";

  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  const initials = ((firstName[0] || "") + (lastName[0] || "")).toUpperCase() || "?";

  // Cache for instant display on next page
  sessionStorage.setItem(cacheKey, JSON.stringify({ fullName, initials, email: user.email || "" }));

  applyProfile(fullName, initials, user.email);
});
