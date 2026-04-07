// ════════════════════════════════════════════════
// SWFT Mobile — Jobs Page
// ════════════════════════════════════════════════

import { API } from '../api.js';

let _jobsCache = [];
let _activeFilter = '';

export async function renderJobs(container) {
  container.innerHTML = `
    <div class="search-bar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input type="text" placeholder="Search jobs..." id="job-search"/>
    </div>
    <div class="filter-row">
      <button class="filter-chip active" data-filter="">All</button>
      <button class="filter-chip" data-filter="active">Active</button>
      <button class="filter-chip" data-filter="scheduled">Scheduled</button>
      <button class="filter-chip" data-filter="pending">Pending</button>
      <button class="filter-chip" data-filter="complete">Complete</button>
    </div>
    <div id="job-list"><div class="spinner"></div></div>
    <button class="fab" onclick="App.navigate('job-form')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`;

  // Search
  document.getElementById('job-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = _jobsCache.filter(j =>
      (j.title || j.service || '').toLowerCase().includes(q) ||
      (j.customerName || '').toLowerCase().includes(q)
    );
    renderJobList(filtered);
  });

  // Filters
  document.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _activeFilter = btn.dataset.filter;
      loadJobs();
    });
  });

  await loadJobs();
}

async function loadJobs() {
  try {
    const data = await API.jobs.list(_activeFilter || undefined);
    _jobsCache = data.jobs || data || [];
    renderJobList(_jobsCache);
  } catch (e) {
    document.getElementById('job-list').innerHTML = '<div class="empty-state"><p>Could not load jobs</p></div>';
  }
}

