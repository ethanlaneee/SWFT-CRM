// ════════════════════════════════════════════════
// SWFT — Magnetic Button Effect
// Adds a subtle gravitational pull toward the cursor
// on elements with class .swft-magnetic
// Include via: <script src="swft-magnetic.js"></script>
// ════════════════════════════════════════════════

(function () {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const RADIUS = 20; // px — magnetic pull radius around button center
  const STRENGTH = 0.3; // 0–1 — how strongly the button follows the cursor

  document.addEventListener("mousemove", function (e) {
    const btns = document.querySelectorAll(".swft-magnetic");
    for (let i = 0; i < btns.length; i++) {
      const btn = btns[i];
      const rect = btn.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const zone = Math.max(rect.width, rect.height) / 2 + RADIUS;

      if (dist < zone) {
        const pull = (1 - dist / zone) * STRENGTH;
        btn.style.transform = "translate(" + (dx * pull) + "px," + (dy * pull) + "px)";
      } else if (btn.style.transform) {
        btn.style.transform = "";
      }
    }
  });

  // Reset on mouse leave from document
  document.addEventListener("mouseleave", function () {
    var btns = document.querySelectorAll(".swft-magnetic");
    for (var i = 0; i < btns.length; i++) btns[i].style.transform = "";
  });
})();
