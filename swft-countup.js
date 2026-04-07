// ════════════════════════════════════════════════
// SWFT — Number Counter Animation
// Animates numeric text content from 0 to final value.
// Usage: swftCountUp(element, targetValue, duration)
// Or auto: add data-countup on elements after setting textContent
// Include via: <script src="swft-countup.js"></script>
// ════════════════════════════════════════════════

(function () {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    window.swftCountUp = function (el, val) { el.textContent = val; };
    return;
  }

  window.swftCountUp = function (el, target, duration) {
    if (!el) return;
    duration = duration || 600;

    // Parse target — handle "$12,400" style strings
    var raw = String(target);
    var prefix = "";
    var suffix = "";
    var numStr = raw.replace(/[^0-9.\-]/g, "");
    var num = parseFloat(numStr);

    if (isNaN(num)) {
      el.textContent = raw;
      return;
    }

    // Extract prefix (e.g. "$") and suffix (e.g. "%")
    var match = raw.match(/^([^0-9\-]*)([\d,.\-]+)(.*)$/);
    if (match) {
      prefix = match[1];
      suffix = match[3];
    }

    var hasDecimal = numStr.indexOf(".") !== -1;
    var decimals = hasDecimal ? (numStr.split(".")[1] || "").length : 0;
    var useCommas = raw.indexOf(",") !== -1;
    var start = 0;
    var startTime = null;

    function format(n) {
      var s = hasDecimal ? n.toFixed(decimals) : Math.round(n).toString();
      if (useCommas) {
        var parts = s.split(".");
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        s = parts.join(".");
      }
      return prefix + s + suffix;
    }

    function step(ts) {
      if (!startTime) startTime = ts;
      var progress = Math.min((ts - startTime) / duration, 1);
      // Ease-out cubic
      var eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = format(start + (num - start) * eased);
      if (progress < 1) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
  };
})();
