// ════════════════════════════════════════════════
// SWFT Mobile — Settings Page
// ════════════════════════════════════════════════

import { API } from '../api.js';

export async function renderSettings(container) {
  const user = window.App.userData || {};

  container.innerHTML = `
    <div class="detail-section anim-fade-up">
      <div class="form-group">
        <label class="form-label">Business Name</label>
        <input class="form-input" id="set-biz" value="${user.businessName || ''}" placeholder="Your Business Name"/>
      </div>
      <div class="form-group">
        <label class="form-label">Your Name</label>
        <input class="form-input" id="set-name" value="${user.name || ''}" placeholder="Full Name"/>
      </div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input class="form-input" id="set-email" type="email" value="${user.email || ''}" placeholder="you@example.com" disabled style="opacity: 0.5;"/>
      </div>
      <div class="form-group">
        <label class="form-label">Phone</label>
        <input class="form-input" id="set-phone" type="tel" value="${user.phone || ''}" placeholder="(555) 123-4567"/>
      </div>

      <button class="btn-primary" id="set-save" style="margin-top: 8px;">Save Changes</button>
    </div>`;

  document.getElementById('set-save').addEventListener('click', async () => {
    const data = {
      businessName: document.getElementById('set-biz').value.trim(),
      name: document.getElementById('set-name').value.trim(),
      phone: document.getElementById('set-phone').value.trim(),
    };
    try {
      await API.user.update(data);
      window.App.userData = { ...window.App.userData, ...data };
      App.toast('Settings saved');
    } catch (e) { App.toast('Error saving settings'); }
  });
}
