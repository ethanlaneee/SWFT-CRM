// ════════════════════════════════════════════════
// SWFT Mobile — Firebase Auth Module
// ════════════════════════════════════════════════

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDVWn5yEQiMBjCPMa-tROGiyburR-2MqEU",
  authDomain: "swft-ai26.firebaseapp.com",
  projectId: "swft-ai26",
  storageBucket: "swft-ai26.firebasestorage.app",
  messagingSenderId: "362381219498",
  appId: "1:362381219498:web:YOUR_APP_ID",
};

let _authInitialized = false;

async function initFirebase() {
  if (_authInitialized) return;
  const { initializeApp, getApps } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js");
  if (getApps().length === 0) {
    initializeApp(FIREBASE_CONFIG);
  }
  _authInitialized = true;
}

async function getAuthInstance() {
  await initFirebase();
  const { getAuth } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
  return getAuth();
}

async function onAuthChange(callback) {
  const { onAuthStateChanged } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
  const auth = await getAuthInstance();
  return onAuthStateChanged(auth, callback);
}

async function signIn(email, password) {
  const { signInWithEmailAndPassword } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
  const auth = await getAuthInstance();
  return signInWithEmailAndPassword(auth, email, password);
}

async function signUp(email, password) {
  const { createUserWithEmailAndPassword } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
  const auth = await getAuthInstance();
  return createUserWithEmailAndPassword(auth, email, password);
}

async function signOut() {
  const auth = await getAuthInstance();
  return auth.signOut();
}

async function resetPassword(email) {
  const { sendPasswordResetEmail } = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js");
  const auth = await getAuthInstance();
  return sendPasswordResetEmail(auth, email);
}

async function getCurrentUser() {
  const auth = await getAuthInstance();
  return auth.currentUser;
}

export { initFirebase, getAuthInstance, onAuthChange, signIn, signUp, signOut, resetPassword, getCurrentUser };
