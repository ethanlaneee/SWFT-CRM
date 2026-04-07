// ════════════════════════════════════════════════
// SWFT — Magnetic Buttons
// Include via: <script src="swft-magnetic.js"></script>
// ════════════════════════════════════════════════

(function () {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var RADIUS = 20;
  var STRENGTH = 0.3;

  document.addEventListener("mousemove", function (e) {
    var btns = document.querySelectorAll(".swft-magnetic");
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var rect = btn.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var dx = e.clientX - cx;
      var dy = e.clientY - cy;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var zone = Math.max(rect.width, rect.height) / 2 + RADIUS;

      if (dist < zone) {
        var pull = (1 - dist / zone) * STRENGTH;
        btn.style.transform = "translate(" + (dx * pull) + "px," + (dy * pull) + "px)";
      } else if (btn.style.transform) {
        btn.style.transform = "";
      }
    }
  });

  document.addEventListener("mouseleave", function () {
    var btns = document.querySelectorAll(".swft-magnetic");
    for (var i = 0; i < btns.length; i++) btns[i].style.transform = "";
  });
})();
