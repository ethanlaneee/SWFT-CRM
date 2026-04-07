// ════════════════════════════════════════════════
// SWFT Mobile — Invoices Page
// ════════════════════════════════════════════════

import { API } from '../api.js';

export async function renderInvoices(container) {
  container.innerHTML = `
    <div class="filter-row">
      <button class="filter-chip active" data-filter="">All</button>
      <button class="filter-chip" data-filter="draft">Draft</button>
      <button class="filter-chip" data-filter="sent">Sent</button>
      <button class="filter-chip" data-filter="paid">Paid</button>
      <button class="filter-chip" data-filter="overdue">Overdue</button>
    </div>
    <div id="inv-list"><div class="spinner"></div></div>`;

  let currentFilter = '';

  document.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      await loadInvoices(currentFilter);
    });
  });

  await loadInvoices('');
}

async function loadInvoices(filter) {
  const el = document.getElementById('inv-list');
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const data = await API.invoices.list(filter || undefined);
    const invoices = data.invoices || data || [];
    if (invoices.length === 0) {
      el.innerHTML = `
        <div class="empty-state">
          ${App.icons.invoice}
          <h3>No Invoices</h3>
          <p>Invoices you create will appear here</p>
        </div>`;
      return;
    }
    el.innerHTML = `<div class="list-card">${invoices.map((inv, i) => `
      <div class="list-item" style="animation-delay: ${i * 0.04}s" onclick="App.navigate('invoice-detail', { id: '${inv.id}' })">
        <div class="list-info">
          <div class="list-name">${inv.customerName || 'Invoice'} ${inv.number ? '#' + inv.number : ''}</div>
          <div class="list-sub">${App.date(inv.createdAt)}${inv.dueDate ? ' &middot; Due ' + App.shortDate(inv.dueDate) : ''}</div>
        </div>
        <div class="list-right">
          <span class="list-amount">${App.money(inv.total)}</span>
          ${App.statusTag(inv.status)}
        </div>
      </div>`).join('')}</div>`;
  } catch (e) {
    el.innerHTML = '<div class="empty-state"><p>Could not load invoices</p></div>';
  }
}

export async function renderInvoiceDetail(container, id) {
  container.innerHTML = '<div class="spinner"></div>';
  try {
    const inv = await API.invoices.get(id);
    container.innerHTML = `
      <div class="anim-fade-up">
        <div style="padding: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h2 style="font-size: 20px; font-weight: 600;">Invoice ${inv.number ? '#' + inv.number : ''}</h2>
            ${App.statusTag(inv.status)}
          </div>
        </div>

        <div class="detail-section" style="padding-top: 0;">
          <div class="detail-card">
            ${inv.customerName ? `<div class="detail-row"><span class="detail-label">Customer</span><span class="detail-value">${inv.customerName}</span></div>` : ''}
            <div class="detail-row"><span class="detail-label">Total</span><span class="detail-value" style="font-size: 18px; color: var(--green); font-weight: 700;">${App.money(inv.total)}</span></div>
            ${inv.dueDate ? `<div class="detail-row"><span class="detail-label">Due Date</span><span class="detail-value">${App.date(inv.dueDate)}</span></div>` : ''}
            <div class="detail-row"><span class="detail-label">Created</span><span class="detail-value">${App.date(inv.createdAt)}</span></div>
          </div>

          ${inv.items && inv.items.length ? `
          <div class="section-header" style="padding-left: 0;">
            <span class="section-title">LINE ITEMS</span>
          </div>
          <div class="detail-card">
            ${inv.items.map(item => `
              <div class="detail-row">
                <span class="detail-label">${item.description || item.name || 'Item'} ${item.quantity ? 'x' + item.quantity : ''}</span>
                <span class="detail-value">${App.money(item.amount || item.total || (item.quantity || 1) * (item.rate || item.price || 0))}</span>
              </div>`).join('')}
          </div>` : ''}
        </div>

        <div class="detail-actions">
          ${inv.status === 'draft' ? `<button class="btn-primary" id="send-inv-btn">Send Invoice</button>` : ''}
          ${inv.status !== 'paid' ? `<button class="btn-secondary" id="link-inv-btn">Get Payment Link</button>` : ''}
        </div>
      </div>`;

    const sendBtn = document.getElementById('send-inv-btn');
    if (sendBtn) {
      sendBtn.addEventListener('click', async () => {
        try {
          await API.invoices.send(id);
          App.toast('Invoice sent');
          renderInvoiceDetail(container, id);
        } catch (e) { App.toast('Error sending invoice'); }
      });
    }

    const linkBtn = document.getElementById('link-inv-btn');
    if (linkBtn) {
      linkBtn.addEventListener('click', async () => {
        try {
          const result = await API.payments.invoiceLink(id);
          if (result.url) {
            window.open(result.url, '_blank');
          }
          App.toast('Payment link created');
        } catch (e) { App.toast('Error creating payment link'); }
      });
    }
  } catch (e) {
    container.innerHTML = '<div class="empty-state"><p>Could not load invoice</p></div>';
  }
}
