// ════════════════════════════════════════════════
// SWFT Mobile — More Menu Page
// ════════════════════════════════════════════════

import { signOut } from '../auth.js';
import { clearTokenCache } from '../api.js';

export function renderMore(container) {
  const user = window.App.userData || {};
  const initials = App.initials(user.name);

  container.innerHTML = `
    <div class="more-menu anim-fade-up">
      <div class="user-card" onclick="App.navigate('settings')">
        <div class="user-card-avatar">${initials}</div>
        <div class="user-card-info">
          <div class="user-card-name">${user.name || 'User'}</div>
          <div class="user-card-email">${user.email || ''}</div>
        </div>
        <div class="more-chevron">${App.icons.chevron}</div>
      </div>

      <div class="more-group">
        <div class="more-group-title">Business</div>
        <div class="more-item" onclick="App.navigate('invoices')">
          <div class="more-icon green">${App.icons.invoice}</div>
          <span class="more-label">Invoices</span>
          <div class="more-chevron">${App.icons.chevron}</div>
        </div>
        <div class="more-item" onclick="App.navigate('quotes')">
          <div class="more-icon blue">${App.icons.quote}</div>
          <span class="more-label">Quotes</span>
          <div class="more-chevron">${App.icons.chevron}</div>
        </div>
        <div class="more-item" onclick="App.navigate('schedule')">
          <div class="more-icon amber">${App.icons.calendar}</div>
          <span class="more-label">Schedule</span>
          <div class="more-chevron">${App.icons.chevron}</div>
        </div>
      </div>

      <div class="more-group">
        <div class="more-group-title">Account</div>
        <div class="more-item" onclick="App.navigate('settings')">
          <div class="more-icon gray">${App.icons.settings}</div>
          <span class="more-label">Settings</span>
          <div class="more-chevron">${App.icons.chevron}</div>
        </div>
      </div>

      <div class="more-group">
        <div class="more-item" id="logout-btn">
          <div class="more-icon red">${App.icons.logout}</div>
          <span class="more-label" style="color: var(--red);">Sign Out</span>
        </div>
      </div>

      <div style="text-align: center; padding: 24px; color: var(--gray2); font-size: 12px;">
        SWFT CRM &middot; v1.0.0
      </div>
    </div>`;

  document.getElementById('logout-btn').addEventListener('click', async () => {
    if (confirm('Sign out of SWFT?')) {
      clearTokenCache();
      await signOut();
      App.navigate('login');
    }
  });
}
