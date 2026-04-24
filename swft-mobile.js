/* SWFT Mobile — bottom navigation, hamburger menu, sidebar overlay
   Only activates on pages that contain a .sidebar element (app pages).
   Safe to include on all pages — exits early on non-app pages. */
(function () {
  'use strict';

  var PAGE = (window.location.pathname.split('/').pop() || 'swft-dashboard').replace('.html', '');

  /* ── Bottom nav items (5 visible at a time) ── */
  var BOTTOM_ITEMS = [
    {
      id: 'swft-dashboard',
      label: 'Home',
      href: 'swft-dashboard',
      svg: svgWrap('<rect x="3" y="3" width="7" height="7" rx="1.5" stroke-width="1.8"/><rect x="14" y="3" width="7" height="7" rx="1.5" stroke-width="1.8"/><rect x="3" y="14" width="7" height="7" rx="1.5" stroke-width="1.8"/><rect x="14" y="14" width="7" height="7" rx="1.5" stroke-width="1.8"/>')
    },
    {
      id: 'swft-jobs',
      label: 'Jobs',
      href: 'swft-jobs',
      svg: svgWrap('<path d="M9 11l3 3L22 4" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" stroke-linecap="round"/>')
    },
    {
      id: 'swft-messages',
      label: 'Messages',
      href: 'swft-messages',
      badge: true,
      svg: svgWrap('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>')
    },
    {
      id: 'swft-schedule',
      label: 'Schedule',
      href: 'swft-schedule',
      svg: svgWrap('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>')
    },
    {
      id: 'more',
      label: 'More',
      href: null,
      /* 3×3 dots grid icon */
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="none" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="1.7" fill="currentColor"/><circle cx="12" cy="5" r="1.7" fill="currentColor"/><circle cx="19" cy="5" r="1.7" fill="currentColor"/><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/><circle cx="5" cy="19" r="1.7" fill="currentColor"/><circle cx="12" cy="19" r="1.7" fill="currentColor"/><circle cx="19" cy="19" r="1.7" fill="currentColor"/></svg>'
    }
  ];

  /* ── More sheet sections ── */
  var MORE_SECTIONS = [
    {
      label: 'CRM',
      items: [
        { id: 'swft-customers', label: 'Customers', svg: svgWrap('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>') },
        { id: 'swft-quotes',    label: 'Quotes',    svg: svgWrap('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>') },
        { id: 'swft-invoices',  label: 'Invoices',  svg: svgWrap('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="12" y1="18" x2="12" y2="12"/><path d="M15 15H9.5"/>') },
        { id: 'swft-reviews',   label: 'Reviews',   svg: svgWrap('<polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/>') }
      ]
    },
    {
      label: 'Tools',
      items: [
        { id: 'swft-broadcasts', label: 'Broadcasts',   svg: svgWrap('<path d="M22 2L11 13" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 2L15 22l-4-9-9-4 20-7z" stroke-linejoin="round"/>') },
        { id: 'swft-ai-agents',  label: 'Automations', svg: svgWrap('<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke-linejoin="round" stroke-linecap="round"/>') },
        { id: 'swft-phone',      label: 'Phone AI',    svg: svgWrap('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.13 12.5 19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>') },
        { id: 'swft-connect',    label: 'Connect',     svg: svgWrap('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke-linecap="round" stroke-linejoin="round"/>') }
      ]
    },
    {
      label: 'Admin',
      items: [
        { id: 'swft-team',         label: 'Team',     svg: svgWrap('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>') },
        { id: 'swft-team-tracker', label: 'Tracker',  svg: svgWrap('<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>') },
        { id: 'swft-team-chat',    label: 'Chat',     svg: svgWrap('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>') },
        { id: 'swft-billing',      label: 'Billing',  svg: svgWrap('<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>') },
        { id: 'swft-settings',     label: 'Settings', svg: svgWrap('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>') }
      ]
    }
  ];

  /* ── Helper ── */
  function svgWrap(inner) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' + inner + '</svg>';
  }

  function isActive(id) {
    return PAGE === id || PAGE === id.replace('swft-', '');
  }

  /* ── Init ── */
  function init() {
    if (!document.querySelector('.sidebar')) return; // not an app page
    injectTopbarLogo();
    injectBottomNav();
    injectSidebarOverlay();
    injectMoreSheet();
    fixInputsAboveKeyboard();
    if (PAGE === 'swft-messages') setupMobileMessages();
  }

  /* ── Topbar logo (replaces page name on mobile) ── */
  function injectTopbarLogo() {
    var topbar = document.querySelector('.topbar');
    if (!topbar) return;
    var logo = document.createElement('span');
    logo.className = 'mob-topbar-logo';
    logo.innerHTML = 'SWFT<em>.</em>';
    topbar.insertBefore(logo, topbar.firstChild);
  }

  /* ── Bottom nav ── */
  function injectBottomNav() {
    var nav = document.createElement('nav');
    nav.className = 'mob-bottom-nav';
    nav.id = 'mob-bottom-nav';
    nav.setAttribute('aria-label', 'Mobile navigation');

    BOTTOM_ITEMS.forEach(function (item) {
      var el = document.createElement('div');
      el.className = 'mob-nav-item' + (isActive(item.id) ? ' active' : '');
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', item.label);
      el.innerHTML = item.svg + '<span>' + item.label + '</span>';

      if (item.badge) {
        var badge = document.createElement('div');
        badge.className = 'mob-nav-badge';
        badge.id = 'mob-badge-' + item.id;
        badge.style.display = 'none';
        el.appendChild(badge);
      }

      if (item.href) {
        el.onclick = (function (href) {
          return function () { window.location.href = href; };
        })(item.href);
      } else {
        el.onclick = toggleMoreSheet;
      }

      nav.appendChild(el);
    });

    document.body.appendChild(nav);
  }

  /* ── Sidebar overlay backdrop ── */
  function injectSidebarOverlay() {
    var overlay = document.createElement('div');
    overlay.className = 'mob-sidebar-overlay';
    overlay.id = 'mob-sidebar-overlay';
    overlay.onclick = closeMobileSidebar;
    document.body.appendChild(overlay);
  }

  /* ── More sheet ── */
  function injectMoreSheet() {
    var overlay = document.createElement('div');
    overlay.className = 'mob-more-overlay';
    overlay.id = 'mob-more-overlay';
    overlay.onclick = closeMoreSheet;
    document.body.appendChild(overlay);

    var sheet = document.createElement('div');
    sheet.className = 'mob-more-sheet';
    sheet.id = 'mob-more-sheet';

    var handle = document.createElement('div');
    handle.className = 'mob-more-handle';
    sheet.appendChild(handle);

    MORE_SECTIONS.forEach(function (section) {
      var labelEl = document.createElement('span');
      labelEl.className = 'mob-more-section-label';
      labelEl.textContent = section.label;
      sheet.appendChild(labelEl);

      var grid = document.createElement('div');
      grid.className = 'mob-more-grid';

      section.items.forEach(function (item) {
        var el = document.createElement('div');
        el.className = 'mob-more-item' + (isActive(item.id) ? ' active' : '');
        el.innerHTML = item.svg + '<span>' + item.label + '</span>';
        el.onclick = (function (id) {
          return function () { closeMoreSheet(); window.location.href = id; };
        })(item.id);
        grid.appendChild(el);
      });

      sheet.appendChild(grid);
    });

    document.body.appendChild(sheet);
  }

  /* ── Sidebar toggle ── */
  function toggleMobileSidebar() {
    var sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    if (sidebar.classList.contains('mobile-open')) {
      closeMobileSidebar();
    } else {
      var overlay = document.getElementById('mob-sidebar-overlay');
      sidebar.classList.add('mobile-open');
      if (overlay) overlay.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
  }

  function closeMobileSidebar() {
    var sidebar = document.getElementById('sidebar');
    var overlay = document.getElementById('mob-sidebar-overlay');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (overlay) overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  /* ── More sheet toggle ── */
  function toggleMoreSheet() {
    var sheet = document.getElementById('mob-more-sheet');
    if (!sheet) return;
    if (sheet.classList.contains('open')) {
      closeMoreSheet();
    } else {
      var overlay = document.getElementById('mob-more-overlay');
      if (overlay) overlay.classList.add('open');
      sheet.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
  }

  function closeMoreSheet() {
    var overlay = document.getElementById('mob-more-overlay');
    var sheet = document.getElementById('mob-more-sheet');
    if (overlay) overlay.classList.remove('open');
    if (sheet) sheet.classList.remove('open');
    document.body.style.overflow = '';
  }

  /* ── Messages page: iMessage-style full-screen threads ── */
  function setupMobileMessages() {
    if (window.innerWidth > 768) return;

    // Inject back button into chat header
    var chatHeader = document.getElementById('chat-header');
    if (chatHeader) {
      var backBtn = document.createElement('button');
      backBtn.className = 'mob-chat-back';
      backBtn.setAttribute('aria-label', 'Back to conversations');
      backBtn.innerHTML = '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15,18 9,12 15,6"/></svg><span>Back</span>';
      backBtn.onclick = function () { document.body.classList.remove('mob-chat-open'); };
      chatHeader.insertBefore(backBtn, chatHeader.firstChild);

      // Watch for chat header becoming visible (conversation selected)
      var observer = new MutationObserver(function () {
        var style = chatHeader.getAttribute('style') || '';
        if (!style.includes('display: none') && !style.includes('display:none')) {
          document.body.classList.add('mob-chat-open');
        }
      });
      observer.observe(chatHeader, { attributes: true, attributeFilter: ['style'] });
    }

    // Also catch contact-item clicks directly
    var contactList = document.getElementById('contact-list');
    if (contactList) {
      contactList.addEventListener('click', function (e) {
        if (e.target.closest('.contact-item')) {
          setTimeout(function () { document.body.classList.add('mob-chat-open'); }, 60);
        }
      });
    }
  }

  /* ── Scroll input into view above keyboard on focus ── */
  function fixInputsAboveKeyboard() {
    document.addEventListener('focusin', function (e) {
      var el = e.target;
      if (!el.matches('input:not([type="checkbox"]):not([type="radio"]), textarea')) return;
      setTimeout(function () {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 350); // wait for iOS keyboard to fully appear
    }, true);
  }

  /* ── Keyboard: close overlays on Escape ── */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeMobileSidebar();
      closeMoreSheet();
    }
  });

  /* ── Run on DOM ready ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
