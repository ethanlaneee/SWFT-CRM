// ════════════════════════════════════════════════
// SWFT Setup Wizard (Expanded — covers everything)
// First-run guided setup: question-by-question, full-screen on mobile.
// Auto-opens on the dashboard when `users/{uid}.setupComplete` isn't true.
// Re-runnable from Settings → Profile → "Run Setup Wizard".
//
// Saves are routed to one of three APIs based on each field's `target`:
//   • me      → PUT /api/me           (profile, company, biz, defaults, prefs)
//   • ai      → PUT /api/ai-settings  (quote/invoice/review/auto-reply)
//   • intake  → PUT /api/intake-forms (public intake QR form)
//
// Step 1 (website autofill) is the only mandatory step. After that, the user
// can "Finish later" at any time.
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
      width:100%;max-width:600px;background:#111;border:1px solid #2c2c2c;
      border-radius:18px;padding:32px 36px 24px;
      box-shadow:0 24px 80px rgba(0,0,0,0.6);
      display:flex;flex-direction:column;gap:16px;
      transform:translateY(8px);opacity:0;
      transition:transform 0.28s cubic-bezier(0.22,1,0.36,1),opacity 0.22s ease;
      max-height:calc(100vh - 48px);overflow:hidden;
    }
    .sw-overlay.open .sw-card{transform:translateY(0);opacity:1;}
    .sw-progress-row{display:flex;align-items:center;gap:10px;}
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
    .sw-section-tag{
      font-family:'Bebas Neue',sans-serif;font-size:10.5px;letter-spacing:2.5px;
      color:#888;text-transform:uppercase;
    }
    .sw-step{display:flex;flex-direction:column;gap:12px;min-height:0;flex:1;overflow-y:auto;padding-right:2px;}
    .sw-step::-webkit-scrollbar{width:4px;}
    .sw-step::-webkit-scrollbar-thumb{background:#2c2c2c;border-radius:2px;}
    .sw-eyebrow{
      font-family:'Bebas Neue',sans-serif;font-size:11px;letter-spacing:2.5px;
      color:#c8f135;text-transform:uppercase;
    }
    .sw-title{
      font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:1.5px;
      color:#f0f0f0;line-height:1.05;margin:0;
    }
    .sw-sub{font-size:13.5px;color:#999;line-height:1.55;margin:0;}
    .sw-label{
      font-size:10.5px;letter-spacing:1.4px;text-transform:uppercase;
      color:#bdbdbd;font-weight:600;margin-bottom:5px;display:block;
    }
    .sw-input,.sw-textarea,.sw-select{
      width:100%;background:#181818;border:1px solid #2c2c2c;border-radius:10px;
      padding:13px 14px;font-size:14px;color:#f0f0f0;font-family:'DM Sans',sans-serif;
      outline:none;transition:border-color 0.14s;box-sizing:border-box;
    }
    .sw-input:focus,.sw-textarea:focus,.sw-select:focus{border-color:#c8f135;}
    .sw-textarea{resize:vertical;line-height:1.5;min-height:90px;}
    .sw-select{appearance:none;-webkit-appearance:none;
      background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round'/></svg>");
      background-repeat:no-repeat;background-position:right 14px center;padding-right:34px;cursor:pointer;}
    .sw-helper{font-size:11.5px;color:#666;margin-top:2px;}
    .sw-row{display:flex;gap:10px;}
    .sw-row > *{flex:1;min-width:0;}
    .sw-field{display:flex;flex-direction:column;}
    .sw-toggle-row{
      display:flex;align-items:center;justify-content:space-between;gap:14px;
      padding:12px 14px;background:#181818;border:1px solid #2c2c2c;border-radius:10px;
    }
    .sw-toggle-row .sw-toggle-info{flex:1;min-width:0;}
    .sw-toggle-label{font-size:13.5px;color:#f0f0f0;font-weight:500;}
    .sw-toggle-desc{font-size:11.5px;color:#888;margin-top:3px;line-height:1.45;}
    .sw-toggle{
      position:relative;width:42px;height:24px;background:#2c2c2c;border-radius:12px;
      cursor:pointer;transition:background 0.18s;flex-shrink:0;
    }
    .sw-toggle::after{
      content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;
      background:#7a7a7a;border-radius:50%;transition:transform 0.18s,background 0.18s;
    }
    .sw-toggle.on{background:rgba(200,241,53,0.25);}
    .sw-toggle.on::after{transform:translateX(18px);background:#c8f135;}
    .sw-actions{
      display:flex;gap:10px;align-items:center;flex-shrink:0;
      padding-top:14px;border-top:1px solid #1f1f1f;
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
    .sw-cta-list{display:flex;flex-direction:column;gap:10px;}
    .sw-cta{
      display:flex;align-items:center;gap:14px;padding:14px 16px;
      background:#181818;border:1px solid #2c2c2c;border-radius:12px;
      cursor:pointer;transition:border-color 0.14s,background 0.14s;
      text-decoration:none;color:inherit;
    }
    .sw-cta:hover{border-color:#c8f135;background:#1d1d1d;}
    .sw-cta-icon{font-size:24px;flex-shrink:0;}
    .sw-cta-body{flex:1;min-width:0;}
    .sw-cta-title{font-size:13.5px;color:#f0f0f0;font-weight:600;}
    .sw-cta-desc{font-size:11.5px;color:#888;margin-top:2px;line-height:1.45;}
    .sw-cta-arrow{color:#666;font-size:16px;flex-shrink:0;}
    .sw-logo-row{display:flex;align-items:center;gap:14px;}
    .sw-logo-preview{
      width:72px;height:72px;border-radius:12px;background:#181818;
      border:1px solid #2c2c2c;display:flex;align-items:center;justify-content:center;
      overflow:hidden;flex-shrink:0;
    }
    .sw-logo-preview img{width:100%;height:100%;object-fit:contain;}
    .sw-logo-placeholder{font-family:'Space Mono',monospace;font-weight:700;font-size:14px;letter-spacing:2px;color:#c8f135;text-transform:uppercase;}
    .sw-summary{
      display:flex;flex-direction:column;gap:6px;
      background:#181818;border:1px solid #2c2c2c;border-radius:10px;padding:14px;
    }
    .sw-summary-row{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;}
    .sw-summary-row .k{color:#888;}
    .sw-summary-row .v{color:#f0f0f0;text-align:right;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    @media (max-width:640px){
      .sw-overlay{padding:0;}
      .sw-card{
        max-width:none;width:100%;height:100%;max-height:100vh;
        border-radius:0;padding:22px 20px;
      }
      .sw-title{font-size:24px;}
      .sw-row{flex-direction:column;}
    }
  `;
  document.head.appendChild(style);

  // ── Field & Step types ──────────────────────────────────────────────────
  // A "field" appears on a `fields` step. Each field has:
  //   id          internal key
  //   kind        text | textarea | select | toggle | number
  //   label       UI label
  //   placeholder hint
  //   helper      sub-label below input
  //   options     [{value,label}] for select
  //   default     default value if nothing saved
  //   path        key into _data (defaults to id; supports dotted "autoReply.enabled")
  //   target      "me" | "ai" | "intake" — which API to PUT
  //   optional    if true, no validation
  //   sub         (toggle) description shown beside the toggle
  //
  // A "step" can have:
  //   kind: 'website' | 'fields' | 'cta' | 'done' | 'logo'
  //   section: short label shown above the title (e.g. "Your business")
  //   title, sub, fields[], optional, ctas[]

  var STEPS = [
    // ── Welcome / Autofill ────────────────────────────────────────────────
    {
      id: 'website',
      section: 'Welcome',
      eyebrow: "Let's get you set up — under 10 minutes.",
      title: "Got a website?",
      sub: "Paste the URL and I'll auto-fill almost everything. Skip if you'd rather fill it in by hand.",
      kind: 'website',
    },

    // ── About You ─────────────────────────────────────────────────────────
    {
      id: 'name',
      section: 'About you',
      title: "What's your name?",
      sub: "Used in your sign-offs, invoices, and the AI's tone of voice.",
      kind: 'fields',
      fields: [
        { id: 'firstName', label: 'First name', placeholder: 'Jake',     target: 'me' },
        { id: 'lastName',  label: 'Last name',  placeholder: 'Reynolds', target: 'me' },
      ],
    },

    // ── Company Basics ────────────────────────────────────────────────────
    {
      id: 'company',
      section: 'Your company',
      title: "Name & phone",
      sub: "How customers know you and the number that goes on every quote.",
      kind: 'fields',
      fields: [
        { id: 'company', label: 'Company name',  placeholder: 'SWFT Concrete',     target: 'me' },
        { id: 'phone',   label: 'Business phone', placeholder: '(512) 555-1234',    target: 'me' },
      ],
    },
    {
      id: 'companyContact',
      section: 'Your company',
      title: "Address & contact email",
      sub: "Address shows on invoices. Email is your business contact — separate from your login.",
      kind: 'fields',
      fields: [
        { id: 'address',      label: 'Mailing address', placeholder: '123 Main St, Austin TX 78745', target: 'me' },
        { id: 'companyEmail', label: 'Contact email',   placeholder: 'hello@yourbusiness.com',       target: 'me' },
      ],
    },
    {
      id: 'companyMeta',
      section: 'Your company',
      title: "Country & website",
      sub: "We use country for currency formatting and tax defaults.",
      kind: 'fields',
      fields: [
        { id: 'country', kind: 'select', label: 'Country', target: 'me',
          options: [
            { value: '',   label: 'Select…' },
            { value: 'US', label: 'United States' },
            { value: 'CA', label: 'Canada' },
            { value: 'GB', label: 'United Kingdom' },
            { value: 'AU', label: 'Australia' },
            { value: 'NZ', label: 'New Zealand' },
            { value: 'IE', label: 'Ireland' },
            { value: 'OTHER', label: 'Other' },
          ] },
        { id: 'website', label: 'Website', placeholder: 'www.yourbusiness.com', target: 'me' },
      ],
    },
    {
      id: 'logo',
      section: 'Your company',
      title: "Add your logo",
      sub: "Shown on quotes, invoices, and customer-facing pages. PNG or JPG, square works best.",
      kind: 'logo',
      optional: true,
    },

    // ── Business profile for AI ───────────────────────────────────────────
    {
      id: 'bizAbout',
      section: 'AI knowledge base',
      title: "Tell me about your business.",
      sub: "2–3 sentences. The AI uses this to introduce you and answer general questions.",
      kind: 'fields',
      fields: [
        { id: 'bizAbout', kind: 'textarea', label: 'About', target: 'me',
          placeholder: "We're a family-owned exterior cleaning company in Austin, serving residential and commercial clients since 2020." },
      ],
    },
    {
      id: 'bizServices',
      section: 'AI knowledge base',
      title: "What services do you offer?",
      sub: "These also become your defaults for quotes, jobs, and the intake form.",
      kind: 'fields',
      fields: [
        { id: 'bizServices', kind: 'textarea', label: 'Services', target: 'me',
          placeholder: 'Pressure washing, soft washing, window cleaning, gutter cleaning' },
      ],
    },
    {
      id: 'bizArea',
      section: 'AI knowledge base',
      title: "Where do you serve?",
      sub: "Cities or regions. Helps the AI screen out-of-area requests.",
      kind: 'fields',
      fields: [
        { id: 'bizArea', label: 'Service area', target: 'me',
          placeholder: 'Austin, Round Rock, Cedar Park' },
      ],
    },
    {
      id: 'bizHours',
      section: 'AI knowledge base',
      title: "When are you open?",
      kind: 'fields',
      fields: [
        { id: 'bizHours', label: 'Business hours', target: 'me',
          placeholder: 'Mon–Sat 8am–6pm' },
      ],
    },
    {
      id: 'bizPricing',
      section: 'AI knowledge base',
      title: "How do you price your work?",
      sub: "The AI uses this when asked for ballpark numbers. Be as specific or as fuzzy as you like.",
      kind: 'fields',
      fields: [
        { id: 'bizPricing', kind: 'textarea', label: 'Pricing notes', target: 'me',
          placeholder: 'Window cleaning starts at $75. Pressure washing from $150. Free estimates.' },
      ],
    },
    {
      id: 'bizPaymentMethods',
      section: 'AI knowledge base',
      title: "What payment methods do you accept?",
      kind: 'fields',
      fields: [
        { id: 'bizPaymentMethods', label: 'Payment methods', target: 'me',
          placeholder: 'Card, e-Transfer, cash, cheque' },
      ],
    },
    {
      id: 'bizBookingLink',
      section: 'AI knowledge base',
      title: "Booking or scheduling link?",
      sub: "Calendly, Acuity, your own page — anywhere customers can book themselves. Optional.",
      kind: 'fields',
      optional: true,
      fields: [
        { id: 'bizBookingLink', label: 'Booking URL', target: 'me', optional: true,
          placeholder: 'https://calendly.com/yourcompany' },
      ],
    },
    {
      id: 'bizFaqs',
      section: 'AI knowledge base',
      title: "Common questions you hear?",
      sub: "Q&A pairs. The AI mines these to answer customers without bothering you. Optional.",
      kind: 'fields',
      optional: true,
      fields: [
        { id: 'bizFaqs', kind: 'textarea', label: 'FAQs', target: 'me', optional: true,
          placeholder: 'Q: Are you insured?\nA: Yes, fully licensed and insured.\n\nQ: Do you do same-day?\nA: Yes, subject to availability.' },
      ],
    },
    {
      id: 'bizNotes',
      section: 'AI knowledge base',
      title: "Anything else the AI should know?",
      sub: "Extra context — what you don't do, deal-breakers, fun facts. Optional.",
      kind: 'fields',
      optional: true,
      fields: [
        { id: 'bizNotes', kind: 'textarea', label: 'Notes', target: 'me', optional: true,
          placeholder: "We don't do roofs. Free estimates always. Licensed and insured." },
      ],
    },
    {
      id: 'aiCustomInstructions',
      section: 'AI personality',
      title: "Hard rules for the AI?",
      sub: "Tone, sign-offs, things to never say or quote. Optional but powerful.",
      kind: 'fields',
      optional: true,
      fields: [
        { id: 'aiCustomInstructions', kind: 'textarea', label: 'Custom instructions', target: 'me', optional: true,
          placeholder: "- Always greet customers by first name\n- Never quote prices over the phone\n- Sign off with 'Talk soon!'" },
      ],
    },

    // ── Operations / Defaults ─────────────────────────────────────────────
    {
      id: 'taxAndTerms',
      section: 'Operations',
      title: "Tax & payment terms",
      sub: "Defaults for new quotes and invoices — always editable per-job.",
      kind: 'fields',
      fields: [
        { id: 'taxRate', label: 'Default tax rate', placeholder: '0%', default: '0%', target: 'me' },
        { id: 'paymentTerms', kind: 'select', label: 'Payment terms', target: 'me', default: 'Net 30',
          options: [
            { value: 'Due on Receipt', label: 'Due on Receipt' },
            { value: 'Net 7',  label: 'Net 7' },
            { value: 'Net 14', label: 'Net 14' },
            { value: 'Net 30', label: 'Net 30' },
            { value: 'Net 60', label: 'Net 60' },
          ] },
      ],
    },
    {
      id: 'lineItemsAndCrews',
      section: 'Operations',
      title: "Line items & crew names",
      sub: "Comma-separated. Optional — helps with auto-complete on quotes and the schedule.",
      kind: 'fields',
      optional: true,
      fields: [
        { id: 'lineItemTypes', label: 'Line item descriptions', target: 'me', optional: true,
          placeholder: 'Materials, Labor, Equipment Rental' },
        { id: 'crewNames', label: 'Crew names', target: 'me', optional: true,
          placeholder: 'Crew A, Crew B' },
      ],
    },

    // ── AI automations ────────────────────────────────────────────────────
    {
      id: 'autoQuoteFollowup',
      section: 'AI automations',
      title: "Auto-follow up on unanswered quotes",
      sub: "If a customer hasn't responded, SWFT can ping them for you on the schedule below.",
      kind: 'fields',
      fields: [
        { id: 'quoteFollowup_enabled', kind: 'toggle', label: 'Enabled',
          desc: 'Skips automatically if the AI sees the quote was already accepted.',
          default: true, target: 'ai', path: 'quoteFollowup.enabled' },
        { id: 'quoteFollowup_delayDays', kind: 'number', label: 'Days to wait', default: 3, min: 0, max: 30,
          target: 'ai', path: 'quoteFollowup.delayDays' },
        { id: 'quoteFollowup_channel', kind: 'select', label: 'Send via', default: 'sms',
          options: [{ value: 'sms', label: 'SMS' }, { value: 'email', label: 'Email' }],
          target: 'ai', path: 'quoteFollowup.channel' },
      ],
    },
    {
      id: 'autoInvoiceFollowup',
      section: 'AI automations',
      title: "Auto-remind unpaid invoices",
      sub: "Friendly reminders for invoices still outstanding.",
      kind: 'fields',
      fields: [
        { id: 'invoiceFollowup_enabled', kind: 'toggle', label: 'Enabled',
          desc: 'Skips if the customer says they\'ll pay or the invoice is already paid.',
          default: true, target: 'ai', path: 'invoiceFollowup.enabled' },
        { id: 'invoiceFollowup_delayDays', kind: 'number', label: 'Days after due date', default: 7, min: 0, max: 60,
          target: 'ai', path: 'invoiceFollowup.delayDays' },
        { id: 'invoiceFollowup_channel', kind: 'select', label: 'Send via', default: 'sms',
          options: [{ value: 'sms', label: 'SMS' }, { value: 'email', label: 'Email' }],
          target: 'ai', path: 'invoiceFollowup.channel' },
      ],
    },
    {
      id: 'autoReviewRequest',
      section: 'AI automations',
      title: "Auto-request reviews after the job",
      sub: "Send a thank-you with your review link a day or two after job completion.",
      kind: 'fields',
      fields: [
        { id: 'reviewRequest_enabled', kind: 'toggle', label: 'Enabled',
          desc: 'Skips if the AI sees the customer was unhappy in the last conversation.',
          default: true, target: 'ai', path: 'reviewRequest.enabled' },
        { id: 'reviewRequest_delayDays', kind: 'number', label: 'Days after job complete', default: 1, min: 0, max: 30,
          target: 'ai', path: 'reviewRequest.delayDays' },
        { id: 'reviewRequest_reviewLink', label: 'Google review link (optional)', target: 'ai', optional: true,
          path: 'reviewRequest.reviewLink',
          placeholder: 'https://search.google.com/local/writereview?placeid=…',
          helper: "Find yours in Settings → Profile → Find on Google. Leave blank to set later." },
      ],
    },
    {
      id: 'autoReply',
      section: 'AI automations',
      title: "AI auto-replies for inbound messages",
      sub: "Pick which channels SWFT should reply to instantly using your business profile.",
      kind: 'fields',
      fields: [
        { id: 'autoReply_enabled', kind: 'toggle', label: 'Master switch',
          desc: 'When off, no auto-replies are sent on any channel.',
          default: true, target: 'ai', path: 'autoReply.enabled' },
        { id: 'autoReply_sms', kind: 'toggle', label: 'SMS / text messages',
          default: true, target: 'ai', path: 'autoReply.channels.sms' },
        { id: 'autoReply_instagram', kind: 'toggle', label: 'Instagram DMs',
          default: true, target: 'ai', path: 'autoReply.channels.instagram' },
        { id: 'autoReply_facebook', kind: 'toggle', label: 'Facebook Messenger',
          default: true, target: 'ai', path: 'autoReply.channels.facebook' },
      ],
    },

    // ── Customer intake form ──────────────────────────────────────────────
    {
      id: 'intakeBasics',
      section: 'Customer intake',
      title: "Public intake form (QR code)",
      sub: "When enabled, you get a public link + QR for trucks, signs, and trade shows. Submissions land in Jobs → Service Requests.",
      kind: 'fields',
      fields: [
        { id: 'intake_active', kind: 'toggle', label: 'Enable intake form',
          default: true, target: 'intake', path: 'active',
          desc: 'You can always toggle this off later in Settings → Operations.' },
        { id: 'intake_formTitle', label: 'Form title', target: 'intake', path: 'formTitle',
          placeholder: 'Request a Quote', default: 'Request a Quote' },
        { id: 'intake_formSubtitle', label: 'Form subtitle', target: 'intake', path: 'formSubtitle',
          placeholder: "Fill out the form and we'll get back to you within a day.",
          default: "Fill out the form below and we'll be in touch shortly." },
      ],
    },
    {
      id: 'intakeOptions',
      section: 'Customer intake',
      title: "Intake options",
      sub: "Live quote estimation needs per-sq-ft rates set in Settings → Operations afterward.",
      kind: 'fields',
      fields: [
        { id: 'intake_quoteEnabled', kind: 'toggle', label: 'Show live quote estimate',
          desc: 'Customers see an estimated price as they fill out the form.',
          default: false, target: 'intake', path: 'quoteEnabled' },
        { id: 'intake_requirePhotos', kind: 'toggle', label: 'Require job-site photos',
          desc: 'Helpful for service-based estimates and fewer back-and-forths.',
          default: false, target: 'intake', path: 'requirePhotos' },
        { id: 'intake_hearAboutOptions', label: '"How did you hear about us?" options',
          target: 'intake', path: 'hearAboutOptions',
          placeholder: 'Google, Social Media, Referral, Other',
          default: 'Google, Social Media, Referral, Other' },
      ],
    },

    // ── Preferences ───────────────────────────────────────────────────────
    {
      id: 'preferences',
      section: 'Preferences',
      title: "Display preferences",
      kind: 'fields',
      fields: [
        { id: 'weatherUnit', kind: 'select', label: 'Temperature units', target: 'me',
          default: 'auto',
          options: [
            { value: 'auto', label: 'Auto-detect' },
            { value: 'fahrenheit', label: 'Fahrenheit (°F)' },
            { value: 'celsius', label: 'Celsius (°C)' },
          ] },
      ],
    },

    // ── Wrap-up CTAs ──────────────────────────────────────────────────────
    {
      id: 'importInviteFinish',
      section: 'Last bits',
      title: "Two optional shortcuts",
      sub: "Open in a new tab — they don't block setup. You can always do these later.",
      kind: 'cta',
      ctas: [
        { icon: '📥', title: 'Import customers & jobs',
          desc: 'CSV from Jobber, Housecall Pro, ServiceTitan or any spreadsheet. Up to 500 records at a time.',
          href: '/swft-import', target: '_blank' },
        { icon: '👥', title: 'Invite your team',
          desc: 'Add admins, office staff, or technicians by email. Each gets a join link.',
          href: '/swft-team', target: '_blank' },
      ],
    },

    // ── Done ──────────────────────────────────────────────────────────────
    {
      id: 'done',
      kind: 'done',
      section: 'You did it',
      title: "You're all set!",
      sub: "SWFT now knows your business inside and out. Edit any of this anytime in Settings.",
    },
  ];

  // ── State ───────────────────────────────────────────────────────────────
  var _step = 0;
  var _data = {};       // accumulating values + existing profile (flat for `me`)
  var _ai = {};         // ai-settings values, nested per server schema
  var _intake = {};     // intake form values
  var _autofillRan = false;
  var _autofillSkipped = false;

  // ── DOM scaffolding ─────────────────────────────────────────────────────
  var overlay = document.createElement('div');
  overlay.className = 'sw-overlay';
  overlay.innerHTML = '<div class="sw-card" id="sw-card"></div>';
  document.body.appendChild(overlay);
  var card = overlay.querySelector('#sw-card');

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay && _step > 0) finishLater();
  });

  // ── Auth + API helpers ──────────────────────────────────────────────────
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

  async function apiGetAi() {
    if (window.API && window.API.aiSettings && window.API.aiSettings.get) {
      try { return await window.API.aiSettings.get(); } catch (_) { return {}; }
    }
    try {
      var t = await getToken();
      var r = await fetch('/api/ai-settings', { headers: { Authorization: 'Bearer ' + t } });
      return await r.json();
    } catch (_) { return {}; }
  }

  async function apiPutAi(patch) {
    if (window.API && window.API.aiSettings && window.API.aiSettings.save) {
      try { return await window.API.aiSettings.save(patch); } catch (_) { return null; }
    }
    try {
      var t = await getToken();
      var r = await fetch('/api/ai-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
        body: JSON.stringify(patch),
      });
      return await r.json();
    } catch (_) { return null; }
  }

  async function apiGetIntake() {
    if (window.API && window.API.intakeForms && window.API.intakeForms.get) {
      try { return await window.API.intakeForms.get(); } catch (_) { return {}; }
    }
    try {
      var t = await getToken();
      var r = await fetch('/api/intake-forms', { headers: { Authorization: 'Bearer ' + t } });
      return await r.json();
    } catch (_) { return {}; }
  }

  async function apiPutIntake(patch) {
    if (window.API && window.API.intakeForms && window.API.intakeForms.save) {
      try { return await window.API.intakeForms.save(patch); } catch (_) { return null; }
    }
    try {
      var t = await getToken();
      var r = await fetch('/api/intake-forms', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
        body: JSON.stringify(patch),
      });
      return await r.json();
    } catch (_) { return null; }
  }

  // ── Path helpers (for nested ai-settings keys) ──────────────────────────
  function getPath(obj, path) {
    if (!obj || !path) return undefined;
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }
  function setPath(obj, path, val) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = val;
  }

  // ── Render ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function progressFraction() {
    return Math.round((_step / (STEPS.length - 1)) * 100);
  }

  function fieldValue(f) {
    var path = f.path || f.id;
    var bag = f.target === 'ai' ? _ai : f.target === 'intake' ? _intake : _data;
    var v = getPath(bag, path);
    if (v === undefined || v === null || v === '') {
      return f.default !== undefined ? f.default : (f.kind === 'toggle' ? false : '');
    }
    return v;
  }

  function renderField(f) {
    var v = fieldValue(f);
    var html = '';
    if (f.kind === 'toggle') {
      html += '<div class="sw-toggle-row" data-field="' + esc(f.id) + '">';
      html += '<div class="sw-toggle-info">';
      html += '<div class="sw-toggle-label">' + esc(f.label) + '</div>';
      if (f.desc) html += '<div class="sw-toggle-desc">' + esc(f.desc) + '</div>';
      html += '</div>';
      html += '<div class="sw-toggle ' + (v ? 'on' : '') + '" data-toggle-id="' + esc(f.id) + '"></div>';
      html += '</div>';
      return html;
    }
    html += '<div class="sw-field">';
    if (f.label) html += '<label class="sw-label" for="sw-f-' + esc(f.id) + '">' + esc(f.label) + '</label>';
    if (f.kind === 'textarea') {
      html += '<textarea class="sw-textarea" id="sw-f-' + esc(f.id) + '" data-field="' + esc(f.id) + '" rows="4" placeholder="' + esc(f.placeholder || '') + '">' + esc(v) + '</textarea>';
    } else if (f.kind === 'select') {
      html += '<select class="sw-select" id="sw-f-' + esc(f.id) + '" data-field="' + esc(f.id) + '">';
      (f.options || []).forEach(function (op) {
        var sel = String(op.value) === String(v) ? ' selected' : '';
        html += '<option value="' + esc(op.value) + '"' + sel + '>' + esc(op.label) + '</option>';
      });
      html += '</select>';
    } else if (f.kind === 'number') {
      html += '<input class="sw-input" id="sw-f-' + esc(f.id) + '" data-field="' + esc(f.id) + '" type="number" min="' + (f.min != null ? f.min : 0) + '" max="' + (f.max != null ? f.max : 999) + '" value="' + esc(v) + '" placeholder="' + esc(f.placeholder || '') + '"/>';
    } else {
      html += '<input class="sw-input" id="sw-f-' + esc(f.id) + '" data-field="' + esc(f.id) + '" type="text" placeholder="' + esc(f.placeholder || '') + '" value="' + esc(v) + '"/>';
    }
    if (f.helper) html += '<div class="sw-helper">' + esc(f.helper) + '</div>';
    html += '</div>';
    return html;
  }

  function render() {
    var s = STEPS[_step];
    var canFinishLater = _step > 0 && s.kind !== 'done';
    var pf = progressFraction();
    var stepNum = _step + 1;
    var totalForLabel = STEPS.length;

    var inner = '';
    inner += '<div class="sw-progress-row">';
    inner +=   '<div class="sw-progress-bar"><div class="sw-progress-fill" style="width:' + pf + '%"></div></div>';
    inner +=   '<div class="sw-progress-text">' + stepNum + '/' + totalForLabel + '</div>';
    if (canFinishLater) {
      inner +=   '<button class="sw-skip-all" id="sw-finish-later">Finish later</button>';
    }
    inner += '</div>';

    inner += '<div class="sw-step">';

    if (s.section) inner += '<div class="sw-section-tag">' + esc(s.section) + '</div>';

    if (s.kind === 'website') {
      if (s.eyebrow) inner += '<div class="sw-eyebrow">' + esc(s.eyebrow) + '</div>';
      inner += '<h2 class="sw-title">' + esc(s.title) + '</h2>';
      inner += '<p class="sw-sub">' + esc(s.sub) + '</p>';
      inner += '<input class="sw-input" id="sw-website-url" placeholder="https://yourbusiness.com" value="' + esc(_data.website || '') + '" autofocus />';
      inner += '<div class="sw-helper">We read your homepage and About page only — about 10 seconds.</div>';
      inner += '<div id="sw-autofill-status" class="sw-autofill-status" style="display:none;"></div>';

    } else if (s.kind === 'logo') {
      inner += '<h2 class="sw-title">' + esc(s.title) + '</h2>';
      if (s.sub) inner += '<p class="sw-sub">' + esc(s.sub) + '</p>';
      inner += '<div class="sw-logo-row">';
      inner +=   '<div class="sw-logo-preview" id="sw-logo-preview">';
      if (_data.companyLogo) {
        inner += '<img src="' + esc(_data.companyLogo) + '" alt="logo"/>';
      } else {
        inner += '<span class="sw-logo-placeholder">' + esc(((_data.company || 'SWFT').match(/\b\w/g) || ['S']).join('').slice(0, 4)) + '</span>';
      }
      inner +=   '</div>';
      inner +=   '<div style="display:flex;flex-direction:column;gap:8px;flex:1;">';
      inner +=     '<button class="sw-btn" id="sw-logo-pick">Choose image…</button>';
      if (_data.companyLogo) {
        inner +=   '<button class="sw-btn ghost" id="sw-logo-remove">Remove</button>';
      }
      inner +=     '<input type="file" id="sw-logo-file" accept="image/*" style="display:none;"/>';
      inner +=   '</div>';
      inner += '</div>';
      inner += '<div class="sw-helper">PNG / JPG / SVG. We resize to fit — square logos look best.</div>';

    } else if (s.kind === 'cta') {
      inner += '<h2 class="sw-title">' + esc(s.title) + '</h2>';
      if (s.sub) inner += '<p class="sw-sub">' + esc(s.sub) + '</p>';
      inner += '<div class="sw-cta-list">';
      (s.ctas || []).forEach(function (c) {
        inner += '<a class="sw-cta" href="' + esc(c.href) + '" target="' + esc(c.target || '_self') + '" rel="noopener">';
        inner += '<div class="sw-cta-icon">' + esc(c.icon || '→') + '</div>';
        inner += '<div class="sw-cta-body">';
        inner += '<div class="sw-cta-title">' + esc(c.title) + '</div>';
        inner += '<div class="sw-cta-desc">' + esc(c.desc) + '</div>';
        inner += '</div>';
        inner += '<div class="sw-cta-arrow">↗</div>';
        inner += '</a>';
      });
      inner += '</div>';

    } else if (s.kind === 'done') {
      inner += '<div class="sw-confetti">🎉</div>';
      inner += '<h2 class="sw-title">' + esc(s.title) + '</h2>';
      inner += '<p class="sw-sub">' + esc(s.sub) + '</p>';
      // Quick recap
      var recap = [];
      if (_data.company) recap.push({ k: 'Company', v: _data.company });
      if (_data.bizServices) recap.push({ k: 'Services', v: _data.bizServices });
      if (_data.bizArea) recap.push({ k: 'Service area', v: _data.bizArea });
      var autoCount = 0;
      ['quoteFollowup','invoiceFollowup','reviewRequest','autoReply'].forEach(function (k) {
        if (_ai && _ai[k] && _ai[k].enabled) autoCount++;
      });
      if (autoCount) recap.push({ k: 'AI automations', v: autoCount + ' enabled' });
      if (_intake && _intake.active) recap.push({ k: 'Intake form', v: 'Live' });
      if (recap.length) {
        inner += '<div class="sw-summary">';
        recap.forEach(function (r) {
          inner += '<div class="sw-summary-row"><span class="k">' + esc(r.k) + '</span><span class="v">' + esc(r.v) + '</span></div>';
        });
        inner += '</div>';
      }

    } else if (s.kind === 'fields') {
      inner += '<h2 class="sw-title">' + esc(s.title) + '</h2>';
      if (s.sub) inner += '<p class="sw-sub">' + esc(s.sub) + '</p>';
      var twoCol = (s.fields || []).length === 2 && (s.fields || []).every(function (f) {
        return !f.kind || f.kind === 'text' || f.kind === 'select' || f.kind === 'number';
      });
      if (twoCol) inner += '<div class="sw-row">';
      (s.fields || []).forEach(function (f) { inner += renderField(f); });
      if (twoCol) inner += '</div>';
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
      if (s.kind === 'cta' || s.optional) {
        inner += '<button class="sw-btn ghost" id="sw-skip-step">Skip</button>';
      }
      inner += '<button class="sw-btn primary" id="sw-next">Continue →</button>';
    }
    inner += '</div>';

    card.innerHTML = inner;
    wireStep();

    setTimeout(function () {
      var el = card.querySelector('#sw-website-url, .sw-step input.sw-input:not([readonly]), .sw-step textarea, .sw-step select');
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
          var picked = 0;
          var map = {
            company:        'company',
            phone:          'phone',
            address:        'address',
            email:          'companyEmail',
            about:          'bizAbout',
            services:       'bizServices',
            serviceArea:    'bizArea',
            hours:          'bizHours',
            pricing:        'bizPricing',
            paymentMethods: 'bizPaymentMethods',
            bookingLink:    'bizBookingLink',
            faqs:           'bizFaqs',
          };
          for (var k in map) {
            if (d[k] && !_data[map[k]]) { _data[map[k]] = d[k]; picked++; }
          }
          // Pre-fill serviceTypes from extracted services if user hasn't set them
          if (d.services && !_data.serviceTypes) {
            _data.serviceTypes = d.services;
          }
          _data.website = url;
          _autofillRan = true;
          await apiPut(Object.assign({}, _data, { website: url })).catch(function () {});
          if (picked > 0) {
            showAutofillStatus('Filled ' + picked + ' field' + (picked === 1 ? '' : 's') + ' — review them next.', 'ok');
          } else {
            showAutofillStatus("Couldn't extract much from that page. You can fill in the rest manually.", 'err');
          }
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

    } else if (s.kind === 'logo') {
      var pick = card.querySelector('#sw-logo-pick');
      var file = card.querySelector('#sw-logo-file');
      var rm   = card.querySelector('#sw-logo-remove');
      var nb   = card.querySelector('#sw-next');
      var sk   = card.querySelector('#sw-skip-step');
      if (pick) pick.addEventListener('click', function () { file && file.click(); });
      if (file) file.addEventListener('change', function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        if (f.size > 2 * 1024 * 1024) {
          if (typeof showToast === 'function') showToast('Image is over 2 MB — pick a smaller one.');
          else console.warn('Image too large');
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          _data.companyLogo = reader.result;
          render();
        };
        reader.readAsDataURL(f);
      });
      if (rm) rm.addEventListener('click', function () {
        _data.companyLogo = '';
        render();
      });
      if (nb) nb.addEventListener('click', advance);
      if (sk) sk.addEventListener('click', function () { _step++; render(); });

    } else if (s.kind === 'cta') {
      var nb2 = card.querySelector('#sw-next');
      var sk2 = card.querySelector('#sw-skip-step');
      if (nb2) nb2.addEventListener('click', advance);
      if (sk2) sk2.addEventListener('click', advance);

    } else if (s.kind === 'fields') {
      // Toggle clicks
      var toggles = card.querySelectorAll('.sw-toggle');
      toggles.forEach(function (t) {
        t.addEventListener('click', function () {
          t.classList.toggle('on');
        });
      });

      var inputs = card.querySelectorAll('.sw-input, .sw-textarea, .sw-select');
      inputs.forEach(function (el) {
        el.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' && el.tagName !== 'TEXTAREA') {
            ev.preventDefault();
            advance();
          }
        });
      });

      var nb3 = card.querySelector('#sw-next');
      var sk3 = card.querySelector('#sw-skip-step');
      if (nb3) nb3.addEventListener('click', advance);
      if (sk3) sk3.addEventListener('click', function () { _step++; render(); });
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

  function collectStepValues() {
    // Returns { mePatch, aiPatch, intakePatch } for the current step.
    var s = STEPS[_step];
    var mePatch = null, aiPatch = null, intakePatch = null;
    if (s.kind !== 'fields') return { mePatch: mePatch, aiPatch: aiPatch, intakePatch: intakePatch };

    (s.fields || []).forEach(function (f) {
      var path = f.path || f.id;
      var val;
      if (f.kind === 'toggle') {
        var t = card.querySelector('[data-toggle-id="' + f.id + '"]');
        val = t ? t.classList.contains('on') : !!fieldValue(f);
      } else {
        var el = card.querySelector('[data-field="' + f.id + '"]');
        if (!el) return;
        val = el.value;
        if (f.kind === 'number') {
          val = val === '' ? null : Number(val);
        } else if (typeof val === 'string') {
          val = val.trim();
        }
      }

      // Update local state
      if (f.target === 'ai') {
        setPath(_ai, path, val);
        if (!aiPatch) aiPatch = {};
        setPath(aiPatch, path, val);
      } else if (f.target === 'intake') {
        setPath(_intake, path, val);
        if (!intakePatch) intakePatch = {};
        intakePatch[path] = val; // intake schema is flat
      } else {
        _data[path] = val;
        if (!mePatch) mePatch = {};
        mePatch[path] = val;
        // synthesize `name` when both halves exist
        if (path === 'firstName' || path === 'lastName') {
          mePatch.name = [_data.firstName || '', _data.lastName || ''].filter(Boolean).join(' ');
          _data.name = mePatch.name;
        }
        // `bizServices` doubles as the canonical service-type list. Mirror it
        // to `serviceTypes` so legacy consumers (intake form, server) keep
        // working without a second input box.
        if (path === 'bizServices') {
          mePatch.serviceTypes = val;
          _data.serviceTypes = val;
        }
      }
    });

    return { mePatch: mePatch, aiPatch: aiPatch, intakePatch: intakePatch };
  }

  function aiSectionPayload(patch) {
    // Server expects a per-section object. We expand the merged patch into the
    // sections it touches by merging with what we've already loaded.
    if (!patch) return null;
    var out = {};
    ['quoteFollowup', 'invoiceFollowup', 'reviewRequest', 'autoReply', 'customerMemory'].forEach(function (sec) {
      if (patch[sec] !== undefined || (_ai[sec] && Object.keys(_ai[sec]).length)) {
        out[sec] = Object.assign({}, _ai[sec] || {}, patch[sec] || {});
      }
    });
    return out;
  }

  async function persistPatches(patches) {
    var promises = [];
    if (patches.mePatch) {
      promises.push(apiPut(patches.mePatch).catch(function () {}));
    }
    if (patches.aiPatch) {
      // Send the merged section data the server expects
      var payload = aiSectionPayload(patches.aiPatch);
      if (payload) promises.push(apiPutAi(payload).catch(function () {}));
    }
    if (patches.intakePatch) {
      // Server requires a full doc — merge with what we have
      var full = Object.assign({}, _intake, patches.intakePatch);
      promises.push(apiPutIntake(full).catch(function () {}));
    }
    if (promises.length) await Promise.all(promises);
  }

  async function advance() {
    var s = STEPS[_step];
    if (s.kind === 'website') {
      _step++;
      render();
      return;
    }

    if (s.kind === 'logo') {
      // Save logo (data URL) and move on
      if (_data.companyLogo !== undefined) {
        apiPut({ companyLogo: _data.companyLogo }).catch(function () {});
      }
      _step++;
      render();
      return;
    }

    if (s.kind === 'cta') {
      _step++;
      render();
      return;
    }

    if (s.kind === 'fields') {
      var patches = collectStepValues();
      // fire-and-forget — wizard stays snappy even on slow networks
      persistPatches(patches);
      _step++;
      render();
      return;
    }

    _step++;
    render();
  }

  async function finishLater() {
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

  function seedDefaultsIntoState() {
    // Fill in any defaults from the schema so toggles render in the right state
    // even when the server returned no value for them yet.
    STEPS.forEach(function (s) {
      if (s.kind !== 'fields') return;
      (s.fields || []).forEach(function (f) {
        if (f.default === undefined) return;
        var path = f.path || f.id;
        var bag = f.target === 'ai' ? _ai : f.target === 'intake' ? _intake : _data;
        var cur = getPath(bag, path);
        if (cur === undefined || cur === null || cur === '') {
          setPath(bag, path, f.default);
        }
      });
    });
  }

  async function loadAll() {
    var results = await Promise.all([
      apiGet().catch(function () { return {}; }),
      apiGetAi().catch(function () { return {}; }),
      apiGetIntake().catch(function () { return {}; }),
    ]);
    _data = Object.assign({}, results[0] || {});
    _ai = Object.assign({}, results[1] || {});
    _intake = Object.assign({}, results[2] || {});
    seedDefaultsIntoState();
  }

  async function start() {
    try { await loadAll(); } catch (_) { _data = {}; _ai = {}; _intake = {}; seedDefaultsIntoState(); }
    _step = 0;
    _autofillRan = false;
    _autofillSkipped = false;
    render();
    open();
  }

  // ── Public API ──────────────────────────────────────────────────────────
  window.swftOpenSetupWizard = start;

  // Heuristic: don't auto-pop the wizard for accounts that already have key
  // fields filled in (older accounts predate the `setupComplete` flag).
  function looksAlreadySetup(me) {
    if (!me) return false;
    return !!(me.company || me.bizAbout || me.bizServices || me.bizArea);
  }

  function autoMaybe() {
    if (document.body.getAttribute('data-setup-wizard') !== 'auto') return;
    setTimeout(async function () {
      try {
        var me = await apiGet();
        if (!me) return;
        if (me.setupComplete === true) return;
        if (looksAlreadySetup(me)) return;
        await loadAll();
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
