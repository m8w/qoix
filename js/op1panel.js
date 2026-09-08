/* ============================================================
   QOIX — OP-1 Phase panel
   ============================================================
   The hardware-style front end for the OP1Phase engine: an
   animated display, four colour-coded encoders and four pages.

   Everything the user can touch is driven by the PAGES table
   below — each page names four knobs (blue, green, white,
   orange, left to right, as on the hardware) and each knob
   knows how to read and write one engine parameter. Adding a
   page or re-assigning a knob means editing that table only.
   ============================================================ */

'use strict';

const OP1Panel = (() => {

  const $ = id => document.getElementById(id);
  const C = OP1Phase.getColors();
  const ORDER = ['blue', 'green', 'white', 'orange'];

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  const ms   = v => v < 1 ? Math.round(v * 1000) + 'ms' : v.toFixed(2) + 's';
  const pct  = v => Math.round(v * 100) + '';
  const cent = v => (v > 0 ? '+' : '') + Math.round(v);
  const hz   = v => v < 10 ? v.toFixed(2) : Math.round(v) + '';
  const deg  = v => Math.round(v * 360) + '°';

  // ── Pages ─────────────────────────────────────────────────
  // get(s) reads the engine state; set(v) writes through the engine
  // so live voices follow the knob.
  const PAGES = [
    {
      id: 'synth', name: 'synth',
      knobs: [
        { label: 'shape',  min: 0,     max: 1,    def: 0.35, fmt: pct,
          get: s => s.shape,  set: v => OP1Phase.setParam('shape',  v) },
        { label: 'shift',  min: 0,     max: 1,    def: 0.00, fmt: deg,
          get: s => s.shift,  set: v => OP1Phase.setParam('shift',  v) },
        { label: 'detune', min: -1200, max: 1200, def: 7,    fmt: cent,
          get: s => s.detune, set: v => OP1Phase.setParam('detune', v) },
        { label: 'mix',    min: 0,     max: 1,    def: 0.50, fmt: pct,
          get: s => s.mix,    set: v => OP1Phase.setParam('mix',    v) },
      ],
    },
    {
      id: 'envelope', name: 'envelope',
      knobs: [
        { label: 'attack',  min: 0.001, max: 4, def: 0.008, curve: 3, fmt: ms,
          get: s => s.env.attack,  set: v => OP1Phase.setEnv('attack',  v) },
        { label: 'decay',   min: 0.005, max: 6, def: 0.30,  curve: 3, fmt: ms,
          get: s => s.env.decay,   set: v => OP1Phase.setEnv('decay',   v) },
        { label: 'sustain', min: 0,     max: 1, def: 0.65,  fmt: pct,
          get: s => s.env.sustain, set: v => OP1Phase.setEnv('sustain', v) },
        { label: 'release', min: 0.01,  max: 8, def: 0.45,  curve: 3, fmt: ms,
          get: s => s.env.release, set: v => OP1Phase.setEnv('release', v) },
      ],
    },
    {
      id: 'fx', name: 'fx',
      knobs: [
        { label: 'drive',  min: 0, max: 1, def: 0.12, fmt: pct,
          get: s => s.fx.drive,  set: v => OP1Phase.setFX('drive',  v) },
        { label: 'cutoff', min: 0, max: 1, def: 0.80,
          fmt: v => Math.round(60 * Math.pow(300, v)) + 'Hz',
          get: s => s.fx.cutoff, set: v => OP1Phase.setFX('cutoff', v) },
        { label: 'res',    min: 0, max: 1, def: 0.10, fmt: pct,
          get: s => s.fx.res,    set: v => OP1Phase.setFX('res',    v) },
        { label: 'level',  min: 0, max: 1, def: 0.80, fmt: pct,
          get: s => s.fx.level,  set: v => OP1Phase.setFX('level',  v) },
      ],
    },
    {
      id: 'lfo', name: 'lfo',
      knobs: [
        { label: 'rate',  min: 0.05, max: 24, def: 3.2, curve: 3, fmt: hz,
          get: s => s.lfo.rate,  set: v => OP1Phase.setLFO('rate',  v) },
        { label: 'depth', min: 0, max: 1, def: 0, fmt: pct,
          get: s => s.lfo.depth, set: v => OP1Phase.setLFO('depth', v) },
        { label: 'dest',  steps: OP1Phase.lfoOptions().dests,  def: 'shape',
          get: s => s.lfo.dest,  set: v => OP1Phase.setLFO('dest',  v) },
        { label: 'shape', steps: OP1Phase.lfoOptions().shapes, def: 'sine',
          get: s => s.lfo.shape, set: v => OP1Phase.setLFO('shape', v) },
      ],
    },
  ];

  // ── Factory patches for this engine ───────────────────────
  const FACTORY = [
    { name: 'init',
      shape: 0.35, shift: 0,    detune: 7,   mix: 0.5,
      env: { attack: 0.008, decay: 0.30, sustain: 0.65, release: 0.45 },
      fx:  { drive: 0.12, cutoff: 0.80, res: 0.10, level: 0.80 },
      lfo: { rate: 3.2, depth: 0, dest: 'shape', shape: 'sine' } },

    { name: 'glass keys',
      shape: 0.22, shift: 0.25, detune: 1203, mix: 0.42,
      env: { attack: 0.004, decay: 0.9, sustain: 0.12, release: 1.1 },
      fx:  { drive: 0.05, cutoff: 0.88, res: 0.05, level: 0.82 },
      lfo: { rate: 0.6, depth: 0.12, dest: 'shape', shape: 'triangle' } },

    { name: 'phase bass',
      shape: 0.68, shift: 0.5,  detune: -12, mix: 0.55,
      env: { attack: 0.002, decay: 0.22, sustain: 0.45, release: 0.18 },
      fx:  { drive: 0.35, cutoff: 0.45, res: 0.28, level: 0.85 },
      lfo: { rate: 0.05, depth: 0, dest: 'cutoff', shape: 'sine' } },

    { name: 'drifting pad',
      shape: 0.45, shift: 0.33, detune: 9,   mix: 0.5,
      env: { attack: 0.9, decay: 1.6, sustain: 0.8, release: 2.4 },
      fx:  { drive: 0.08, cutoff: 0.62, res: 0.16, level: 0.7 },
      lfo: { rate: 0.22, depth: 0.42, dest: 'shift', shape: 'sine' } },

    { name: 'hollow lead',
      shape: 0.82, shift: 0.5,  detune: 4,   mix: 0.5,
      env: { attack: 0.01, decay: 0.35, sustain: 0.7, release: 0.3 },
      fx:  { drive: 0.28, cutoff: 0.74, res: 0.34, level: 0.75 },
      lfo: { rate: 5.4, depth: 0.16, dest: 'pitch', shape: 'sine' } },

    { name: 'bell metal',
      shape: 0.55, shift: 0.17, detune: 704, mix: 0.48,
      env: { attack: 0.001, decay: 1.4, sustain: 0.05, release: 1.6 },
      fx:  { drive: 0.14, cutoff: 0.92, res: 0.08, level: 0.72 },
      lfo: { rate: 0.05, depth: 0, dest: 'shape', shape: 'sine' } },

    { name: 'stepped motion',
      shape: 0.4,  shift: 0.12, detune: 19,  mix: 0.5,
      env: { attack: 0.006, decay: 0.5, sustain: 0.6, release: 0.5 },
      fx:  { drive: 0.2, cutoff: 0.7, res: 0.2, level: 0.78 },
      lfo: { rate: 7.5, depth: 0.65, dest: 'shape', shape: 'random' } },

    { name: 'sub drone',
      shape: 0.12, shift: 0.5,  detune: -1195, mix: 0.5,
      env: { attack: 1.4, decay: 2, sustain: 0.9, release: 3 },
      fx:  { drive: 0.1, cutoff: 0.38, res: 0.06, level: 0.9 },
      lfo: { rate: 0.12, depth: 0.3, dest: 'cutoff', shape: 'triangle' } },
  ];

  // ── Normalised ↔ real value mapping ───────────────────────
  // curve > 1 gives an exponential feel (time and frequency knobs).
  function toNorm(k, value) {
    if (k.steps) {
      const i = Math.max(0, k.steps.indexOf(value));
      return k.steps.length < 2 ? 0 : i / (k.steps.length - 1);
    }
    const t = (value - k.min) / (k.max - k.min);
    return clamp(k.curve ? Math.pow(clamp(t, 0, 1), 1 / k.curve) : t, 0, 1);
  }

  function fromNorm(k, n) {
    n = clamp(n, 0, 1);
    if (k.steps) return k.steps[Math.round(n * (k.steps.length - 1))];
    const t = k.curve ? Math.pow(n, k.curve) : n;
    return k.min + t * (k.max - k.min);
  }

  function display(k, value) {
    return k.steps ? String(value) : k.fmt(value);
  }

  // ── Encoder rendering ─────────────────────────────────────
  const knobEls = [];      // { wrap, canvas, ctx, valueEl, labelEl }
  const KNOB_PX = 78;

  function drawKnob(i) {
    const el = knobEls[i];
    if (!el) return;
    const k     = PAGES[state.page].knobs[i];
    const s     = OP1Phase.getState();
    const norm  = toNorm(k, k.get(s));
    const color = C[ORDER[i]];
    const g     = el.ctx;
    const dpr   = el.dpr;
    const size  = KNOB_PX;

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);

    const cx = size / 2, cy = size / 2;
    const r  = size / 2 - 9;
    const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25;

    // track
    g.lineWidth = 5;
    g.lineCap   = 'round';
    g.strokeStyle = '#1d2a26';
    g.beginPath(); g.arc(cx, cy, r, A0, A1); g.stroke();

    // value arc
    const ang = A0 + (A1 - A0) * norm;
    g.strokeStyle = color;
    g.shadowColor = color;
    g.shadowBlur  = 9;
    g.beginPath(); g.arc(cx, cy, r, A0, Math.max(A0 + 0.001, ang)); g.stroke();
    g.shadowBlur = 0;

    // body
    const grad = g.createLinearGradient(0, cy - r, 0, cy + r);
    grad.addColorStop(0, '#2b3a35');
    grad.addColorStop(1, '#111a17');
    g.fillStyle = grad;
    g.beginPath(); g.arc(cx, cy, r - 6, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#0a0f0d'; g.lineWidth = 1; g.stroke();

    // pointer
    g.strokeStyle = color;
    g.lineWidth   = 3;
    g.beginPath();
    g.moveTo(cx + Math.cos(ang) * (r - 17), cy + Math.sin(ang) * (r - 17));
    g.lineTo(cx + Math.cos(ang) * (r - 6),  cy + Math.sin(ang) * (r - 6));
    g.stroke();
  }

  function refreshKnobs() {
    const s = OP1Phase.getState();
    PAGES[state.page].knobs.forEach((k, i) => {
      const el = knobEls[i];
      if (!el) return;
      const shown = display(k, k.get(s));
      el.labelEl.textContent = k.label;
      el.valueEl.textContent = shown;
      el.wrap.setAttribute('aria-label', k.label + ': ' + shown);
      el.wrap.setAttribute('aria-valuetext', shown);
      drawKnob(i);
    });
  }

  // ── Encoder interaction ───────────────────────────────────
  function bindEncoder(i, wrap) {
    const knob = () => PAGES[state.page].knobs[i];

    function nudge(deltaNorm) {
      const k = knob();
      const s = OP1Phase.getState();
      const n = clamp(toNorm(k, k.get(s)) + deltaNorm, 0, 1);
      k.set(fromNorm(k, n));
      refreshKnobs();
    }

    let dragging = false, lastY = 0, acc = 0;

    wrap.addEventListener('pointerdown', e => {
      dragging = true; lastY = e.clientY; acc = 0;
      try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
      wrap.classList.add('turning');
      e.preventDefault();
    });

    wrap.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dy   = lastY - e.clientY;
      lastY      = e.clientY;
      const k    = knob();
      // Continuous knobs travel the full range over ~200px of drag,
      // a fifth of that with shift held. Stepped knobs need a
      // deliberate throw before they advance a step.
      const gain = e.shiftKey ? 0.001 : 0.005;
      if (k.steps) {
        acc += dy * gain * 0.6;
        const stepN = 1 / (k.steps.length - 1);
        while (Math.abs(acc) >= stepN) {
          nudge(Math.sign(acc) * stepN);
          acc -= Math.sign(acc) * stepN;
        }
      } else {
        nudge(dy * gain);
      }
    });

    const end = e => {
      if (!dragging) return;
      dragging = false;
      wrap.classList.remove('turning');
      try { wrap.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);

    wrap.addEventListener('wheel', e => {
      e.preventDefault();
      const k = knob();
      const step = k.steps ? 1 / (k.steps.length - 1) : (e.shiftKey ? 0.005 : 0.02);
      nudge(e.deltaY < 0 ? step : -step);
    }, { passive: false });

    wrap.addEventListener('dblclick', () => {
      const k = knob();
      k.set(k.def);
      refreshKnobs();
    });

    wrap.addEventListener('keydown', e => {
      const k = knob();
      const step = k.steps ? 1 / (k.steps.length - 1) : (e.shiftKey ? 0.005 : 0.02);
      if (e.key === 'ArrowUp'   || e.key === 'ArrowRight') { nudge(step);  e.preventDefault(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft')  { nudge(-step); e.preventDefault(); }
      if (e.key === 'Home') { k.set(k.def); refreshKnobs(); e.preventDefault(); }
    });
  }

  function buildEncoders() {
    const host = $('op1-encoders');
    if (!host) return;
    host.innerHTML = '';
    knobEls.length = 0;

    ORDER.forEach((color, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'op1-knob op1-knob-' + color;
      wrap.tabIndex  = 0;
      wrap.setAttribute('role', 'slider');

      const cv  = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 1;
      cv.width  = KNOB_PX * dpr;
      cv.height = KNOB_PX * dpr;
      cv.style.width  = KNOB_PX + 'px';
      cv.style.height = KNOB_PX + 'px';

      const label = document.createElement('div');
      label.className = 'op1-knob-label';
      const value = document.createElement('div');
      value.className = 'op1-knob-value';
      value.style.color = C[color];

      wrap.appendChild(label);
      wrap.appendChild(cv);
      wrap.appendChild(value);
      host.appendChild(wrap);

      knobEls.push({ wrap, canvas: cv, ctx: cv.getContext('2d'), dpr, labelEl: label, valueEl: value });
      bindEncoder(i, wrap);
    });
  }

  // ── Page buttons ──────────────────────────────────────────
  function buildPages() {
    const host = $('op1-pages');
    if (!host) return;
    host.innerHTML = '';
    PAGES.forEach((p, i) => {
      const b = document.createElement('button');
      b.className = 'op1-page-btn' + (i === state.page ? ' active' : '');
      b.dataset.page = i;
      b.innerHTML = '<span class="op1-page-num">' + (i + 1) + '</span>' + p.name;
      b.addEventListener('click', () => setPage(i));
      host.appendChild(b);
    });
  }

  function setPage(i) {
    state.page = clamp(i, 0, PAGES.length - 1);
    OP1Phase.setPage(state.page);
    document.querySelectorAll('.op1-page-btn').forEach((b, n) =>
      b.classList.toggle('active', n === state.page));
    refreshKnobs();
  }

  // ── Display ───────────────────────────────────────────────
  const state = { page: 0, anim: 0, last: 0, raf: 0 };
  let screen = null, sctx = null, sw = 0, sh = 0, sdpr = 1;

  function resizeScreen() {
    if (!screen) return;
    const rect = screen.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    sdpr = window.devicePixelRatio || 1;
    sw = rect.width; sh = rect.height;
    screen.width  = Math.round(sw * sdpr);
    screen.height = Math.round(sh * sdpr);
    sctx.setTransform(sdpr, 0, 0, sdpr, 0, 0);
  }

  const waveBuf = new Float32Array(512);

  function drawScreen(dt) {
    if (!sctx || !sw) return;
    const s = OP1Phase.getState();
    const g = sctx;

    g.setTransform(sdpr, 0, 0, sdpr, 0, 0);
    g.fillStyle = '#080c0a';
    g.fillRect(0, 0, sw, sh);

    // faint grid
    g.strokeStyle = 'rgba(90,140,125,0.09)';
    g.lineWidth = 1;
    for (let x = 0; x < sw; x += 40) {
      g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, sh); g.stroke();
    }
    for (let y = 0; y < sh; y += 40) {
      g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(sw, y + 0.5); g.stroke();
    }

    const readoutH = 30;
    const area = { x: 14, y: 24, w: sw - 28, h: sh - readoutH - 40 };

    if      (state.page === 0) drawSynthPage(g, area, s, dt);
    else if (state.page === 1) drawEnvPage(g, area, s);
    else if (state.page === 2) drawFXPage(g, area, s);
    else                       drawLFOPage(g, area, s, dt);

    drawReadouts(g, s);
    drawStatus(g, s);
  }

  // Page 1 — waveform, and the phase relationship between the two oscillators
  function drawSynthPage(g, a, s, dt) {
    state.anim += dt * 0.35;

    const discR = Math.min(a.h * 0.42, a.w * 0.16);
    const waveW = a.w - discR * 2 - 34;
    const midY  = a.y + a.h / 2;

    // waveform
    OP1Phase.renderCycle(waveBuf, state.anim * 0.4);
    g.lineWidth   = 2.2;
    g.lineJoin    = 'round';
    g.strokeStyle = C.white;
    g.shadowColor = 'rgba(120,200,180,0.55)';
    g.shadowBlur  = 8;
    g.beginPath();
    for (let i = 0; i < waveBuf.length; i++) {
      const x = a.x + (i / (waveBuf.length - 1)) * waveW;
      const y = midY - waveBuf[i] * (a.h * 0.36);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.shadowBlur = 0;

    // zero line
    g.strokeStyle = 'rgba(150,200,185,0.18)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(a.x, midY); g.lineTo(a.x + waveW, midY); g.stroke();

    // phase circle — one dot per oscillator, the chord shows the offset
    const cx = a.x + a.w - discR - 6;
    const cy = midY;
    g.strokeStyle = 'rgba(150,200,185,0.28)';
    g.lineWidth = 1.5;
    g.beginPath(); g.arc(cx, cy, discR, 0, Math.PI * 2); g.stroke();

    const ratio = Math.pow(2, s.detune / 1200);
    const pA = state.anim % 1;
    const pB = (state.anim * ratio + s.shift) % 1;
    const angA = -Math.PI / 2 + pA * Math.PI * 2;
    const angB = -Math.PI / 2 + pB * Math.PI * 2;
    const ax = cx + Math.cos(angA) * discR, ay = cy + Math.sin(angA) * discR;
    const bx = cx + Math.cos(angB) * discR, by = cy + Math.sin(angB) * discR;

    g.strokeStyle = C.green;
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();

    const gA = Math.cos(s.mix * Math.PI * 0.5), gB = Math.sin(s.mix * Math.PI * 0.5);
    dot(g, ax, ay, 4 + gA * 4, C.blue);
    dot(g, bx, by, 4 + gB * 4, C.orange);

    g.font = '600 10px ui-monospace, Menlo, Consolas, monospace';
    g.fillStyle = 'rgba(150,200,185,0.5)';
    g.textAlign = 'center';
    g.fillText('phase', cx, cy + discR + 14);
    g.textAlign = 'left';
  }

  function dot(g, x, y, r, color) {
    g.fillStyle = color;
    g.shadowColor = color; g.shadowBlur = 12;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0;
  }

  // Page 2 — the ADSR contour, each stage in its own knob colour
  function drawEnvPage(g, a, s) {
    const e = s.env;
    const total = e.attack + e.decay + Math.min(2, e.release) + 0.6;
    const px = t => a.x + (t / total) * a.w;
    const py = v => a.y + a.h - v * a.h * 0.88 - a.h * 0.06;

    const tA = e.attack, tD = tA + e.decay, tS = tD + 0.6, tR = tS + Math.min(2, e.release);
    const segs = [
      { from: [0, 0],           to: [tA, 1],         color: C.blue,   label: 'A' },
      { from: [tA, 1],          to: [tD, e.sustain], color: C.green,  label: 'D' },
      { from: [tD, e.sustain],  to: [tS, e.sustain], color: C.white,  label: 'S' },
      { from: [tS, e.sustain],  to: [tR, 0],         color: C.orange, label: 'R' },
    ];

    g.lineWidth = 2.6;
    g.lineJoin  = 'round';
    g.lineCap   = 'round';
    g.font      = '700 11px ui-monospace, Menlo, Consolas, monospace';
    segs.forEach(sg => {
      g.strokeStyle = sg.color;
      g.shadowColor = sg.color; g.shadowBlur = 7;
      g.beginPath();
      g.moveTo(px(sg.from[0]), py(sg.from[1]));
      g.lineTo(px(sg.to[0]),   py(sg.to[1]));
      g.stroke();
      g.shadowBlur = 0;
      g.fillStyle  = sg.color;
      const mx = (px(sg.from[0]) + px(sg.to[0])) / 2;
      const my = (py(sg.from[1]) + py(sg.to[1])) / 2;
      g.fillText(sg.label, mx - 3, Math.min(a.y + a.h - 2, my + 18));
    });

    // sustain-gate marker
    g.strokeStyle = 'rgba(150,200,185,0.22)';
    g.setLineDash([3, 4]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(px(tS), a.y); g.lineTo(px(tS), a.y + a.h); g.stroke();
    g.setLineDash([]);

    g.fillStyle = 'rgba(150,200,185,0.5)';
    g.font = '600 10px ui-monospace, Menlo, Consolas, monospace';
    g.fillText('key up', px(tS) + 4, a.y + 11);
  }

  // Page 3 — filter response, with the drive transfer curve inset
  function drawFXPage(g, a, s) {
    const f  = s.fx;
    const fc = 60 * Math.pow(300, f.cutoff);
    const Q  = 0.7 + f.res * 22;
    const fMin = 20, fMax = 20000;
    const lx = v => Math.log(v / fMin) / Math.log(fMax / fMin);

    g.strokeStyle = C.green;
    g.lineWidth   = 2.4;
    g.shadowColor = C.green; g.shadowBlur = 7;
    g.beginPath();
    const N = 220;
    for (let i = 0; i < N; i++) {
      const fr = fMin * Math.pow(fMax / fMin, i / (N - 1));
      // 2-pole lowpass magnitude
      const w  = fr / fc;
      const m  = 1 / Math.sqrt(Math.pow(1 - w * w, 2) + Math.pow(w / Q, 2));
      const db = 20 * Math.log10(Math.max(1e-4, m));
      const x  = a.x + lx(fr) * a.w;
      const y  = clamp(a.y + a.h * 0.55 - (db / 48) * a.h * 0.9, a.y + 2, a.y + a.h - 2);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.shadowBlur = 0;

    // cutoff marker
    const cxp = a.x + lx(fc) * a.w;
    g.strokeStyle = 'rgba(150,200,185,0.3)';
    g.setLineDash([3, 4]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(cxp, a.y); g.lineTo(cxp, a.y + a.h); g.stroke();
    g.setLineDash([]);

    // frequency ticks
    g.fillStyle = 'rgba(150,200,185,0.45)';
    g.font = '600 9px ui-monospace, Menlo, Consolas, monospace';
    [100, 1000, 10000].forEach(fr => {
      g.fillText(fr >= 1000 ? (fr / 1000) + 'k' : String(fr), a.x + lx(fr) * a.w - 6, a.y + a.h - 4);
    });

    // drive transfer curve, top-left inset
    const iw = Math.min(72, a.w * 0.18), ix = a.x + 4, iy = a.y + 4;
    g.strokeStyle = 'rgba(150,200,185,0.22)';
    g.lineWidth = 1;
    g.strokeRect(ix, iy, iw, iw);
    const k = f.drive * f.drive * 60;
    g.strokeStyle = C.blue;
    g.lineWidth = 1.8;
    g.beginPath();
    for (let i = 0; i <= 40; i++) {
      const x = (i / 40) * 2 - 1;
      const y = k < 0.001 ? x : ((1 + k) * x) / (1 + k * Math.abs(x));
      const px2 = ix + ((x + 1) / 2) * iw;
      const py2 = iy + iw - ((y + 1) / 2) * iw;
      i ? g.lineTo(px2, py2) : g.moveTo(px2, py2);
    }
    g.stroke();
    g.fillStyle = 'rgba(150,200,185,0.45)';
    g.fillText('drive', ix + 2, iy + iw + 10);

    // output level bar, right edge
    const bh = a.h * 0.7, bx = a.x + a.w - 8, by = a.y + (a.h - bh) / 2;
    g.fillStyle = 'rgba(150,200,185,0.15)';
    g.fillRect(bx, by, 6, bh);
    g.fillStyle = C.orange;
    g.fillRect(bx, by + bh * (1 - f.level), 6, bh * f.level);
  }

  // Page 4 — the LFO shape, scrolling at its own rate
  function drawLFOPage(g, a, s, dt) {
    const l = s.lfo;
    state.anim += dt * l.rate;

    const midY = a.y + a.h / 2;
    const cycles = 3;
    const N = 300;

    const shapeAt = p => {
      p -= Math.floor(p);
      switch (l.shape) {
        case 'triangle': return p < 0.5 ? (p * 4 - 1) : (3 - p * 4);
        case 'sawtooth': return p * 2 - 1;
        case 'square':   return p < 0.5 ? 1 : -1;
        case 'random':   return randomStep(Math.floor(p * 8));
        default:         return Math.sin(p * Math.PI * 2);
      }
    };

    g.strokeStyle = C.green;
    g.lineWidth   = 2.4;
    g.lineJoin    = 'round';
    g.shadowColor = C.green; g.shadowBlur = 7;
    g.beginPath();
    for (let i = 0; i < N; i++) {
      const p = (i / (N - 1)) * cycles + state.anim;
      const x = a.x + (i / (N - 1)) * a.w;
      const y = midY - shapeAt(p) * (a.h * 0.36) * Math.max(0.04, l.depth);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.shadowBlur = 0;

    // full-depth guides
    g.strokeStyle = 'rgba(150,200,185,0.16)';
    g.setLineDash([2, 5]); g.lineWidth = 1;
    [-1, 0, 1].forEach(v => {
      const y = midY - v * a.h * 0.36;
      g.beginPath(); g.moveTo(a.x, y); g.lineTo(a.x + a.w, y); g.stroke();
    });
    g.setLineDash([]);

    const caption = '→ ' + l.dest;
    g.font = '700 13px ui-monospace, Menlo, Consolas, monospace';
    const capW = Math.max(g.measureText(caption).width, 46) + 12;
    g.fillStyle = '#080c0a';
    g.fillRect(a.x, a.y + 2, capW, 32);
    g.fillStyle = C.white;
    g.fillText(caption, a.x + 6, a.y + 15);
    g.fillStyle = 'rgba(150,200,185,0.5)';
    g.font = '600 10px ui-monospace, Menlo, Consolas, monospace';
    g.fillText(l.shape, a.x + 6, a.y + 29);
  }

  // Stable pseudo-random steps so the drawn S&H does not flicker
  const _rndCache = {};
  function randomStep(i) {
    if (_rndCache[i] === undefined) {
      const x = Math.sin(i * 127.1) * 43758.5453;
      _rndCache[i] = (x - Math.floor(x)) * 2 - 1;
    }
    return _rndCache[i];
  }

  // Four values along the bottom, each above the knob that sets it
  function drawReadouts(g, s) {
    const knobs = PAGES[state.page].knobs;
    const y = sh - 9;
    g.textAlign = 'center';
    knobs.forEach((k, i) => {
      const cx = (sw / 4) * (i + 0.5);
      g.font = '700 13px ui-monospace, Menlo, Consolas, monospace';
      g.fillStyle = C[ORDER[i]];
      g.fillText(display(k, k.get(s)), cx, y);
      g.font = '600 9px ui-monospace, Menlo, Consolas, monospace';
      g.fillStyle = 'rgba(150,200,185,0.5)';
      g.fillText(k.label, cx, y - 14);
    });
    g.textAlign = 'left';
  }

  function drawStatus(g, s) {
    const n = OP1Phase.getActiveVoices().size;
    g.font = '700 10px ui-monospace, Menlo, Consolas, monospace';
    g.textAlign = 'right';
    g.fillStyle = s.enabled ? (n ? C.green : 'rgba(150,200,185,0.45)') : 'rgba(210,100,100,0.8)';
    g.fillText(s.enabled ? (n ? n + ' voice' + (n > 1 ? 's' : '') : 'ready') : 'engine off', sw - 12, 16);
    g.textAlign = 'left';
    g.fillStyle = 'rgba(150,200,185,0.35)';
    g.fillText(PAGES[state.page].name, 14, 16);
  }

  // ── Animation loop ────────────────────────────────────────
  function frame(now) {
    state.raf = requestAnimationFrame(frame);
    const dt = state.last ? Math.min(0.05, (now - state.last) / 1000) : 0;
    state.last = now;

    const panel = $('tab-op1');
    if (!panel || !panel.classList.contains('active') || document.hidden) return;
    if (screen && Math.abs(screen.getBoundingClientRect().width - sw) > 1) resizeScreen();
    drawScreen(dt);
  }

  // ── Patch selector ────────────────────────────────────────
  function buildPatchList() {
    const sel = $('op1-patch-select');
    if (!sel) return;
    sel.innerHTML = '';
    FACTORY.forEach((p, i) => {
      const o = document.createElement('option');
      o.value = i; o.textContent = p.name;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      OP1Phase.setPatch(FACTORY[parseInt(sel.value, 10)]);
      refreshKnobs();
    });
  }

  // A hidden checkbox keeps focus after its label is clicked, so
  // "is an INPUT focused" is too blunt a guard — only controls that
  // actually consume typed characters should swallow these keys.
  function isTextEntry(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return tag === 'INPUT' && !/^(checkbox|radio|range|button|submit|reset|file)$/i.test(el.type);
  }

  // ── Keyboard: 1–4 switch pages while this tab is open ──────
  function bindPageKeys() {
    document.addEventListener('keydown', e => {
      if (isTextEntry(e.target)) return;
      const panel = $('tab-op1');
      if (!panel || !panel.classList.contains('active')) return;
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= PAGES.length) { setPage(n - 1); e.preventDefault(); }
    });
  }

  // ── Init ──────────────────────────────────────────────────
  function init() {
    screen = $('op1-display');
    if (!screen) return;
    sctx = screen.getContext('2d');

    buildEncoders();
    buildPages();
    buildPatchList();
    bindPageKeys();

    const enable = $('op1-enabled');
    if (enable) {
      enable.addEventListener('change', () => {
        if (enable.checked) { Synth.ensureContext(); OP1Phase.init(); }
        OP1Phase.setEnabled(enable.checked);
        setTimeout(updateEngineBadge, 120);
      });
    }

    const reset = $('op1-reset-btn');
    if (reset) {
      reset.addEventListener('click', () => {
        OP1Phase.setPatch(FACTORY[0]);
        const sel = $('op1-patch-select');
        if (sel) sel.value = '0';
        refreshKnobs();
      });
    }

    if (window.ResizeObserver) new ResizeObserver(resizeScreen).observe(screen);
    window.addEventListener('resize', resizeScreen);

    resizeScreen();
    refreshKnobs();
    updateEngineBadge();
    state.raf = requestAnimationFrame(frame);
  }

  function updateEngineBadge() {
    const el = $('op1-engine-status');
    if (!el) return;
    if (!OP1Phase.getState().enabled) { el.textContent = ''; el.title = ''; return; }
    const worklet = OP1Phase.isWorkletActive();
    el.textContent = worklet ? 'worklet' : 'compat';
    el.title = worklet
      ? 'Rendering in an AudioWorklet — full per-sample phase distortion'
      : 'AudioWorklet unavailable (opening the standalone file over file:// blocks it). '
        + 'Falling back to cached PeriodicWave oscillators: shape and shift apply to new '
        + 'notes rather than to held ones, and the LFO can only reach cutoff. '
        + 'Serve the page over http:// for the full engine.';
  }

  return { init, refreshKnobs, setPage, getFactory: () => FACTORY };

})();
