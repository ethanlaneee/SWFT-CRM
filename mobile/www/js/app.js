// ════════════════════════════════════════════════
// SWFT Mobile — Main App Controller & Router
// ════════════════════════════════════════════════

import { initFirebase, onAuthChange, signOut } from './auth.js';
import { API } from './api.js';
import { initNativePlugins } from './native.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderCustomers, renderCustomerDetail, renderCustomerForm } from './pages/customers.js';
import { renderJobs, renderJobDetail, renderJobForm } from './pages/jobs.js';
import { renderMessages, renderConversation } from './pages/messages.js';
import { renderMore } from './pages/more.js';
import { renderInvoices, renderInvoiceDetail } from './pages/invoices.js';
import { renderQuotes, renderQuoteDetail } from './pages/quotes.js';
import { renderSchedule } from './pages/schedule.js';
import { renderSettings } from './pages/settings.js';
import { renderLogin } from './pages/login.js';

// ── SVG Icons ──
const ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  customers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
  jobs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>',
  messages: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  invoice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  quote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
  team: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 014 4v2h2a2 2 0 012 2v8a4 4 0 01-4 4H8a4 4 0 01-4-4v-8a2 2 0 012-2h2V6a4 4 0 014-4z"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/></svg>',
};

// ── App State ──
const App = {
  currentPage: null,
  history: [],
  user: null,
  userData: null,
  icons: ICONS,

  // Navigate to a page
  navigate(page, params = {}) {
    if (this.currentPage && this.currentPage !== page) {
      this.history.push({ page: this.currentPage, params: this._currentParams || {} });
    }
    this._currentParams = params;
    this.currentPage = page;
    this.render(page, params);
  },

  // Go back
  back() {
    const prev = this.history.pop();
    if (prev) {
      this._currentParams = prev.params;
      this.currentPage = prev.page;
      this.render(prev.page, prev.params);
    }
  },

  // Render a page
  render(page, params = {}) {
    const content = document.getElementById('page-content');
    const tabBar = document.getElementById('tab-bar');
    const header = document.getElementById('header-bar');

    // Determine which pages show tabs vs. are detail/form views
    const tabPages = ['dashboard', 'customers', 'jobs', 'messages', 'more'];
    const noTabPages = ['login', 'customer-detail', 'customer-form', 'job-detail', 'job-form',
                        'conversation', 'invoice-detail', 'quote-detail', 'invoices', 'quotes',
                        'schedule', 'settings'];

    if (page === 'login') {
      tabBar.style.display = 'none';
      header.style.display = 'none';
    } else {
      tabBar.style.display = noTabPages.includes(page) ? 'none' : 'flex';
      header.style.display = 'flex';
    }

    // Update tab bar active state
    document.querySelectorAll('.tab-item').forEach(t => {
      t.classList.toggle('active', t.dataset.page === page);
    });

    // Route to page renderer
    switch (page) {
      case 'login':
        renderLogin(content, header);
        break;
      case 'dashboard':
        this.setHeader('Dashboard');
        renderDashboard(content);
        break;
      case 'customers':
        this.setHeader('Customers', { action: 'add-customer' });
        renderCustomers(content);
        break;
      case 'customer-detail':
        this.setHeaderBack('Customer');
        renderCustomerDetail(content, params.id);
        break;
      case 'customer-form':
        this.setHeaderBack(params.id ? 'Edit Customer' : 'New Customer');
        renderCustomerForm(content, params.id);
        break;
      case 'jobs':
        this.setHeader('Jobs', { action: 'add-job' });
        renderJobs(content);
        break;
      case 'job-detail':
        this.setHeaderBack('Job');
        renderJobDetail(content, params.id);
        break;
      case 'job-form':
        this.setHeaderBack(params.id ? 'Edit Job' : 'New Job');
        renderJobForm(content, params.id);
        break;
      case 'messages':
        this.setHeader('Messages');
        renderMessages(content);
        break;
      case 'conversation':
        this.setHeaderBack(params.name || 'Chat');
        renderConversation(content, params.id, params.phone);
        break;
      case 'invoices':
        this.setHeaderBack('Invoices');
        renderInvoices(content);
        break;
      case 'invoice-detail':
        this.setHeaderBack('Invoice');
        renderInvoiceDetail(content, params.id);
        break;
      case 'quotes':
        this.setHeaderBack('Quotes');
        renderQuotes(content);
        break;
      case 'quote-detail':
        this.setHeaderBack('Quote');
        renderQuoteDetail(content, params.id);
        break;
      case 'schedule':
        this.setHeaderBack('Schedule');
        renderSchedule(content);
        break;
      case 'settings':
        this.setHeaderBack('Settings');
        renderSettings(content);
        break;
      case 'more':
        this.setHeader('More');
        renderMore(content);
        break;
      default:
        this.setHeader('Dashboard');
        renderDashboard(content);
    }

    // Scroll to top
    content.scrollTop = 0;
  },

  // Set standard header
  setHeader(title, opts = {}) {
    const header = document.getElementById('header-bar');
    let actionsHtml = '';
    if (opts.action === 'add-customer' || opts.action === 'add-job') {
      actionsHtml = `
        <button class="header-icon-btn" id="header-add-btn">
          ${ICONS.plus}
        </button>`;
    }
    actionsHtml += `
      <button class="header-icon-btn" id="header-bell-btn">
        ${ICONS.bell}
        <span class="badge-dot" id="notif-dot" style="display:none"></span>
      </button>`;

    header.innerHTML = `
      <span class="header-title">SW<em>F</em>T</span>
      <div class="header-actions">${actionsHtml}</div>`;

    // Wire up add button
    const addBtn = document.getElementById('header-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        if (opts.action === 'add-customer') App.navigate('customer-form');
        if (opts.action === 'add-job') App.navigate('job-form');
      });
    }
  },

  // Set back-button header
  setHeaderBack(title) {
    const header = document.getElementById('header-bar');
    header.innerHTML = `
      <button class="header-back" id="header-back-btn">
        ${ICONS.back} Back
      </button>
      <span class="header-title">${title}</span>
      <div class="header-actions"></div>`;
    document.getElementById('header-back-btn').addEventListener('click', () => App.back());
  },

  // Show toast
  toast(msg) {
    let el = document.getElementById('app-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'app-toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2500);
  },

  // Format currency
  money(val) {
    const n = parseFloat(val) || 0;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  // Format date
  date(val) {
    if (!val) return '—';
    const d = val.seconds ? new Date(val.seconds * 1000) : new Date(val);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  },

  // Short date
  shortDate(val) {
    if (!val) return '';
    const d = val.seconds ? new Date(val.seconds * 1000) : new Date(val);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  },

  // Time ago
  timeAgo(val) {
    if (!val) return '';
    const d = val.seconds ? new Date(val.seconds * 1000) : new Date(val);
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  },

  // Initials from name
  initials(name) {
    if (!name) return '?';
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  },

  // Color from string (for avatars)
  avatarColor(name) {
    const colors = ['#c8f135', '#4d9fff', '#f5a623', '#ff5252', '#a78bfa', '#34d399', '#f472b6', '#60a5fa'];
    let hash = 0;
    for (let i = 0; i < (name || '').length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  },

  // Status tag HTML
  statusTag(status) {
    const map = {
      active: 'tag-active', scheduled: 'tag-scheduled', pending: 'tag-pending',
      complete: 'tag-complete', completed: 'tag-complete', paid: 'tag-paid',
      sent: 'tag-sent', draft: 'tag-draft', overdue: 'tag-overdue',
      approved: 'tag-active', declined: 'tag-overdue',
    };
    const cls = map[(status || '').toLowerCase()] || 'tag-pending';
    return `<span class="tag ${cls}">${(status || 'Unknown').toUpperCase()}</span>`;
  },
};

// Make App globally accessible
window.App = App;

// ── Initialize ──
async function init() {
  await initFirebase();

  onAuthChange((user) => {
    App.user = user;
    if (user) {
      // Fetch user profile
      API.user.me().then(data => {
        App.userData = data;
      }).catch(() => {});
      App.navigate('dashboard');
    } else {
      App.navigate('login');
    }
  });
}

// ── DOM Ready ──
document.addEventListener('DOMContentLoaded', () => {
  // Wire up tab bar
  document.querySelectorAll('.tab-item').forEach(tab => {
    tab.addEventListener('click', () => {
      const page = tab.dataset.page;
      App.history = []; // Reset history on tab switch
      App.navigate(page);
    });
  });

  // Initialize native plugins (Capacitor)
  initNativePlugins();

  init();
});

export { App, ICONS };
