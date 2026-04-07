// ════════════════════════════════════════════════
// SWFT Mobile — Quotes Page
// ════════════════════════════════════════════════

import { API } from '../api.js';

export async function renderQuotes(container) {
  container.innerHTML = `
    <div class="filter-row">
      <button class="filter-chip active" data-filter="">All</button>
      <button class="filter-chip" data-filter="draft">Draft</button>
      <button class="filter-chip" data-filter="sent">Sent</button>
      <button class="filter-chip" data-filter="approved">Approved</button>
      <button class="filter-chip" data-filter="declined">Declined</button>
    </div>
    <div id="quote-list"><div class="spinner"></div></div>`;

  document.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await loadQuotes(btn.dataset.filter);
    });
  });

  await loadQuotes('');
}

async function loadQuotes(filter) {
  const el = document.getElementById('quote-list');
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const data = await API.quotes.list(filter || undefined);
    const quotes = data.quotes || data || [];
    if (quotes.length === 0) {
      el.innerHTML = `
        <div class="empty-state">
          ${App.icons.quote}
          <h3>No Quotes</h3>
          <p>Quotes you create will appear here</p>
        </div>`;
      return;
    }
    el.innerHTML = `<div class="list-card">${quotes.map((q, i) => `
      <div class="list-item" style="animation-delay: ${i * 0.04}s" onclick="App.navigate('quote-detail', { id: '${q.id}' })">
        <div class="list-info">
          <div class="list-name">${q.customerName || 'Quote'} ${q.number ? '#' + q.number : ''}</div>
          <div class="list-sub">${q.service || ''} &middot; ${App.date(q.createdAt)}</div>
        </div>
        <div class="list-right">
          <span class="list-amount">${App.money(q.total)}</span>
          ${App.statusTag(q.status)}
        </div>
      </div>`).join('')}</div>`;
  } catch (e) {
    el.innerHTML = '<div class="empty-state"><p>Could not load quotes</p></div>';
  }
}

export async function renderQuoteDetail(container, id) {
  container.innerHTML = '<div class="spinner"></div>';
  try {
    const q = await API.quotes.get(id);
    container.innerHTML = `
      <div class="anim-fade-up">
        <div style="padding: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h2 style="font-size: 20px; font-weight: 600;">Quote ${q.number ? '#' + q.number : ''}</h2>
            ${App.statusTag(q.status)}
          </div>
        </div>

        <div class="detail-section" style="padding-top: 0;">
          <div class="detail-card">
            ${q.customerName ? `<div class="detail-row"><span class="detail-label">Customer</span><span class="detail-value">${q.customerName}</span></div>` : ''}
            ${q.service ? `<div class="detail-row"><span class="detail-label">Service</span><span class="detail-value">${q.service}</span></div>` : ''}
            <div class="detail-row"><span class="detail-label">Total</span><span class="detail-value" style="font-size: 18px; color: var(--green); font-weight: 700;">${App.money(q.total)}</span></div>
            <div class="detail-row"><span class="detail-label">Created</span><span class="detail-value">${App.date(q.createdAt)}</span></div>
            ${q.notes ? `<div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value">${q.notes}</span></div>` : ''}
          </div>

          ${q.items && q.items.length ? `
          <div class="section-header" style="padding-left: 0;">
            <span class="section-title">LINE ITEMS</span>
          </div>
          <div class="detail-card">
            ${q.items.map(item => `
              <div class="detail-row">
                <span class="detail-label">${item.description || item.name || 'Item'} ${item.quantity ? 'x' + item.quantity : ''}</span>
                <span class="detail-value">${App.money(item.amount || item.total || (item.quantity || 1) * (item.rate || item.price || 0))}</span>
              </div>`).join('')}
          </div>` : ''}
        </div>

        <div class="detail-actions">
          ${q.status === 'draft' ? `<button class="btn-primary" id="send-quote-btn">Send Quote</button>` : ''}
        </div>
      </div>`;

    const sendBtn = document.getElementById('send-quote-btn');
    if (sendBtn) {
      sendBtn.addEventListener('click', async () => {
        try {
          await API.quotes.send(id);
          App.toast('Quote sent');
          renderQuoteDetail(container, id);
        } catch (e) { App.toast('Error sending quote'); }
      });
    }
  } catch (e) {
    container.innerHTML = '<div class="empty-state"><p>Could not load quote</p></div>';
  }
}
