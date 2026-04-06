// ════════════════════════════════════════════════
// SWFT Confirm Dialog + PDF Preview
// Replaces browser confirm() with styled inline popup
// Include via: <script src="swft-confirm.js"></script>
// ════════════════════════════════════════════════

(function () {
  const style = document.createElement("style");
  style.textContent = `
    .swft-confirm-overlay {
      position:fixed; inset:0; background:rgba(0,0,0,0.7);
      backdrop-filter:blur(6px); z-index:9500;
      display:flex; align-items:center; justify-content:center;
      opacity:0; pointer-events:none; transition:opacity 0.2s; padding:24px;
    }
    .swft-confirm-overlay.open { opacity:1; pointer-events:all; }
    .swft-confirm-box {
      background:#111; border:1px solid #2c2c2c; border-radius:16px;
      width:100%; max-width:380px; padding:0; overflow:hidden;
      transform:scale(0.95); transition:transform 0.2s;
      box-shadow:0 20px 60px rgba(0,0,0,0.5);
    }
    .swft-confirm-overlay.open .swft-confirm-box { transform:scale(1); }
    .swft-confirm-icon { text-align:center; padding:24px 24px 12px; font-size:36px; }
    .swft-confirm-title {
      text-align:center; font-family:'Bebas Neue',sans-serif;
      font-size:20px; color:#f0f0f0; letter-spacing:1.5px;
    }
    .swft-confirm-msg {
      text-align:center; font-size:13px; color:#7a7a7a;
      padding:8px 24px 20px; line-height:1.5;
    }
    .swft-confirm-msg strong { color:#f0f0f0; }
    .swft-confirm-btns {
      display:flex; border-top:1px solid #1f1f1f;
    }
    .swft-confirm-btn {
      flex:1; padding:14px; border:none; background:transparent;
      font-family:'DM Sans',sans-serif; font-size:13.5px; font-weight:500;
      cursor:pointer; transition:background 0.15s;
    }
    .swft-confirm-btn.cancel { color:#7a7a7a; border-right:1px solid #1f1f1f; }
    .swft-confirm-btn.cancel:hover { background:#181818; color:#f0f0f0; }
    .swft-confirm-btn.danger { color:#ff5252; font-weight:700; }
    .swft-confirm-btn.danger:hover { background:rgba(255,82,82,0.1); }

    /* PDF Preview */
    .swft-pdf-overlay {
      position:fixed; inset:0; background:rgba(0,0,0,0.8);
      backdrop-filter:blur(8px); z-index:9400;
      display:flex; align-items:center; justify-content:center;
      opacity:0; pointer-events:none; transition:opacity 0.25s; padding:20px;
    }
    .swft-pdf-overlay.open { opacity:1; pointer-events:all; }
    .swft-pdf-modal {
      background:#fff; border-radius:12px; width:100%; max-width:680px;
      max-height:90vh; overflow-y:auto; color:#111;
      transform:scale(0.95); transition:transform 0.25s;
      box-shadow:0 24px 80px rgba(0,0,0,0.5);
    }
    .swft-pdf-overlay.open .swft-pdf-modal { transform:scale(1); }
    .swft-pdf-header {
      display:flex; align-items:center; justify-content:space-between;
      padding:20px 24px; border-bottom:1px solid #e0e0e0;
    }
    .swft-pdf-header h3 { font-family:'Bebas Neue',sans-serif; font-size:22px; letter-spacing:2px; color:#111; margin:0; }
    .swft-pdf-close {
      width:30px; height:30px; border-radius:8px; border:1px solid #ddd;
      background:#f5f5f5; display:flex; align-items:center; justify-content:center;
      cursor:pointer; color:#666; font-size:16px;
    }
    .swft-pdf-close:hover { background:#eee; }
    .swft-pdf-body { padding:24px; }
    .swft-pdf-body .pdf-company {
      font-family:'Bebas Neue',sans-serif; font-size:28px;
      letter-spacing:3px; color:#111; margin-bottom:4px;
    }
    .swft-pdf-body .pdf-company em { color:#8ab800; font-style:normal; }
    .swft-pdf-body .pdf-tagline { font-size:10px; color:#999; letter-spacing:1.5px; margin-bottom:20px; }
    .swft-pdf-body .pdf-type {
      font-family:'Bebas Neue',sans-serif; font-size:18px;
      letter-spacing:2px; color:#111; margin-bottom:16px;
      padding-bottom:8px; border-bottom:2px solid #8ab800;
    }
    .swft-pdf-body .pdf-row {
      display:flex; justify-content:space-between; margin-bottom:6px;
      font-size:13px;
    }
    .swft-pdf-body .pdf-row .label { color:#666; }
    .swft-pdf-body .pdf-row .value { color:#111; font-weight:500; }
    .swft-pdf-body .pdf-section { margin-top:20px; margin-bottom:8px; font-size:11px; letter-spacing:1.5px; text-transform:uppercase; color:#999; }
    .swft-pdf-body .pdf-line-header {
      display:grid; grid-template-columns:2fr 1fr 1fr 1fr; padding:8px 0;
      font-size:10px; letter-spacing:1px; text-transform:uppercase; color:#999;
      border-bottom:1px solid #e0e0e0;
    }
    .swft-pdf-body .pdf-line {
      display:grid; grid-template-columns:2fr 1fr 1fr 1fr; padding:10px 0;
      font-size:13px; border-bottom:1px solid #f0f0f0;
    }
    .swft-pdf-body .pdf-line .amt { font-weight:500; }
    .swft-pdf-body .pdf-total-row {
      display:flex; justify-content:space-between; padding:10px 0;
      font-size:14px;
    }
    .swft-pdf-body .pdf-total-row.grand {
      font-size:18px; font-weight:700; color:#111;
      border-top:2px solid #111; margin-top:4px; padding-top:12px;
    }
    .swft-pdf-footer {
      display:flex; gap:10px; padding:16px 24px; border-top:1px solid #e0e0e0;
    }
    .swft-pdf-btn {
      flex:1; padding:11px; border-radius:9px; border:1px solid #ddd;
      background:#fff; color:#333; font-family:'DM Sans',sans-serif;
      font-size:13px; cursor:pointer; text-align:center; font-weight:500;
    }
    .swft-pdf-btn:hover { background:#f5f5f5; }
    .swft-pdf-btn.primary { background:#8ab800; color:#fff; border-color:#8ab800; font-weight:700; }
    .swft-pdf-btn.primary:hover { background:#7aa300; }
  `;
  document.head.appendChild(style);

  // ── Confirm Dialog ──
  const confirmOverlay = document.createElement("div");
  confirmOverlay.className = "swft-confirm-overlay";
  confirmOverlay.innerHTML = `
    <div class="swft-confirm-box">
      <div class="swft-confirm-icon" id="swft-confirm-icon">🗑️</div>
      <div class="swft-confirm-title" id="swft-confirm-title">DELETE ITEM</div>
      <div class="swft-confirm-msg" id="swft-confirm-msg">Are you sure?</div>
      <div class="swft-confirm-btns">
        <button class="swft-confirm-btn cancel" onclick="swftConfirmClose(false)">Cancel</button>
        <button class="swft-confirm-btn danger" id="swft-confirm-action-btn" onclick="swftConfirmClose(true)">Delete</button>
      </div>
    </div>`;
  document.body.appendChild(confirmOverlay);

  let _confirmResolve = null;

  window.swftConfirm = function (msg, title, icon, actionLabel) {
    document.getElementById("swft-confirm-icon").textContent = icon || "🗑️";
    document.getElementById("swft-confirm-title").textContent = title || "DELETE ITEM";
    document.getElementById("swft-confirm-msg").innerHTML = msg;
    var actionBtn = document.getElementById("swft-confirm-action-btn");
    if (actionBtn) actionBtn.textContent = actionLabel || title || "Delete";
    confirmOverlay.classList.add("open");
    return new Promise((resolve) => { _confirmResolve = resolve; });
  };

  window.swftConfirmClose = function (result) {
    confirmOverlay.classList.remove("open");
    if (_confirmResolve) { _confirmResolve(result); _confirmResolve = null; }
  };

  // ── PDF Preview ──
  const pdfOverlay = document.createElement("div");
  pdfOverlay.className = "swft-pdf-overlay";
  pdfOverlay.innerHTML = `
    <div class="swft-pdf-modal">
      <div class="swft-pdf-header">
        <h3 id="swft-pdf-title">QUOTE PREVIEW</h3>
        <div class="swft-pdf-close" onclick="closePdfPreview()">&times;</div>
      </div>
      <div class="swft-pdf-body" id="swft-pdf-body"></div>
      <div class="swft-pdf-footer">
        <button class="swft-pdf-btn" onclick="closePdfPreview()">Close</button>
        <button class="swft-pdf-btn" onclick="printPdf()">Print / Save PDF</button>
        <button class="swft-pdf-btn primary" id="swft-pdf-send-btn" onclick="closePdfPreview();if(typeof sendQuote==='function')sendQuote();">Send to Customer</button>
      </div>
    </div>`;
  document.body.appendChild(pdfOverlay);

  pdfOverlay.addEventListener("click", (e) => {
    if (e.target === pdfOverlay) closePdfPreview();
  });

  window.closePdfPreview = function () {
    pdfOverlay.classList.remove("open");
  };

  window.printPdf = function () {
    const html = buildFullPrintHtml();
    const win = window.open("", "_blank");
    win.document.write(html);
    win.document.close();
    setTimeout(() => win.print(), 500);
  };

  // Build a full standalone HTML doc for PDF generation / printing
  window.buildFullPrintHtml = function () {
    const body = document.getElementById("swft-pdf-body");
    return `<html><head><title>SWFT Document</title>
      <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
      <style>
        body{font-family:'DM Sans',sans-serif;padding:40px;color:#111;max-width:700px;margin:0 auto;}
        .pdf-company{font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:3px;}
        .pdf-company em{color:#8ab800;font-style:normal;}
        img{max-height:50px;max-width:180px;object-fit:contain;}
        .pdf-tagline{font-size:10px;color:#999;letter-spacing:1.5px;margin-bottom:20px;}
        .pdf-type{font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:2px;padding-bottom:8px;border-bottom:2px solid #8ab800;margin-bottom:16px;}
        .pdf-row{display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px;}
        .label{color:#666;} .value{font-weight:500;}
        .pdf-section{margin-top:20px;margin-bottom:8px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#999;}
        .pdf-line-header{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;padding:8px 0;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#999;border-bottom:1px solid #e0e0e0;}
        .pdf-line{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;padding:10px 0;font-size:13px;border-bottom:1px solid #f0f0f0;}
        .amt{font-weight:500;}
        .pdf-total-row{display:flex;justify-content:space-between;padding:10px 0;font-size:14px;}
        .pdf-total-row.grand{font-size:18px;font-weight:700;border-top:2px solid #111;margin-top:4px;padding-top:12px;}
      </style></head><body>${body.innerHTML}</body></html>`;
  };

  window.showPdfPreview = function (type, data) {
    document.getElementById("swft-pdf-title").textContent = type === "invoice" ? "INVOICE PREVIEW" : "QUOTE PREVIEW";

    const lines = (data.lines || []).map((l) =>
      '<div class="pdf-line"><div>' + l.desc + '</div><div>' + (l.qty || "1") + '</div><div>' + (l.rate || "-") + '</div><div class="amt">' + l.total + '</div></div>'
    ).join("");

    const total = (data.lines || []).reduce((s, l) => s + (parseFloat(String(l.total || "").replace(/[$,]/g, "")) || 0), 0);

    const html = `
      ${(window._swftSettings && window._swftSettings.companyLogo) ? '<img src="' + window._swftSettings.companyLogo + '" style="max-height:50px;max-width:180px;object-fit:contain;margin-bottom:8px;"/>' : '<div class="pdf-company">' + ((window._swftSettings && window._swftSettings.company) || 'SWFT') + '<em>.</em></div>'}
      <div class="pdf-tagline">${(window._swftSettings && window._swftSettings.company) ? (window._swftSettings.phone || '') + ' &nbsp; ' + (window._swftSettings.address || '') : 'simple. smart. swft.'}</div>
      <div class="pdf-type">${type === "invoice" ? "INVOICE" : "QUOTE"} ${data.num || ""}</div>
      <div class="pdf-row"><span class="label">Customer</span><span class="value">${data.customer || "—"}</span></div>
      <div class="pdf-row"><span class="label">Job</span><span class="value">${data.job || "—"}</span></div>
      <div class="pdf-row"><span class="label">Address</span><span class="value">${data.address || "—"}</span></div>
      ${data.service ? '<div class="pdf-row"><span class="label">Service</span><span class="value">' + data.service + (data.sqft ? ' &nbsp;·&nbsp; ' + data.sqft + ' sqft' : '') + '</span></div>' : ""}
      <div class="pdf-row"><span class="label">Date</span><span class="value">${data.created || data.start || data.date || "—"}</span></div>
      ${data.finish ? '<div class="pdf-row"><span class="label">Notes</span><span class="value">' + data.finish + '</span></div>' : ""}
      ${data.expires ? '<div class="pdf-row"><span class="label">Expires</span><span class="value">' + data.expires + '</span></div>' : ""}
      ${data.due ? '<div class="pdf-row"><span class="label">Due Date</span><span class="value">' + data.due + '</span></div>' : ""}
      <div class="pdf-section">Line Items</div>
      <div class="pdf-line-header"><div>Description</div><div>Qty</div><div>Rate</div><div>Total</div></div>
      ${lines || '<div style="padding:12px 0;color:#999;">No line items</div>'}
      <div style="margin-top:12px;">
        <div class="pdf-total-row"><span>Subtotal</span><span>$${total.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span></div>
        <div class="pdf-total-row grand"><span>Total</span><span>$${total.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span></div>
      </div>
    `;

    document.getElementById("swft-pdf-body").innerHTML = html;
    pdfOverlay.classList.add("open");
  };
})();
