// ════════════════════════════════════════════════
// SWFT Mobile — Schedule Page
// ════════════════════════════════════════════════

import { API } from '../api.js';

export async function renderSchedule(container) {
  container.innerHTML = '<div class="spinner"></div>';

  try {
    const data = await API.schedule.list();
    const events = data.events || data || [];

    if (events.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          ${App.icons.calendar}
          <h3>No Events</h3>
          <p>Scheduled jobs and events will appear here</p>
        </div>`;
      return;
    }

    // Group by date
    const grouped = {};
    events.forEach(e => {
      const d = e.scheduledAt?.seconds ? new Date(e.scheduledAt.seconds * 1000) : new Date(e.scheduledAt || e.date);
      const key = d.toDateString();
      if (!grouped[key]) grouped[key] = { date: d, items: [] };
      grouped[key].items.push(e);
    });

    const sortedDays = Object.values(grouped).sort((a, b) => a.date - b.date);
    const today = new Date().toDateString();

    container.innerHTML = `<div class="anim-fade-up">${sortedDays.map(day => {
      const isToday = day.date.toDateString() === today;
      const dateLabel = isToday ? 'Today' : day.date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      return `
        <div class="section-header">
          <span class="section-title">${dateLabel.toUpperCase()}</span>
          ${isToday ? '<span class="tag tag-active">NOW</span>' : ''}
        </div>
        <div class="list-card">
          ${day.items.sort((a, b) => {
            const ta = a.scheduledAt?.seconds || 0;
            const tb = b.scheduledAt?.seconds || 0;
            return ta - tb;
          }).map(e => {
            const d = e.scheduledAt?.seconds ? new Date(e.scheduledAt.seconds * 1000) : new Date(e.scheduledAt || e.date);
            const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
            return `
              <div class="schedule-item" onclick="${e.jobId ? `App.navigate('job-detail', { id: '${e.jobId}' })` : ''}">
                <span class="schedule-time">${time}</span>
                <div class="schedule-body">
                  <div class="schedule-title">${e.title || e.service || 'Event'}</div>
                  <div class="schedule-meta">${e.customerName || ''} ${e.address ? '&middot; ' + e.address : ''}</div>
                </div>
              </div>`;
          }).join('')}
        </div>`;
    }).join('')}</div>`;

  } catch (e) {
    container.innerHTML = '<div class="empty-state"><p>Could not load schedule</p></div>';
  }
}
