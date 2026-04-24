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
        { id: 'swft-billing',   label: 'Billing',   svg: svgWrap('<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>') },
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
    setupDrawerFabHide();
    setupPhotoLightbox();
    if (PAGE === 'swft-messages') setupMobileMessages();
    if (PAGE === 'swft-team-chat') setupMobileTeamChat();
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
      el.setAttribute('data-nav-id', item.id);
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
      document.body.classList.add('mob-more-open');
      document.body.style.overflow = 'hidden';
    }
  }

  function closeMoreSheet() {
    var overlay = document.getElementById('mob-more-overlay');
    var sheet = document.getElementById('mob-more-sheet');
    if (overlay) overlay.classList.remove('open');
    if (sheet) sheet.classList.remove('open');
    document.body.classList.remove('mob-more-open');
    document.body.style.overflow = '';
  }

  /* ── Messages page: iMessage-style full-screen threads ── */
  function setupMobileMessages() {
    if (window.innerWidth > 768) return;

    // Inject SWFT logo before "CONVERSATIONS" title
    var contactTitle = document.querySelector('.contact-title');
    if (contactTitle && contactTitle.parentNode) {
      var logo = document.createElement('span');
      logo.className = 'mob-topbar-logo';
      logo.innerHTML = 'SWFT<em>.</em>';
      contactTitle.parentNode.insertBefore(logo, contactTitle);
    }

    // Inject "+" new conversation button into thread list header
    var contactHeaderRow = document.querySelector('.contact-header > div');
    if (contactHeaderRow) {
      var newMsgBtn = document.createElement('button');
      newMsgBtn.className = 'mob-new-btn';
      newMsgBtn.setAttribute('aria-label', 'New conversation');
      newMsgBtn.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
      newMsgBtn.onclick = function () { if (typeof openNewConversation === 'function') openNewConversation(); };
      contactHeaderRow.appendChild(newMsgBtn);
    }

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

    // Single-tap: capture phase fires before onclick, opening panel immediately
    document.addEventListener('click', function (e) {
      if (e.target.closest('.contact-item')) {
        document.body.classList.add('mob-chat-open');
      }
    }, true);
  }

  /* ── Team Chat: iMessage-style full-screen layout ── */
  function setupMobileTeamChat() {
    if (window.innerWidth > 768) return;

    // Watch for tc-header becoming visible (chat selected)
    var tcHeader = document.getElementById('tc-header');
    if (tcHeader) {
      var observer = new MutationObserver(function () {
        var style = tcHeader.getAttribute('style') || '';
        if (!style.includes('display: none') && !style.includes('display:none')) {
          document.body.classList.add('mob-tc-open');
        }
      });
      observer.observe(tcHeader, { attributes: true, attributeFilter: ['style'] });
    }

    // Single-tap: capture phase fires before onclick
    document.addEventListener('click', function (e) {
      if (e.target.closest('.chat-list-item, .tc-item')) {
        document.body.classList.add('mob-tc-open');
      }
    }, true);

    // Inject SWFT logo before "TEAM CHAT" title
    var chatListTitle = document.querySelector('.chat-list-title');
    if (chatListTitle && chatListTitle.parentNode) {
      var tcLogo = document.createElement('span');
      tcLogo.className = 'mob-topbar-logo';
      tcLogo.innerHTML = 'SWFT<em>.</em>';
      chatListTitle.parentNode.insertBefore(tcLogo, chatListTitle);
    }

    // Inject "+" new chat button into thread list header
    var chatListHeader = document.querySelector('.chat-list-header');
    if (chatListHeader) {
      var newChatBtn = document.createElement('button');
      newChatBtn.className = 'mob-new-btn';
      newChatBtn.setAttribute('aria-label', 'New chat');
      newChatBtn.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
      newChatBtn.onclick = function () { if (typeof openNewChatModal === 'function') openNewChatModal(); };
      chatListHeader.appendChild(newChatBtn);
    }

    // Replace tc-list-toggle with back arrow matching mob-chat-back style
    var listToggle = document.querySelector('.tc-list-toggle');
    if (listToggle) {
      listToggle.innerHTML = '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15,18 9,12 15,6"/></svg><span>Back</span>';
      listToggle.onclick = function () {
        document.body.classList.remove('mob-tc-open');
      };
    }
  }

  /* ── Hide FAB when drawer/modal overlay is open ── */
  function setupDrawerFabHide() {
    // Watch for any .drawer-overlay gaining class "open"
    function watchOverlay(el) {
      if (!el) return;
      new MutationObserver(function () {
        document.body.classList.toggle('mob-overlay-open', el.classList.contains('open'));
      }).observe(el, { attributes: true, attributeFilter: ['class'] });
    }
    // Some pages use #overlay, others may use .drawer-overlay
    watchOverlay(document.getElementById('overlay'));
    document.querySelectorAll('.drawer-overlay').forEach(watchOverlay);
  }

  /* ── Photo lightbox: tap photo → fullscreen popup instead of new tab ── */
  function setupPhotoLightbox() {
    // Inject lightbox DOM once
    var lb = document.createElement('div');
    lb.id = 'mob-lightbox';
    var lbImg = document.createElement('img');
    lbImg.id = 'mob-lightbox-img';
    lbImg.alt = '';
    lb.appendChild(lbImg);
    lb.addEventListener('click', function () { lb.classList.remove('open'); });
    document.body.appendChild(lb);

    // Intercept clicks on photo images before window.open fires
    document.addEventListener('click', function (e) {
      var img = e.target;
      if (img.tagName !== 'IMG') return;
      if (img.id === 'mob-lightbox-img') return;
      // Target classes that are photo thumbnails / job photos
      var isPhoto = img.classList.contains('sr-photo-thumb') ||
                    img.closest('.photo-grid, .photo-tile, .sr-photos');
      if (!isPhoto) return;
      lbImg.src = img.src;
      lb.classList.add('open');
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }

  /* ── Keyboard handling: keep compose bars above keyboard ── */
  function fixInputsAboveKeyboard() {
    // Scroll non-panel inputs into view on focus (not for dashboard — panel resize handles it)
    document.addEventListener('focusin', function (e) {
      var el = e.target;
      if (!el.matches('input:not([type="checkbox"]):not([type="radio"]), textarea')) return;
      if (el.id === 'dash-chat-input') return; // dashboard: handled by visualViewport resize
      if (el.classList && el.classList.contains('swft-chat-input')) return; // SWFT AI panel: handled below
      setTimeout(function () {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 350);
    }, true);

    // On blur: reset viewport scroll so content isn't stuck shifted after keyboard closes
    // Skip on settings (document scroll — user may have scrolled intentionally)
    document.addEventListener('focusout', function (e) {
      var el = e.target;
      if (!el.matches('input:not([type="checkbox"]):not([type="radio"]), textarea')) return;
      if (document.getElementById('settingsNav')) return;
      if (el.classList && el.classList.contains('swft-chat-input')) return; // panel handles its own scroll
      setTimeout(function () {
        window.scrollTo(0, 0);
        var pb = document.querySelector('.page-body');
        if (pb) pb.scrollTop = 0;
      }, 100);
    }, true);

    // Use visualViewport to shift fixed chat panels above the keyboard on iOS
    if (!window.visualViewport) return;
    function adjustPanels() {
      // iOS with overflow:hidden pans via offsetTop instead of shrinking height,
      // so exclude offsetTop to get true keyboard height
      var kh = Math.max(0, window.innerHeight - window.visualViewport.height);

      // Fixed-position chat panels (Messages + Team Chat): shift bottom up with keyboard
      ['.chat-panel', '.tc-panel'].forEach(function (sel) {
        var el = document.querySelector(sel);
        if (!el) return;
        if (kh > 60) {
          el.style.setProperty('bottom', kh + 'px', 'important');
        } else {
          el.style.removeProperty('bottom');
        }
      });

      // SWFT AI floating panel: shift above keyboard when open
      var swftPanel = document.querySelector('.swft-chat-panel');
      if (swftPanel && swftPanel.classList.contains('visible')) {
        if (kh > 60) {
          var gap = 8;
          swftPanel.style.setProperty('bottom', (kh + gap) + 'px', 'important');
          swftPanel.style.setProperty('max-height', (window.visualViewport.height - gap * 2) + 'px', 'important');
          window.scrollTo(0, 0); // cancel iOS viewport pan so panel stays in view
        } else {
          swftPanel.style.removeProperty('bottom');
          swftPanel.style.removeProperty('max-height');
        }
      }

      // Dashboard AI panel: fixed-position approach (same as SWFT AI panel)
      var dashPanel = document.querySelector('#dash-main-grid > .panel');
      if (dashPanel) {
        var pb = document.querySelector('.page-body');
        var nav = document.querySelector('.mob-bottom-nav');
        if (kh > 60) {
          var topbarH = 54;
          dashPanel.style.setProperty('position', 'fixed', 'important');
          dashPanel.style.setProperty('top', topbarH + 'px', 'important');
          dashPanel.style.setProperty('bottom', kh + 'px', 'important');
          dashPanel.style.setProperty('left', '0', 'important');
          dashPanel.style.setProperty('right', '0', 'important');
          dashPanel.style.setProperty('height', 'auto', 'important');
          dashPanel.style.setProperty('max-height', 'none', 'important');
          dashPanel.style.setProperty('border-radius', '0', 'important');
          dashPanel.style.setProperty('z-index', '50', 'important');
          if (pb) pb.style.setProperty('padding-bottom', '0', 'important');
          if (nav) nav.style.setProperty('display', 'none', 'important');
          window.scrollTo(0, 0);
        } else {
          dashPanel.style.removeProperty('position');
          dashPanel.style.removeProperty('top');
          dashPanel.style.removeProperty('bottom');
          dashPanel.style.removeProperty('left');
          dashPanel.style.removeProperty('right');
          dashPanel.style.removeProperty('height');
          dashPanel.style.removeProperty('max-height');
          dashPanel.style.removeProperty('border-radius');
          dashPanel.style.removeProperty('z-index');
          if (pb) pb.style.removeProperty('padding-bottom');
          if (nav) nav.style.removeProperty('display');
        }
        var msgs = document.querySelector('#dash-chat-messages');
        if (msgs && kh > 60) setTimeout(function () { msgs.scrollTop = msgs.scrollHeight; }, 50);
      }

      // Keep messages scrolled to newest when keyboard opens
      if (kh > 60) {
        ['#chat-messages', '.tc-messages'].forEach(function (sel) {
          var el = document.querySelector(sel);
          if (el) setTimeout(function () { el.scrollTop = el.scrollHeight; }, 50);
        });
      }
    }
    window.visualViewport.addEventListener('resize', adjustPanels);
    window.visualViewport.addEventListener('scroll', adjustPanels);

    // Fallback: trigger adjustPanels on dashboard input focus/blur for reliability
    var dashInput = document.getElementById('dash-chat-input');
    if (dashInput) {
      dashInput.addEventListener('focus', function () {
        setTimeout(adjustPanels, 300);
        setTimeout(adjustPanels, 600);
      });
      dashInput.addEventListener('blur', function () {
        setTimeout(adjustPanels, 100);
        setTimeout(adjustPanels, 300);
      });
    }

    // Delegated handlers for SWFT AI input (created dynamically by swft-chat.js)
    document.addEventListener('focusin', function (e) {
      if (!e.target.classList || !e.target.classList.contains('swft-chat-input')) return;
      window.scrollTo(0, 0); // immediately cancel iOS viewport pan
      setTimeout(adjustPanels, 300);
      setTimeout(adjustPanels, 600);
    });
    document.addEventListener('focusout', function (e) {
      if (!e.target.classList || !e.target.classList.contains('swft-chat-input')) return;
      setTimeout(adjustPanels, 100);
      setTimeout(adjustPanels, 300);
    });
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
