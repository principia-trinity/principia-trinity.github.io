/* The imagination engine: a damped harmonograph, seeded once per visit.
   The seed is 64 bits wide — 2^64 curves — so, almost surely, no two
   readings share one. Axiom 2 holds in the measure-theoretic sense. */
(function () {
  "use strict";

  var canvas = document.getElementById("engine");
  var button = document.getElementById("fig-button");
  var seedEl = document.getElementById("seed");
  if (!canvas || !canvas.getContext || !button) return;

  var ctx = canvas.getContext("2d");
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var PAPER = "#10141a";
  var INK = "rgba(231, 225, 211, 0.42)";
  var STEP = 0.006;
  var POINTS_PER_FRAME = 700;
  var FILL = 0.86;
  var MAX_STRETCH = 2.5;

  function sfc32(a, b, c, d) {
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      var t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = ((c << 21) | (c >>> 11)) | 0;
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  function makeRng(seed) {
    var rng = sfc32(seed.hi, seed.lo, seed.hi ^ 0x9e3779b9, seed.lo ^ 0x85ebca6b);
    for (var i = 0; i < 12; i++) rng();
    return rng;
  }

  function freshSeed() {
    if (window.crypto && window.crypto.getRandomValues) {
      var buf = new Uint32Array(2);
      window.crypto.getRandomValues(buf);
      return { hi: buf[0], lo: buf[1] };
    }
    // Math.imul keeps the multiply in 32-bit integer space; a plain float
    // product this large would zero the low 20 bits of the seed.
    var t = Date.now();
    var u = (typeof performance !== "undefined" && performance.now)
      ? Math.floor(performance.now() * 1000) : 0;
    return {
      hi: Math.imul(t >>> 0, 2654435761) >>> 0,
      lo: Math.imul((u ^ ((t / 4294967296) >>> 0)) >>> 0, 2246822519) >>> 0
    };
  }

  function seedHex(seed) {
    return "0x" + seed.hi.toString(16).padStart(8, "0")
      + seed.lo.toString(16).padStart(8, "0");
  }

  /* Four damped pendulums: two per axis, frequencies near small integers. */
  function makeCurve(seed) {
    var rnd = makeRng(seed);
    function pendulum() {
      return {
        amp: 0.35 + rnd() * 0.6,
        freq: (1 + Math.floor(rnd() * 4)) + (rnd() - 0.5) * 0.04,
        phase: rnd() * Math.PI * 2,
        damp: 0.003 + rnd() * 0.006
      };
    }
    var px1 = pendulum(), px2 = pendulum();
    var py1 = pendulum(), py2 = pendulum();
    var slowest = Math.min(px1.damp, px2.damp, py1.damp, py2.damp);
    var tMax = Math.log(1 / 0.012) / slowest;
    function term(p, t) {
      return p.amp * Math.sin(p.freq * t + p.phase) * Math.exp(-p.damp * t);
    }
    return {
      tMax: tMax,
      at: function (t) {
        return {
          x: (term(px1, t) + term(px2, t)) / 2,
          y: (term(py1, t) + term(py2, t)) / 2
        };
      }
    };
  }

  function measure(curve) {
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var t = 0; t <= curve.tMax; t += STEP * 8) {
      var p = curve.at(t);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
  }

  /* Fit the curve's bounding box to FILL of the frame. Anisotropic, like a
     real harmonograph plate, but capped so degenerate curves don't smear. */
  function makeTransform(b) {
    var w = (b.maxX - b.minX) || 1;
    var h = (b.maxY - b.minY) || 1;
    var sx = (canvas.width * FILL) / w;
    var sy = (canvas.height * FILL) / h;
    if (sx > sy * MAX_STRETCH) sx = sy * MAX_STRETCH;
    if (sy > sx * MAX_STRETCH) sy = sx * MAX_STRETCH;
    return {
      sx: sx,
      sy: sy,
      ox: canvas.width / 2 - ((b.minX + b.maxX) / 2) * sx,
      oy: canvas.height / 2 - ((b.minY + b.maxY) / 2) * sy
    };
  }

  var state = {
    seed: freshSeed(),
    curve: null,
    transform: null,
    t: 0,
    raf: 0
  };

  function fitCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width * dpr));
    var h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function backingSizeUnchanged() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var rect = canvas.getBoundingClientRect();
    return canvas.width === Math.max(1, Math.round(rect.width * dpr))
      && canvas.height === Math.max(1, Math.round(rect.height * dpr));
  }

  function clear() {
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function project(pt) {
    var T = state.transform;
    return { x: pt.x * T.sx + T.ox, y: pt.y * T.sy + T.oy };
  }

  function drawSegment(fromT, toT) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(0.6, canvas.width / 1400);
    ctx.beginPath();
    var start = project(state.curve.at(fromT));
    ctx.moveTo(start.x, start.y);
    for (var t = fromT + STEP; t <= toT; t += STEP) {
      var p = project(state.curve.at(t));
      ctx.lineTo(p.x, p.y);
    }
    // Float accumulation can overshoot toT; close the chunk exactly so
    // consecutive segments join without gaps.
    var end = project(state.curve.at(toT));
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }

  function tick() {
    var next = Math.min(state.t + STEP * POINTS_PER_FRAME, state.curve.tMax);
    drawSegment(state.t, next);
    state.t = next;
    if (state.t < state.curve.tMax) {
      state.raf = window.requestAnimationFrame(tick);
    }
  }

  function render(animate) {
    window.cancelAnimationFrame(state.raf);
    fitCanvas();
    clear();
    state.curve = makeCurve(state.seed);
    state.transform = makeTransform(measure(state.curve));
    state.t = 0;
    if (seedEl) seedEl.textContent = seedHex(state.seed);
    if (animate && !reducedMotion.matches) {
      state.raf = window.requestAnimationFrame(tick);
    } else {
      // Chunked so a single stroke path never grows unbounded.
      var chunk = STEP * POINTS_PER_FRAME * 4;
      for (var t = 0; t < state.curve.tMax; t += chunk) {
        drawSegment(t, Math.min(t + chunk, state.curve.tMax));
      }
      state.t = state.curve.tMax;
    }
  }

  var resizeTimer = 0;

  button.addEventListener("click", function () {
    window.clearTimeout(resizeTimer);
    state.seed = freshSeed();
    render(true);
  });

  window.addEventListener("resize", function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      // Mobile URL-bar show/hide fires resize without changing layout;
      // don't cut a drawing animation short for it.
      if (backingSizeUnchanged()) return;
      render(false);
    }, 150);
  });

  function onMotionPreferenceChange() {
    if (reducedMotion.matches && state.t < state.curve.tMax) render(false);
  }
  if (reducedMotion.addEventListener) {
    reducedMotion.addEventListener("change", onMotionPreferenceChange);
  }

  button.removeAttribute("disabled");
  render(true);
})();
