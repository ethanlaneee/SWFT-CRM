// ════════════════════════════════════════════════
// SWFT Mobile — Login Page
// ════════════════════════════════════════════════

import { signIn, signUp, resetPassword } from '../auth.js';

export function renderLogin(container, header) {
  container.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-card-header">
          <div class="login-logo">SW<em>F</em>T</div>
          <div class="login-tagline">Smart Workflow Technology</div>
        </div>

        <div class="login-card-body">
          <div class="login-error" id="login-error"></div>

          <div class="form-group">
            <label class="form-label">Email</label>
            <input class="form-input" id="login-email" type="email" placeholder="you@example.com" autocomplete="email" autocapitalize="none"/>
          </div>

          <div class="form-group">
            <label class="form-label">Password</label>
            <input class="form-input" id="login-pass" type="password" placeholder="Your password" autocomplete="current-password"/>
          </div>

          <button class="btn-primary" id="login-btn" style="margin-top: 8px;">Sign In</button>

          <button class="btn-secondary" id="signup-btn" style="margin-top: 12px;">Create Account</button>
        </div>

        <div class="login-footer">
          <a href="#" id="forgot-link">Forgot your password?</a>
        </div>
      </div>
    </div>`;

  const emailEl = document.getElementById('login-email');
  const passEl = document.getElementById('login-pass');
  const errorEl = document.getElementById('login-error');
  const loginBtn = document.getElementById('login-btn');
  const signupBtn = document.getElementById('signup-btn');
  const forgotLink = document.getElementById('forgot-link');

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.add('show');
  }

  function clearError() {
    errorEl.classList.remove('show');
  }

  loginBtn.addEventListener('click', async () => {
    clearError();
    const email = emailEl.value.trim();
    const pass = passEl.value;
    if (!email || !pass) { showError('Please enter email and password'); return; }

    loginBtn.textContent = 'Signing in...';
    loginBtn.disabled = true;
    try {
      await signIn(email, pass);
      // Auth state listener in app.js will handle navigation
    } catch (e) {
      let msg = 'Sign in failed';
      if (e.code === 'auth/user-not-found' || e.code === 'auth/wrong-password') msg = 'Invalid email or password';
      if (e.code === 'auth/invalid-email') msg = 'Invalid email address';
      if (e.code === 'auth/too-many-requests') msg = 'Too many attempts. Try again later.';
      if (e.code === 'auth/invalid-credential') msg = 'Invalid email or password';
      showError(msg);
      loginBtn.textContent = 'Sign In';
      loginBtn.disabled = false;
    }
  });

  signupBtn.addEventListener('click', async () => {
    clearError();
    const email = emailEl.value.trim();
    const pass = passEl.value;
    if (!email || !pass) { showError('Please enter email and password'); return; }
    if (pass.length < 6) { showError('Password must be at least 6 characters'); return; }

    signupBtn.textContent = 'Creating account...';
    signupBtn.disabled = true;
    try {
      await signUp(email, pass);
    } catch (e) {
      let msg = 'Could not create account';
      if (e.code === 'auth/email-already-in-use') msg = 'An account with this email already exists';
      if (e.code === 'auth/weak-password') msg = 'Password is too weak';
      showError(msg);
      signupBtn.textContent = 'Create Account';
      signupBtn.disabled = false;
    }
  });

  forgotLink.addEventListener('click', async (e) => {
    e.preventDefault();
    clearError();
    const email = emailEl.value.trim();
    if (!email) { showError('Enter your email first'); return; }
    try {
      await resetPassword(email);
      App.toast('Password reset email sent');
    } catch (err) {
      showError('Could not send reset email');
    }
  });

  // Enter key submits
  passEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loginBtn.click();
  });
}
