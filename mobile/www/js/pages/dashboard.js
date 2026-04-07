// ════════════════════════════════════════════════
// SWFT Mobile — Dashboard Page
// ════════════════════════════════════════════════

import { API } from '../api.js';

export async function renderDashboard(container) {
  container.innerHTML = `
    <div class="anim-fade-up">
      <div style="padding: 20px 20px 8px;">
        <h2 style="font-family: 'Bebas Neue', sans-serif; font-size: 26px; letter-spacing: 2px; color: var(--white);">
          Good ${getGreeting()}, <em style="color: var(--green); font-style: normal;" id="dash-name">there</em>
        </h2>
        <p style="font-size: 13px; color: var(--gray); margin-top: 4px;">Here's what's happening today</p>
      </div>

      <div class="kpi-row" id="kpi-grid">
        <div class="kpi-card c-green"><div class="kpi-label">Active Jobs</div><div class="kpi-value">—</div></div>
        <div class="kpi-card c-blue"><div class="kpi-label">Customers</div><div class="kpi-value">—</div></div>
        <div class="kpi-card c-amber"><div class="kpi-label">Pending</div><div class="kpi-value">—</div></div>
        <div class="kpi-card c-green"><div class="kpi-label">Revenue</div><div class="kpi-value">—</div></div>
      </div>

      <div class="section-header">
        <span class="section-title">TODAY'S SCHEDULE</span>
        <button class="section-link" onclick="App.navigate('schedule')">See All</button>
      </div>
      <div class="list-card" id="dash-schedule">
        <div class="spinner"></div>
      </div>

      <div class="section-header">
        <span class="section-title">RECENT JOBS</span>
        <button class="section-link" onclick="App.navigate('jobs')">See All</button>
      </div>
      <div class="list-card" id="dash-jobs">
        <div class="spinner"></div>
      </div>
    </div>`;

  // Set user name
  if (window.App.userData) {
    const el = document.getElementById('dash-name');
    if (el) el.textContent = (window.App.userData.name || '').split(' ')[0] || 'there';
  }

  // Load data
  try {
    const stats = await API.dashboard.stats();
    const grid = document.getElementById('kpi-grid');
    if (grid) {
      const cards = grid.querySelectorAll('.kpi-card');
      cards[0].querySelector('.kpi-value').textContent = stats.activeJobs ?? 0;
      cards[1].querySelector('.kpi-value').textContent = stats.totalCustomers ?? 0;
      cards[2].querySelector('.kpi-value').textContent = stats.pendingInvoices ?? 0;
      cards[3].querySelector('.kpi-value').textContent = window.App.money(stats.monthRevenue ?? 0);
    }
  } catch (e) {
    console.error('Dashboard stats error:', e);
  }

  // Load schedule
  try {
    const schedule = await API.schedule.list();
    const container = document.getElementById('dash-schedule');
    if (!container) return;
    const today = new Date().toDateString();
    const todayItems = (schedule.events || schedule || []).filter(s => {
      const d = s.scheduledAt?.seconds ? new Date(s.scheduledAt.seconds * 1000) : new Date(s.scheduledAt || s.date);
      return d.toDateString() === today;
    }).slice(0, 4);

    if (todayItems.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding: 30px;">
          <p style="color: var(--gray2);">No events scheduled for today</p>
        </div>`;
    } else {
      container.innerHTML = todayItems.map(s => {
        const d = s.scheduledAt?.seconds ? new Date(s.scheduledAt.seconds * 1000) : new Date(s.scheduledAt || s.date);
        const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return `
          <div class="schedule-item">
            <span class="schedule-time">${time}</span>
            <div class="schedule-body">
              <div class="schedule-title">${s.title || s.service || 'Event'}</div>
              <div class="schedule-meta">${s.customerName || s.address || ''}</div>
            </div>
          </div>`;
      }).join('');
    }
  } catch (e) {
    const el = document.getElementById('dash-schedule');
    if (el) el.innerHTML = '<div class="empty-state" style="padding: 30px;"><p style="color: var(--gray2);">No events today</p></div>';
  }

  // Load recent jobs
  try {
    const jobs = await API.jobs.list();
    const container = document.getElementById('dash-jobs');
    if (!container) return;
    const items = (jobs.jobs || jobs || []).slice(0, 5);
    if (items.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding: 30px;"><p style="color: var(--gray2);">No jobs yet</p></div>';
    } else {
      container.innerHTML = items.map(j => `
        <div class="list-item" onclick="App.navigate('job-detail', { id: '${j.id}' })">
          <div class="status-dot dot-${j.status === 'active' ? 'green' : j.status === 'scheduled' ? 'blue' : j.status === 'pending' ? 'amber' : 'gray'}"></div>
          <div class="list-info">
            <div class="list-name">${j.title || j.service || 'Untitled Job'}</div>
            <div class="list-sub">${j.customerName || ''}</div>
          </div>
          <div class="list-right">
            ${j.rate ? `<span class="list-amount">${App.money(j.rate)}</span>` : ''}
            ${App.statusTag(j.status)}
          </div>
        </div>`).join('');
    }
  } catch (e) {
    const el = document.getElementById('dash-jobs');
    if (el) el.innerHTML = '<div class="empty-state" style="padding: 30px;"><p style="color: var(--gray2);">No jobs yet</p></div>';
  }
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}
