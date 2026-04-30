// ════════════════════════════════════════════════
// SWFT Setup Wizard
// First-run guided setup: question-by-question, full-screen on mobile.
// Auto-opens on the dashboard when `users/{uid}.setupComplete` isn't true.
// Re-runnable from Settings → Profile → "Run Setup Wizard".
// Each "Continue" PUTs the field to /api/me. Step 1 is mandatory
// (website + autofill or skip-autofill); after that the user can
// "Finish later" at any step.
// ════════════════════════════════════════════════

(function () {
  if (window.__swftSetupWizardLoaded) return;
  window.__swftSetupWizardLoaded = true;

  // ── Styles ──────────────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = `
    .sw-overlay{
      position:fixed;inset:0;background:rgba(0,0,0,0.78);
      z-index:9700;opacity:0;pointer-events:none;
      transition:opacity 0.22s ease;
      display:flex;align-items:center;justify-content:center;
      padding:24px;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
    }
    .sw-overlay.open{opacity:1;pointer-events:all;}
    .sw-card{
      width:100%;max-width:560px;background:#111;border:1px solid #2c2c2c;
      border-radius:18px;padding:36px 36px 28px;
      box-shadow:0 24px 80px rgba(0,0,0,0.6);
      display:flex;flex-direction:column;gap:18px;
      transform:translateY(8px);opacity:0;
      transition:transform 0.28s cubic-bezier(0.22,1,0.36,1),opacity 0.22s ease;
      max-height:calc(100vh - 48px);overflow:hidden;
    }
    .sw-overlay.open .sw-card{transform:translateY(0);opacity:1;}
    .sw-progress-row{display:flex;align-items:center;gap:10px;margin-bottom:4px;}
    .sw-progress-bar{
      flex:1;height:3px;background:#1f1f1f;border-radius:2px;overflow:hidden;
    }
    .sw-progress-fill{
      height:100%;background:#c8f135;border-radius:2px;
      transition:width 0.3s cubic-bezier(0.22,1,0.36,1);
    }
    .sw-progress-text{font-family:'JetBrains Mono',monospace;font-size:10px;color:#444;letter-spacing:1px;}
    .sw-skip-all{
      background:none;border:none;color:#7a7a7a;font-size:11.5px;cursor:pointer;
      font-family:'DM Sans',sans-serif;padding:4px 8px;border-radius:6px;
      transition:color 0.14s,background 0.14s;
    }
    .sw-skip-all:hover{color:#f0f0f0;background:#181818;}
    .sw-step{display:flex;flex-direction:column;gap:12px;min-height:0;flex:1;overflow-y:auto;}
    .sw-step::-webkit-scrollbar{width:4px;}
    .sw-step::-webkit-scrollbar-thumb{background:#2c2c2c;border-radius:2px;}
    .sw-eyebrow{
      font-family:'Bebas Neue',sans-serif;font-size:11px;letter-spacing:2.5px;
      color:#c8f135;text-transform:uppercase;
    }
    .sw-title{
      font-family:'Bebas Neue',sans-serif;font-size:30px;letter-spacing:1.5px;
      color:#f0f0f0;line-height:1.05;margin:0;
    }
    .sw-sub{font-size:13.5px;color:#999;line-height:1.55;margin:0;}
    .sw-input,.sw-textarea{
      width:100%;background:#181818;border:1px solid #2c2c2c;border-radius:10px;
      padding:13px 14px;font-size:14px;color:#f0f0f0;font-family:'DM Sans',sans-serif;
      outline:none;transition:border-color 0.14s;
    }
    .sw-input:focus,.sw-textarea:focus{border-color:#c8f135;}
    .sw-textarea{resize:vertical;line-height:1.5;min-height:90px;}
    .sw-helper{font-size:11.5px;color:#666;margin-top:2px;}
    .sw-row{display:flex;gap:10px;}
    .sw-row > *{flex:1;min-width:0;}
    .sw-actions{
      display:flex;gap:10px;align-items:center;margin-top:6px;
      padding-top:16px;border-top:1px solid #1f1f1f;
    }
    .sw-btn{
      padding:11px 18px;border-radius:10px;font-size:13px;cursor:pointer;
      font-family:'DM Sans',sans-serif;font-weight:500;transition:all 0.14s;
      border:1px solid #2c2c2c;background:transparent;color:#f0f0f0;
      display:inline-flex;align-items:center;justify-content:center;gap:6px;
    }
    .sw-btn:hover{background:#181818;border-color:#444;}
    .sw-btn.primary{background:#c8f135;border-color:#c8f135;color:#0a0a0a;font-weight:600;}
    .sw-btn.primary:hover{background:#d8ff45;border-color:#d8ff45;}
    .sw-btn.ghost{border-color:transparent;color:#7a7a7a;}
    .sw-btn.ghost:hover{color:#f0f0f0;background:#181818;}
    .sw-btn:disabled{opacity:0.45;cursor:not-allowed;}
    .sw-spacer{flex:1;}
    .sw-autofill-status{font-size:12px;color:#999;display:flex;align-items:center;gap:6px;}
    .sw-autofill-status.ok{color:#c8f135;}
    .sw-autofill-status.err{color:#ff8a8a;}
    .sw-pulse{
      width:7px;height:7px;border-radius:50%;background:#c8f135;
      animation:sw-pulse 1.2s ease-in-out infinite;
    }
    @keyframes sw-pulse{0%,100%{opacity:1;}50%{opacity:0.3;}}
    .sw-confetti{
      width:64px;height:64px;border-radius:50%;background:rgba(200,241,53,0.12);
      display:flex;align-items:center;justify-content:center;font-size:32px;
      align-self:flex-start;
    }
    @media (max-width:640px){
      .sw-overlay{padding:0;}
      .sw-card{
        max-width:none;width:100%;height:100%;max-height:100vh;
        border-radius:0;padding:24px 22px;
      }
      .sw-title{font-size:26px;}
      .sw-row{flex-direction:column;}
    }
  `;
  document.head.appendChild(style);

  // ── Steps ───────────────────────────────────────────────────────────────
  // The first step (website autofill) is mandatory in the sense that the user
  // sees it before anything else. After that, "Finish later" appears.
  var STEPS = [
    {
      id: 'website',
      eyebrow: 'Step 1 of 15',
      title: "Got a website?",
      sub: "Paste the URL and we'll auto-fill the rest. Skip if you'd rather fill it in by hand.",
      kind: 'website',
    },
    { id: 'firstName',          title: "What's your first name?",          field: 'firstName',          placeholder: 'Jake' },
    { id: 'lastName',           title: "And your last name?",              field: 'lastName',           placeholder: 'Reynolds' },
    { id: 'company',            title: "What's your business called?",     field: 'company',            placeholder: 'SWFT Concrete' },
    { id: 'phone',              title: "Business phone?",                  field: 'phone',              placeholder: '(555) 123-4567' },
    { id: 'address',            title: "Where are you based?",             field: 'address',            placeholder: '123 Main St, Austin TX 78745' },
    { id: 'bizAbout',           title: "Tell me about your business.",     field: 'bizAbout',           textarea: true,
      placeholder: "We're a family-owned exterior cleaning company serving the Austin area since 2020." },
    { id: 'bizServices',        title: "What services do you offer?",      field: 'bizServices',        textarea: true,
      placeholder: 'Pressure washing, soft washing, window cleaning, gutter cleaning' },
    { id: 'bizArea',            title: "Where do you serve?",              field: 'bizArea',            placeholder: 'Austin, Round Rock, Cedar Park' },
    { id: 'bizHours',           title: "When are you open?",               field: 'bizHours',           placeholder: 'Mon-Sat 8am-6pm' },
    { id: 'bizPricing',         title: "How do you price your work?",      field: 'bizPricing',         textarea: true,
      placeholder: 'Window cleaning starts at $75. Pressure washing from $150. Free estimates.' },
    { id: 'bizPaymentMethods',  title: "What payment methods do you take?",field: 'bizPaymentMethods',  placeholder: 'Card, e-Transfer, cash, cheque' },
    { id: 'bizFaqs',            title: "Common questions you hear?",       field: 'bizFaqs',            textarea: true, optional: true,
      placeholder: 'Q: Are you insured?\nA: Yes, fully licensed and insured.\n\nQ: Do you do same-day?\nA: Yes, subject to availability.' },
    { id: 'aiCustomInstructions', title: "Anything the AI should always do?", field: 'aiCustomInstructions', textarea: true, optional: true,
      sub: "Hard rules — tone, sign-offs, things to never quote, etc.",
      placeholder: "- Always greet customers by first name\n- Never quote prices over the phone\n- Sign off with 'Talk soon!'" },
    { id: 'done', kind: 'done', title: "You're all set!", sub: "SWFT now knows your business. You can edit any of this later in Settings." },
  ];

  // ── State ───────────────────────────────────────────────────────────────
  var _step = 0;
  var _data = {};       // accumulating field values + existing profile
  var _autofillRan = false;
  var _autofillSkipped = false;

  // ── DOM scaffolding ─────────────────────────────────────────────────────
  var overlay = document.createElement('div');
  overlay.className = 'sw-overlay';
  overlay.innerHTML = '<div class="sw-card" id="sw-card"></div>';
  document.body.appendChild(overlay);
  var card = overlay.querySelector('#sw-card');

  // Click outside to close (only after step 1, otherwise stays put)
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay && _step > 0) finishLater();
  });

  // ── Auth helper (matches the pattern used in swft-settings.html) ────────
  async function getToken() {
    var mod = await import('https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js');
    var auth = mod.getAuth();
    if (!auth.currentUser) {
      await new Promise(function (r) {
        var unsub = auth.onAuthStateChanged(function (u) { unsub(); r(u); });
      });
    }
    if (!auth.currentUser) throw new Error('not authed');
    return await auth.currentUser.getIdToken();
  }

  async function apiGet() {
    if (window.API && window.API.user && window.API.user.me) {
      return await window.API.user.me();
    }
    var t = await getToken();
    var r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + t } });
    return await r.json();
  }

  async function apiPut(patch) {
    if (window.API && window.API.user && window.API.user.update) {
      return await window.API.user.update(patch);
    }
    var t = await getToken();
    var r = await fetch('/api/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify(patch),
    });
    return await r.json();
  }

  async function apiAnalyze(url) {
    var t = await getToken();
    var r = await fetch('/api/me/analyze-website', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ url: url }),
    });
    if (!r.ok) {
      var err = await r.json().catch(function () { return {}; });
      throw new Error(err.error || 'Could not analyze website');
    }
    return await r.json();
  }

  // ── Render ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function progressFraction() {
    return Math.round(((_step) / (STEPS.length - 1)) * 100);
  }

  function render() {
    var s = STEPS[_step];
    var canFinishLater = _step > 0 && s.kind !== 'done';
    var pf = progressFraction();
    var totalForLabel = STEPS.length;
    var stepNum = _step + 1;

    var inner = '';
    inner += '<div class="sw-progress-row">';
    inner +=   '<div class="sw-progress-bar"><div class="sw-progress-fill" style="width:' + pf + '%"></div></div>';
    inner +=   '<div class="sw-progress-text">' + stepNum + '/' + totalForLabel + '</div>';
    if (canFinishLater) {
      inner +=   '<button class="sw-skip-all" id="sw-finish-later">Finish later</button>';
    }
    inner += '</div>';

    inner += '<div class="sw-step">';

    if (s.kind === 'website') {
      inner += '<div class="sw-eyebrow">' + esc(s.eyebrow || '') + '</div>';
      inner += '<h2 class="sw-title">' + esc(s.title) + '</h2>';
      inner += '<p class="sw-sub">' + esc(s.sub) + '</p>';
      inner += '<input class="sw-input" id="sw-website-url" placeholder="https://yourbusiness.com" value="' +
               esc(_data.website || '') + '" autofocus />';
      inner += '<div class="sw-helper">We read your homepage and About page only. Takes about 10 seconds.</div>';
      inner += '<div id="sw-autofill-status" class="sw-autofill-status" style="display:none;"></div>';

    } else if (s.kind === 'done') {
      inner += '<div class="sw-confetti">🎉</div>';
      inner += '<h2 class="sw-title">' + esc(s.title) + '</h2>';
      inner += '<p class="sw-sub">' + esc(s.sub) + '</p>';

    } else {
      inner += '<h2 class="sw-title">' + esc(s.title) + '</h2>';
      if (s.sub) inner += '<p class="sw-sub">' + esc(s.sub) + '</p>';
      var val = esc(_data[s.field] || '');
      if (s.textarea) {
        inner += '<textarea class="sw-textarea" id="sw-input" rows="4" placeholder="' + esc(s.placeholder || '') + '" autofocus>' + val + '</textarea>';
      } else {
        inner += '<input class="sw-input" id="sw-input" type="text" placeholder="' + esc(s.placeholder || '') + '" value="' + val + '" autofocus />';
      }
      if (s.optional) inner += '<div class="sw-helper">Optional — leave blank to skip.</div>';
    }

    inner += '</div>';

    // Actions
    inner += '<div class="sw-actions">';
    if (_step > 0 && s.kind !== 'done') {
      inner += '<button class="sw-btn ghost" id="sw-back">← Back</button>';
    }
    inner += '<div class="sw-spacer"></div>';

    if (s.kind === 'website') {
      if (!_autofillRan && !_autofillSkipped) {
        inner += '<button class="sw-btn ghost" id="sw-skip-autofill">I\'ll do it manually</button>';
        inner += '<button class="sw-btn primary" id="sw-run-autofill">Auto-fill with AI ✨</button>';
      } else {
        inner += '<button class="sw-btn primary" id="sw-next">Continue →</button>';
      }
    } else if (s.kind === 'done') {
      inner += '<button class="sw-btn primary" id="sw-finish">Take me to SWFT →</button>';
    } else {
      if (s.optional) {
        inner += '<button class="sw-btn ghost" id="sw-skip-step">Skip</button>';
      }
      inner += '<button class="sw-btn primary" id="sw-next">Continue →</button>';
    }
    inner += '</div>';

    card.innerHTML = inner;
    wireStep();

    // Focus the relevant input
    setTimeout(function () {
      var el = card.querySelector('#sw-input,#sw-website-url');
      if (el) try { el.focus(); } catch (_) {}
    }, 60);
  }

  function wireStep() {
    var s = STEPS[_step];

    var finishBtn = card.querySelector('#sw-finish-later');
    if (finishBtn) finishBtn.addEventListener('click', finishLater);

    var backBtn = card.querySelector('#sw-back');
    if (backBtn) backBtn.addEventListener('click', function () { _step = Math.max(0, _step - 1); render(); });

    if (s.kind === 'website') {
      var urlEl = card.querySelector('#sw-website-url');
      var runBtn = card.querySelector('#sw-run-autofill');
      var skipBtn = card.querySelector('#sw-skip-autofill');
      var nextBtn = card.querySelector('#sw-next');

      if (runBtn) runBtn.addEventListener('click', async function () {
        var url = (urlEl.value || '').trim();
        if (!url) {
          urlEl.focus();
          showAutofillStatus('Enter your website URL first.', 'err');
          return;
        }
        runBtn.disabled = true;
        showAutofillStatus('Reading your website…', 'loading');
        try {
          var json = await apiAnalyze(url);
          var d = json.data || {};
          // Merge into _data — but don't overwrite anything the user has
          // already entered (existing _data takes precedence).
          var picked = 0;
          var map = {
            company:           'company',
            phone:             'phone',
            address:           'address',
            email:             'companyEmail',   // analyzer's `email` → companyEmail
            about:             'bizAbout',
            services:          'bizServices',
            serviceArea:       'bizArea',
            hours:             'bizHours',
            pricing:           'bizPricing',
            paymentMethods:    'bizPaymentMethods',
            faqs:              'bizFaqs',
          };
          for (var k in map) {
            if (d[k] && !_data[map[k]]) { _data[map[k]] = d[k]; picked++; }
          }
          // Always store the URL itself
          _data.website = url;
          _autofillRan = true;
          // Persist what we got so a refresh doesn't lose it
          await apiPut(Object.assign({}, _data, { website: url })).catch(function () {});
          if (picked > 0) {
            showAutofillStatus('Filled ' + picked + ' field' + (picked === 1 ? '' : 's') + ' — review them next.', 'ok');
          } else {
            showAutofillStatus("Couldn't extract much from that page. You can fill in the rest manually.", 'err');
          }
          // Re-render so the Continue button replaces the autofill controls
          setTimeout(render, 600);
        } catch (e) {
          runBtn.disabled = false;
          showAutofillStatus(e.message || 'Could not analyze website.', 'err');
        }
      });

      if (skipBtn) skipBtn.addEventListener('click', function () {
        var url = (urlEl.value || '').trim();
        if (url) _data.website = url;
        _autofillSkipped = true;
        render();
      });

      if (nextBtn) nextBtn.addEventListener('click', advance);

    } else if (s.kind === 'done') {
      var doneBtn = card.querySelector('#sw-finish');
      if (doneBtn) doneBtn.addEventListener('click', finishComplete);

    } else {
      var input = card.querySelector('#sw-input');
      var nextBtn2 = card.querySelector('#sw-next');
      var skipStep = card.querySelector('#sw-skip-step');
      if (input) {
        input.addEventListener('keydown', function (ev) {
          // Enter advances on single-line inputs; Shift+Enter on textareas keeps newline
          if (ev.key === 'Enter' && !s.textarea) { ev.preventDefault(); advance(); }
        });
      }
      if (nextBtn2) nextBtn2.addEventListener('click', advance);
      if (skipStep) skipStep.addEventListener('click', function () {
        // Don't write anything for explicitly-skipped optional fields
        _step++;
        render();
      });
    }
  }

  function showAutofillStatus(msg, kind) {
    var el = card.querySelector('#sw-autofill-status');
    if (!el) return;
    el.style.display = '';
    el.className = 'sw-autofill-status' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
    var icon = kind === 'loading' ? '<div class="sw-pulse"></div>' : (kind === 'ok' ? '✓' : kind === 'err' ? '!' : '');
    el.innerHTML = (icon ? icon + ' ' : '') + esc(msg);
  }

  async function advance() {
    var s = STEPS[_step];
    if (s.kind === 'website') {
      // After autofill or skip-autofill, just move forward
      _step++;
      render();
      return;
    }
    var input = card.querySelector('#sw-input');
    var val = input ? input.value.trim() : '';

    // Persist whatever was entered (or blank, to clear)
    if (s.field) {
      _data[s.field] = val;
      // Synthesize `name` when both halves are present
      var patch = {};
      patch[s.field] = val;
      if (s.field === 'firstName' || s.field === 'lastName') {
        patch.name = [_data.firstName || '', _data.lastName || ''].filter(Boolean).join(' ');
      }
      apiPut(patch).catch(function () {});
    }
    _step++;
    render();
  }

  async function finishLater() {
    // Treat "Finish later" as an opt-out rather than a re-prompt next session.
    // The user has seen the wizard and made a choice — auto-popping again would
    // be nagging. They can always relaunch from Settings → Profile.
    try { await apiPut({ setupComplete: true }); } catch (_) {}
    close();
  }

  async function finishComplete() {
    try { await apiPut({ setupComplete: true }); } catch (_) {}
    close();
  }

  function open() {
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  async function start() {
    // Pre-populate from existing profile so re-running is non-destructive
    try {
      var me = await apiGet();
      _data = Object.assign({}, me || {});
      // If the user already pasted a website at signup, seed the input
    } catch (_) {
      _data = {};
    }
    _step = 0;
    _autofillRan = false;
    _autofillSkipped = false;
    render();
    open();
  }

  // ── Public API ──────────────────────────────────────────────────────────
  window.swftOpenSetupWizard = start;

  // Heuristic: an existing account that already filled in any company-shaped
  // info isn't a brand-new signup — don't auto-pop the wizard for them, even
  // if `setupComplete` is missing (older accounts predate the flag).
  function looksAlreadySetup(me) {
    if (!me) return false;
    return !!(me.company || me.bizAbout || me.bizServices || me.bizArea);
  }

  // Auto-trigger on the dashboard for users who haven't completed setup.
  // Pages opt in by setting `data-setup-wizard="auto"` on <body>.
  function autoMaybe() {
    if (document.body.getAttribute('data-setup-wizard') !== 'auto') return;
    // Small delay to let auth + /api/me cache settle
    setTimeout(async function () {
      try {
        var me = await apiGet();
        if (!me) return;
        if (me.setupComplete === true) return;
        if (looksAlreadySetup(me)) return;
        _data = Object.assign({}, me);
        _step = 0;
        _autofillRan = false;
        _autofillSkipped = false;
        render();
        open();
      } catch (_) {}
    }, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMaybe);
  } else {
    autoMaybe();
  }
})();