function renderJobList(jobs) {
  const el = document.getElementById('job-list');
  if (!el) return;
  if (jobs.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        ${App.icons.jobs}
        <h3>No Jobs</h3>
        <p>Tap + to create your first job</p>
      </div>`;
    return;
  }
  el.innerHTML = `<div class="list-card">${jobs.map((j, i) => `
    <div class="list-item" style="animation-delay: ${i * 0.04}s" onclick="App.navigate('job-detail', { id: '${j.id}' })">
      <div class="status-dot dot-${j.status === 'active' ? 'green' : j.status === 'scheduled' ? 'blue' : j.status === 'pending' ? 'amber' : 'gray'}"></div>
      <div class="list-info">
        <div class="list-name">${j.title || j.service || 'Untitled Job'}</div>
        <div class="list-sub">${j.customerName || ''} ${j.scheduledAt ? '&middot; ' + App.shortDate(j.scheduledAt) : ''}</div>
      </div>
      <div class="list-right">
        ${j.rate ? `<span class="list-amount">${App.money(j.rate)}</span>` : ''}
        ${App.statusTag(j.status)}
      </div>
    </div>`).join('')}</div>`;
}

export async function renderJobDetail(container, id) {
  container.innerHTML = '<div class="spinner"></div>';
  try {
    const j = await API.jobs.get(id);
    container.innerHTML = `
      <div class="anim-fade-up">
        <div style="padding: 20px;">
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
            <div class="status-dot dot-${j.status === 'active' ? 'green' : j.status === 'scheduled' ? 'blue' : j.status === 'pending' ? 'amber' : 'gray'}" style="width: 12px; height: 12px;"></div>
            <h2 style="font-size: 20px; font-weight: 600;">${j.title || j.service || 'Untitled Job'}</h2>
          </div>
          ${App.statusTag(j.status)}
        </div>

        <div class="detail-section" style="padding-top: 0;">
          <div class="detail-card">
            ${j.customerName ? `<div class="detail-row"><span class="detail-label">Customer</span><span class="detail-value">${j.customerName}</span></div>` : ''}
            ${j.service ? `<div class="detail-row"><span class="detail-label">Service</span><span class="detail-value">${j.service}</span></div>` : ''}
            ${j.rate ? `<div class="detail-row"><span class="detail-label">Rate</span><span class="detail-value">${App.money(j.rate)}</span></div>` : ''}
            ${j.scheduledAt ? `<div class="detail-row"><span class="detail-label">Scheduled</span><span class="detail-value">${App.date(j.scheduledAt)}</span></div>` : ''}
            ${j.address ? `<div class="detail-row"><span class="detail-label">Address</span><span class="detail-value">${j.address}</span></div>` : ''}
            <div class="detail-row"><span class="detail-label">Created</span><span class="detail-value">${App.date(j.createdAt)}</span></div>
            ${j.notes ? `<div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value">${j.notes}</span></div>` : ''}
          </div>
        </div>

        <div class="detail-actions">
          ${j.status !== 'complete' && j.status !== 'completed' ? `<button class="btn-primary" id="complete-job-btn">Mark Complete</button>` : ''}
          <button class="btn-secondary" onclick="App.navigate('job-form', { id: '${id}' })">Edit Job</button>
          <button class="btn-danger" id="del-job-btn">Delete Job</button>
        </div>
      </div>`;

    const completeBtn = document.getElementById('complete-job-btn');
    if (completeBtn) {
      completeBtn.addEventListener('click', async () => {
        try {
          await API.jobs.complete(id);
          App.toast('Job marked complete');
          renderJobDetail(container, id);
        } catch (e) { App.toast('Error completing job'); }
      });
    }

    document.getElementById('del-job-btn').addEventListener('click', async () => {
      if (confirm('Delete this job?')) {
        try {
          await API.jobs.delete(id);
          App.toast('Job deleted');
          App.back();
        } catch (e) { App.toast('Error deleting job'); }
      }
    });
  } catch (e) {
    container.innerHTML = '<div class="empty-state"><p>Could not load job</p></div>';
  }
}

export async function renderJobForm(container, id) {
  let job = {};
  if (id) {
    try { job = await API.jobs.get(id); } catch (e) {}
  }

  // Load customers for dropdown
  let customers = [];
  try {
    const data = await API.customers.list();
    customers = data.customers || data || [];
  } catch (e) {}

  container.innerHTML = `
    <div class="detail-section anim-fade-up">
      <div class="form-group">
        <label class="form-label">Job Title</label>
        <input class="form-input" id="jf-title" value="${job.title || ''}" placeholder="e.g. Roof Repair"/>
      </div>
      <div class="form-group">
        <label class="form-label">Customer</label>
        <select class="form-input" id="jf-customer">
          <option value="">Select a customer...</option>
          ${customers.map(c => `<option value="${c.id}" ${c.id === job.customerId ? 'selected' : ''}>${c.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Service Type</label>
        <input class="form-input" id="jf-service" value="${job.service || ''}" placeholder="e.g. Plumbing, Landscaping"/>
      </div>
      <div class="form-group">
        <label class="form-label">Rate / Price</label>
        <input class="form-input" id="jf-rate" type="number" value="${job.rate || ''}" placeholder="0.00"/>
      </div>
      <div class="form-group">
        <label class="form-label">Address</label>
        <input class="form-input" id="jf-address" value="${job.address || ''}" placeholder="Job site address"/>
      </div>
      <div class="form-group">
        <label class="form-label">Status</label>
        <select class="form-input" id="jf-status">
          <option value="pending" ${job.status === 'pending' ? 'selected' : ''}>Pending</option>
          <option value="scheduled" ${job.status === 'scheduled' ? 'selected' : ''}>Scheduled</option>
          <option value="active" ${job.status === 'active' ? 'selected' : ''}>Active</option>
          <option value="complete" ${job.status === 'complete' || job.status === 'completed' ? 'selected' : ''}>Complete</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <textarea class="form-input" id="jf-notes" placeholder="Job notes...">${job.notes || ''}</textarea>
      </div>
      <button class="btn-primary" id="jf-save">${id ? 'Update Job' : 'Create Job'}</button>
    </div>`;

  document.getElementById('jf-save').addEventListener('click', async () => {
    const data = {
      title: document.getElementById('jf-title').value.trim(),
      customerId: document.getElementById('jf-customer').value,
      service: document.getElementById('jf-service').value.trim(),
      rate: parseFloat(document.getElementById('jf-rate').value) || 0,
      address: document.getElementById('jf-address').value.trim(),
      status: document.getElementById('jf-status').value,
      notes: document.getElementById('jf-notes').value.trim(),
    };

    // Get customer name for denormalized field
    if (data.customerId) {
      const cust = customers.find(c => c.id === data.customerId);
      if (cust) data.customerName = cust.name;
    }

    if (!data.title && !data.service) { App.toast('Title or service is required'); return; }

    try {
      if (id) {
        await API.jobs.update(id, data);
        App.toast('Job updated');
      } else {
        await API.jobs.create(data);
        App.toast('Job created');
      }
      App.back();
    } catch (e) { App.toast('Error saving job'); }
  });
}
