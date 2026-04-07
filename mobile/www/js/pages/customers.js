// ════════════════════════════════════════════════
// SWFT Mobile — Customers Page
// ════════════════════════════════════════════════

import { API } from '../api.js';

let _customersCache = [];

export async function renderCustomers(container) {
  container.innerHTML = `
    <div class="search-bar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input type="text" placeholder="Search customers..." id="cust-search"/>
    </div>
    <div id="cust-list"><div class="spinner"></div></div>
    <button class="fab" onclick="App.navigate('customer-form')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`;

  const searchInput = document.getElementById('cust-search');
  searchInput.addEventListener('input', () => filterCustomers(searchInput.value));

  try {
    const data = await API.customers.list();
    _customersCache = data.customers || data || [];
    renderCustomerList(_customersCache);
  } catch (e) {
    document.getElementById('cust-list').innerHTML = '<div class="empty-state"><p>Could not load customers</p></div>';
  }
}

function filterCustomers(query) {
  const q = query.toLowerCase();
  const filtered = _customersCache.filter(c =>
    (c.name || '').toLowerCase().includes(q) ||
    (c.email || '').toLowerCase().includes(q) ||
    (c.phone || '').includes(q)
  );
  renderCustomerList(filtered);
}

function renderCustomerList(customers) {
  const el = document.getElementById('cust-list');
  if (!el) return;
  if (customers.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        ${App.icons.customers}
        <h3>No Customers</h3>
        <p>Tap + to add your first customer</p>
      </div>`;
    return;
  }
  el.innerHTML = `<div class="list-card">${customers.map((c, i) => `
    <div class="list-item" style="animation-delay: ${i * 0.04}s" onclick="App.navigate('customer-detail', { id: '${c.id}' })">
      <div class="list-avatar" style="background: ${App.avatarColor(c.name)}">${App.initials(c.name)}</div>
      <div class="list-info">
        <div class="list-name">${c.name || 'Unnamed'}</div>
        <div class="list-sub">${c.phone || c.email || 'No contact info'}</div>
      </div>
      <div class="more-chevron">${App.icons.chevron}</div>
    </div>`).join('')}</div>`;
}

export async function renderCustomerDetail(container, id) {
  container.innerHTML = '<div class="spinner"></div>';
  try {
    const c = await API.customers.get(id);

    container.innerHTML = `
      <div class="anim-fade-up">
        <div style="text-align: center; padding: 24px 20px 16px;">
          <div class="list-avatar" style="background: ${App.avatarColor(c.name)}; width: 64px; height: 64px; font-size: 22px; margin: 0 auto 12px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #0a0a0a; font-weight: 700;">
            ${App.initials(c.name)}
          </div>
          <div style="font-size: 20px; font-weight: 600; color: var(--white);">${c.name || 'Unnamed'}</div>
          ${c.tags ? `<div style="margin-top: 6px;">${(c.tags || []).map(t => `<span class="tag tag-active" style="margin: 2px;">${t}</span>`).join('')}</div>` : ''}
        </div>

        <div class="action-row">
          ${c.phone ? `<a href="tel:${c.phone}" class="action-btn">${App.icons.phone} Call</a>` : ''}
          ${c.phone ? `<a href="sms:${c.phone}" class="action-btn">${App.icons.messages} Text</a>` : ''}
          ${c.email ? `<a href="mailto:${c.email}" class="action-btn">${App.icons.mail} Email</a>` : ''}
        </div>

        <div class="detail-section" style="padding-top: 0;">
          <div class="detail-card">
            ${c.phone ? `<div class="detail-row"><span class="detail-label">Phone</span><span class="detail-value">${c.phone}</span></div>` : ''}
            ${c.email ? `<div class="detail-row"><span class="detail-label">Email</span><span class="detail-value">${c.email}</span></div>` : ''}
            ${c.address ? `<div class="detail-row"><span class="detail-label">Address</span><span class="detail-value">${c.address}</span></div>` : ''}
            <div class="detail-row"><span class="detail-label">Added</span><span class="detail-value">${App.date(c.createdAt)}</span></div>
            ${c.notes ? `<div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value">${c.notes}</span></div>` : ''}
          </div>
        </div>

        <div class="detail-actions">
          <button class="btn-primary" onclick="App.navigate('customer-form', { id: '${id}' })">Edit Customer</button>
          <button class="btn-danger" id="del-cust-btn">Delete Customer</button>
        </div>
      </div>`;

    document.getElementById('del-cust-btn').addEventListener('click', async () => {
      if (confirm('Delete this customer? This cannot be undone.')) {
        try {
          await API.customers.delete(id);
          App.toast('Customer deleted');
          App.back();
        } catch (e) { App.toast('Error deleting customer'); }
      }
    });
  } catch (e) {
    container.innerHTML = '<div class="empty-state"><p>Could not load customer</p></div>';
  }
}

export async function renderCustomerForm(container, id) {
  let customer = {};
  if (id) {
    try { customer = await API.customers.get(id); } catch (e) {}
  }

  container.innerHTML = `
    <div class="detail-section anim-fade-up">
      <div class="form-group">
        <label class="form-label">Full Name</label>
        <input class="form-input" id="cf-name" value="${customer.name || ''}" placeholder="John Smith"/>
      </div>
      <div class="form-group">
        <label class="form-label">Phone</label>
        <input class="form-input" id="cf-phone" type="tel" value="${customer.phone || ''}" placeholder="(555) 123-4567"/>
      </div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input class="form-input" id="cf-email" type="email" value="${customer.email || ''}" placeholder="john@example.com"/>
      </div>
      <div class="form-group">
        <label class="form-label">Address</label>
        <input class="form-input" id="cf-address" value="${customer.address || ''}" placeholder="123 Main St, City, State"/>
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <textarea class="form-input" id="cf-notes" placeholder="Any notes about this customer...">${customer.notes || ''}</textarea>
      </div>
      <button class="btn-primary" id="cf-save">
        ${id ? 'Update Customer' : 'Add Customer'}
      </button>
    </div>`;

  document.getElementById('cf-save').addEventListener('click', async () => {
    const data = {
      name: document.getElementById('cf-name').value.trim(),
      phone: document.getElementById('cf-phone').value.trim(),
      email: document.getElementById('cf-email').value.trim(),
      address: document.getElementById('cf-address').value.trim(),
      notes: document.getElementById('cf-notes').value.trim(),
    };
    if (!data.name) { App.toast('Name is required'); return; }
    try {
      if (id) {
        await API.customers.update(id, data);
        App.toast('Customer updated');
      } else {
        await API.customers.create(data);
        App.toast('Customer added');
      }
      App.back();
    } catch (e) { App.toast('Error saving customer'); }
  });
}
