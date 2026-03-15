/* ============================================================
   QOIX Synthesizer — Unified UI Controller
   ============================================================
   Wires together: Synth, FMEngine, WTEngine, ModMatrix, RandomGen
   Handles: keyboard input, visualizer, tabs, preset management
   ============================================================ */

'use strict';

const UI = (() => {

  // ── Constants ─────────────────────────────────────────────
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  // Computer keyboard → semitone offset from current octave root
  const KEY_MAP = {
    a:0, w:1, s:2, e:3, d:4, f:5, t:6, g:7, y:8, h:9, u:10, j:11,
    k:12, o:13, l:14, p:15, ';':16, "'":17,
  };

  let kbOctave = 4;
  const pressedKeys = new Set();

  // Piano layout: [semitone, isBlack, keyHint]
  const PIANO_MAP = [
    [0,false,'A'],[1,true,'W'],[2,false,'S'],[3,true,'E'],[4,false,'D'],
    [5,false,'F'],[6,true,'T'],[7,false,'G'],[8,true,'Y'],[9,false,'H'],
    [10,true,'U'],[11,false,'J'],[12,false,'K'],[13,true,'O'],[14,false,'L'],
    [15,true,'P'],[16,false,';'],[17,false,"'"],[18,true,''],[19,false,''],
    [20,true,''],[21,false,''],[22,true,''],[23,false,''],
  ];

  // ── Helpers ───────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const midiName = n => NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);

  function fmt(id, v) {
    v = parseFloat(v);
    if (id.includes('level') || id.includes('sustain') || id.includes('mix') ||
        id.includes('damp')  || id.includes('density') || id.includes('notelen') ||
        id.includes('swing') || id.includes('depth'))
      return `${Math.round(v * 100)}%`;
    if (id.includes('attack') || id.includes('decay') || id.includes('release') ||
        id.includes('time') && id.includes('delay'))
      return v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(2)}s`;
    if (id.includes('cutoff')) return v >= 1000 ? `${(v/1000).toFixed(1)}kHz` : `${Math.round(v)}Hz`;
    if (id.includes('resonance')) return v.toFixed(1);
    if (id.includes('fenv-amount')) return (v >= 0 ? '+' : '') + Math.round(v) + 'Hz';
    if (id.includes('octave') || id.includes('oct') && !id.includes('chorus'))
      return v > 0 ? `+${v}` : `${v}`;
    if (id.includes('detune')) return `${v}¢`;
    if (id.includes('rate') || id.includes('lfo')) return `${v}Hz`;
    if (id.includes('feedback')) return `${Math.round(v * 100)}%`;
    if (id.includes('size')) return `${parseFloat(v).toFixed(1)}s`;
    if (id.includes('chorus-depth')) return `${Math.round(v * 1000)}ms`;
    if (id.includes('bpm')) return `${Math.round(v)}`;
    if (id.includes('chord-size')) return `${Math.round(v)}`;
    if (id.includes('ratio')) return `${parseFloat(v).toFixed(2)}`;
    return `${v}`;
  }

  // Bind a range input → synth setter + display update
  function bindRange(id, fn) {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const vEl = document.getElementById(id + '-v');
      if (vEl) vEl.textContent = fmt(id, el.value);
      fn(el.value);
    });
  }

  function bindCheck(id, fn) {
    const el = $(id);
    if (el) el.addEventListener('change', () => fn(el.checked));
  }

  function bindSelect(id, fn) {
    const el = $(id);
    if (el) el.addEventListener('change', () => fn(el.value));
  }

  // Wave button groups
  function bindWaveGroup(selector, fn) {
    const group = document.querySelector(selector);
    if (!group) return;
    group.querySelectorAll('.wb').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.wb').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        fn(btn.dataset.wave || btn.dataset.filter || btn.dataset.wtmode || btn.dataset.wtset);
      });
    });
  }

  // ── Tab switching ─────────────────────────────────────────
  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const panel = document.getElementById('tab-' + btn.dataset.tab);
        if (panel) panel.classList.add('active');
      });
    });
  }

  // ── Piano keyboard (visual) ───────────────────────────────
  function buildPiano() {
    const pianoEl = $('piano');
    pianoEl.innerHTML = '';
    PIANO_MAP.forEach(([semi, isBlack, hint]) => {
      const midiNote = kbOctave * 12 + semi;
      const key = document.createElement('div');
      key.className = `key ${isBlack ? 'black' : 'white'}`;
      key.dataset.midi = midiNote;
      key.textContent = hint;

      const on = () => {
        Synth.ensureContext();
        playNote(midiNote, 0.88);
        key.classList.add('active');
      };
      const off = () => {
        releaseNote(midiNote);
        key.classList.remove('active');
      };

      key.addEventListener('mousedown', e => { e.preventDefault(); on(); });
      key.addEventListener('mouseup', off);
      key.addEventListener('mouseleave', () => { if (key.classList.contains('active')) off(); });
      key.addEventListener('touchstart', e => { e.preventDefault(); on(); }, { passive: false });
      key.addEventListener('touchend', () => off());
      pianoEl.appendChild(key);
    });
  }

  function setPianoKey(midiNote, active) {
    const el = document.querySelector(`[data-midi="${midiNote}"]`);
    if (el) el.classList.toggle('active', active);
  }

  // ── Note play (routes to all active engines) ──────────────
  function playNote(midiNote, velocity = 0.85) {
    Synth.noteOn(midiNote, velocity);
    if (FMEngine.getState().enabled) FMEngine.noteOn(midiNote, velocity);
    if (WTEngine.getState().enabled) WTEngine.noteOn(midiNote, velocity);
    updateActiveNotesDisplay();
  }

  function releaseNote(midiNote) {
    Synth.noteOff(midiNote);
    FMEngine.noteOff(midiNote);
    WTEngine.noteOff(midiNote);
    updateActiveNotesDisplay();
  }

  function panicAll() {
    Synth.panic();
    FMEngine.panic();
    WTEngine.panic();
    RandomGen.stop();
    $('rand-status').textContent = 'Stopped';
    updateActiveNotesDisplay();
  }

  function updateActiveNotesDisplay() {
    const voices = Synth.getActiveVoices();
    const el = $('active-notes-disp');
    if (el) el.textContent = voices.size ? [...voices.keys()].map(midiName).join('  ') : '—';
  }

  // ── Computer keyboard input ───────────────────────────────
  function initKeyboardInput() {
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
      if (e.repeat) return;

      const k = e.key.toLowerCase();
      if (k === 'z') { kbOctave = Math.max(0, kbOctave - 1); $('kbd-oct-disp').textContent = kbOctave; buildPiano(); return; }
      if (k === 'x') { kbOctave = Math.min(8, kbOctave + 1); $('kbd-oct-disp').textContent = kbOctave; buildPiano(); return; }

      const offset = KEY_MAP[k];
      if (offset === undefined || pressedKeys.has(k)) return;
      pressedKeys.add(k);
      const midiNote = kbOctave * 12 + offset;
      Synth.ensureContext();
      playNote(midiNote, 0.85);
      setPianoKey(midiNote, true);
    });

    document.addEventListener('keyup', e => {
      const k = e.key.toLowerCase();
      const offset = KEY_MAP[k];
      if (offset === undefined) return;
      pressedKeys.delete(k);
      const midiNote = kbOctave * 12 + offset;
      releaseNote(midiNote);
      setPianoKey(midiNote, false);
    });
  }

  // ── Subtractive controls ──────────────────────────────────
  function bindSubtractive() {
    bindRange('master-volume', v => { Synth.setMasterVolume(parseFloat(v)); $('master-vol-disp').textContent = `${Math.round(v*100)}%`; });

    bindCheck('osc1-enabled', v => Synth.setOsc('osc1','enabled',v));
    bindWaveGroup('[data-osc="1"]', v => Synth.setOsc('osc1','wave',v));
    bindRange('osc1-octave', v => Synth.setOsc('osc1','octave',parseInt(v)));
    bindRange('osc1-detune', v => Synth.setOsc('osc1','detune',parseFloat(v)));
    bindRange('osc1-level',  v => Synth.setOsc('osc1','level', parseFloat(v)));

    bindCheck('osc2-enabled', v => Synth.setOsc('osc2','enabled',v));
    bindWaveGroup('[data-osc="2"]', v => Synth.setOsc('osc2','wave',v));
    bindRange('osc2-octave', v => Synth.setOsc('osc2','octave',parseInt(v)));
    bindRange('osc2-detune', v => Synth.setOsc('osc2','detune',parseFloat(v)));
    bindRange('osc2-level',  v => Synth.setOsc('osc2','level', parseFloat(v)));

    bindCheck('noise-enabled', v => Synth.setOsc('noise','enabled',v));
    bindWaveGroup('[data-osc="noise"]', v => Synth.setOsc('noise','type',v));
    bindRange('noise-level', v => Synth.setOsc('noise','level',parseFloat(v)));

    const drawEnv = () => {
      bindRange('env-attack',  v => { Synth.setEnv('attack', parseFloat(v)); drawEnvelope(); });
      bindRange('env-decay',   v => { Synth.setEnv('decay',  parseFloat(v)); drawEnvelope(); });
      bindRange('env-sustain', v => { Synth.setEnv('sustain',parseFloat(v)); drawEnvelope(); });
      bindRange('env-release', v => { Synth.setEnv('release',parseFloat(v)); drawEnvelope(); });
    };
    drawEnv();

    // Filter type buttons
    document.querySelectorAll('[data-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-filter]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        Synth.setFilter('type', btn.dataset.filter);
      });
    });
    bindRange('filter-cutoff',    v => Synth.setFilter('cutoff',    parseFloat(v)));
    bindRange('filter-resonance', v => Synth.setFilter('resonance', parseFloat(v)));

    bindRange('fenv-amount',  v => Synth.setFEnv('amount', parseFloat(v)));
    bindRange('fenv-attack',  v => Synth.setFEnv('attack', parseFloat(v)));
    bindRange('fenv-decay',   v => Synth.setFEnv('decay',  parseFloat(v)));
    bindRange('fenv-sustain', v => Synth.setFEnv('sustain',parseFloat(v)));
    bindRange('fenv-release', v => Synth.setFEnv('release',parseFloat(v)));

    bindCheck('lfo-enabled', v => Synth.setLFO('enabled',v));
    bindWaveGroup('[data-osc="lfo"]', v => Synth.setLFO('wave',v));
    bindRange('lfo-rate',  v => Synth.setLFO('rate', parseFloat(v)));
    bindRange('lfo-depth', v => Synth.setLFO('depth',parseFloat(v)));
    bindSelect('lfo-target', v => Synth.setLFO('target',v));

    bindCheck('dist-enabled',   v => Synth.setDistortion('enabled',v));
    bindRange('dist-drive',     v => Synth.setDistortion('drive',parseFloat(v)));
    bindCheck('chorus-enabled', v => Synth.setChorus('enabled',v));
    bindRange('chorus-rate',    v => Synth.setChorus('rate', parseFloat(v)));
    bindRange('chorus-depth',   v => Synth.setChorus('depth',parseFloat(v)));
    bindRange('chorus-mix',     v => Synth.setChorus('mix',  parseFloat(v)));
    bindCheck('delay-enabled',  v => Synth.setDelay('enabled',v));
    bindRange('delay-time',     v => Synth.setDelay('time',    parseFloat(v)));
    bindRange('delay-feedback', v => Synth.setDelay('feedback',parseFloat(v)));
    bindRange('delay-mix',      v => Synth.setDelay('mix',     parseFloat(v)));
    bindCheck('reverb-enabled', v => Synth.setReverb('enabled',v));
    bindRange('reverb-size',    v => Synth.setReverb('size',parseFloat(v)));
    bindRange('reverb-damp',    v => Synth.setReverb('damp',parseFloat(v)));
    bindRange('reverb-mix',     v => Synth.setReverb('mix', parseFloat(v)));

    $('panic-btn').addEventListener('click', panicAll);

    // Visualizer mode
    document.querySelectorAll('[data-vizmode]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-vizmode]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        vizMode = btn.dataset.vizmode;
      });
    });
  }

  // ── FM controls ───────────────────────────────────────────
  function buildFMAlgorithmSelect() {
    const sel = $('fm-algorithm');
    FMEngine.getAlgorithmLabels().forEach((label, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${i}: ${label}`;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      FMEngine.setAlgorithm(sel.value);
      drawFMAlgorithm(parseInt(sel.value));
    });
  }

  function drawFMAlgorithm(algoIdx) {
    const canvas = $('fm-algo-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#09090d';
    ctx.fillRect(0, 0, W, H);

    const algo = FMEngine.getAlgorithms()[algoIdx];
    if (!algo) return;

    const labels = ['A','B','C','D'];
    const colors = ['#7b86f5','#e6c84a','#e6c84a','#e6c84a'];
    const cols = 4;
    const bW = 36, bH = 24;
    const colW = (W - 20) / cols;

    // Position each operator in a row
    const pos = labels.map((_, i) => ({
      x: 10 + i * colW + colW/2,
      y: H / 2,
    }));

    // Draw modulation arrows first
    ctx.strokeStyle = '#5a5d73';
    ctx.lineWidth = 1.5;
    algo.mods.forEach(({from, to}) => {
      const fx = pos[from].x, fy = pos[from].y;
      const tx = pos[to].x,   ty = pos[to].y;
      ctx.beginPath();
      ctx.moveTo(fx, fy - bH/2);
      const midY = Math.min(fy, ty) - 18;
      ctx.bezierCurveTo(fx, midY, tx, midY, tx, ty - bH/2);
      ctx.stroke();
      // Arrow head
      ctx.beginPath();
      ctx.moveTo(tx, ty - bH/2);
      ctx.lineTo(tx - 4, ty - bH/2 - 6);
      ctx.lineTo(tx + 4, ty - bH/2 - 6);
      ctx.closePath();
      ctx.fillStyle = '#5a5d73';
      ctx.fill();
    });

    // Draw operator boxes
    labels.forEach((label, i) => {
      const { x, y } = pos[i];
      const isCarrier = algo.carriers.includes(i);
      const color = isCarrier ? '#5b67d8' : '#2a2d3a';
      const border = isCarrier ? '#7b86f5' : '#3a3d52';

      ctx.fillStyle = color;
      ctx.strokeStyle = border;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(x - bW/2, y - bH/2, bW, bH, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = isCarrier ? '#fff' : '#6b6f84';
      ctx.font = `${isCarrier ? 'bold ' : ''}11px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`Op ${label}`, x, y);

      if (isCarrier) {
        ctx.fillStyle = '#4fc97e';
        ctx.font = '8px sans-serif';
        ctx.fillText('out', x, y + bH/2 + 8);
      }
    });

    // Output lines from carriers to bottom
    algo.carriers.forEach(i => {
      const { x, y } = pos[i];
      ctx.strokeStyle = '#4fc97e';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, y + bH/2);
      ctx.lineTo(x, H - 8);
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  function bindFM() {
    buildFMAlgorithmSelect();
    drawFMAlgorithm(2);

    bindCheck('fm-enabled', v => {
      FMEngine.setEnabled(v);
      // Give FMEngine the audio context & destination if not yet set
      if (v) {
        const ctx = Synth._getContext();
        FMEngine.setContext(ctx, Synth._voiceDestination);
      }
    });

    // Per-operator controls
    [0,1,2,3].forEach(opIdx => {
      document.querySelectorAll(`.fm-ratio[data-op="${opIdx}"]`).forEach(el => {
        el.addEventListener('input', () => {
          const v = parseFloat(el.value);
          document.querySelectorAll(`.fm-ratio-v[data-op="${opIdx}"]`).forEach(d => d.textContent = v.toFixed(2));
          FMEngine.setOperator(opIdx, 'ratio', v);
        });
      });
      ['level','attack','decay','sustain','release'].forEach(param => {
        document.querySelectorAll(`.fm-${param}[data-op="${opIdx}"]`).forEach(el => {
          el.addEventListener('input', () => {
            const v = parseFloat(el.value);
            const fmtVal = param === 'level' || param === 'sustain'
              ? `${Math.round(v*100)}%`
              : v < 1 ? `${Math.round(v*1000)}ms` : `${v.toFixed(2)}s`;
            document.querySelectorAll(`.fm-${param}-v[data-op="${opIdx}"]`).forEach(d => d.textContent = fmtVal);
            FMEngine.setOperator(opIdx, param, v);
          });
        });
      });
    });
  }

  // ── Wavetable / Oxford controls ───────────────────────────
  function buildWavetableUI() {
    const tableNames = WTEngine.getTableNames();

    // Populate selects
    ['wt-tableA','wt-tableB'].forEach((selId, idx) => {
      const sel = $(selId);
      if (!sel) return;
      tableNames.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      });
      if (idx === 1) sel.value = 'Sawtooth';
      sel.addEventListener('change', () => {
        if (selId === 'wt-tableA') WTEngine.setTableA(sel.value);
        else WTEngine.setTableB(sel.value);
        drawWavePreview();
      });
    });

    // Table button grid
    const grid = $('wt-table-grid');
    if (grid) {
      tableNames.forEach(name => {
        const btn = document.createElement('button');
        btn.className = 'wt-table-btn';
        btn.textContent = name;
        btn.addEventListener('click', () => {
          WTEngine.setTableA(name);
          $('wt-tableA').value = name;
          grid.querySelectorAll('.wt-table-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          drawWavePreview();
        });
        grid.appendChild(btn);
      });
    }
  }

  function buildOxfordUI() {
    const grid = $('harmonic-grid');
    if (!grid) return;
    grid.innerHTML = '';
    for (let h = 0; h < 16; h++) {
      const col = document.createElement('div');
      col.className = 'harmonic-col';

      const lbl = document.createElement('label');
      lbl.textContent = `H${h + 1}`;

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'vslider';
      slider.min = 0; slider.max = 1; slider.step = 0.01;
      slider.value = h === 0 ? 1 : 0;

      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = h === 0 ? '100%' : '0%';

      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        val.textContent = `${Math.round(v * 100)}%`;
        WTEngine.setHarmonic(h, v);
        drawOxfordSpectrum();
      });

      col.appendChild(lbl);
      col.appendChild(slider);
      col.appendChild(val);
      grid.appendChild(col);
    }

    // Oxford preset buttons
    document.querySelectorAll('[data-oxford]').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.oxford;
        const harmonics = oxfordPreset(preset);
        const sliders = grid.querySelectorAll('input[type="range"]');
        sliders.forEach((sl, i) => {
          const v = i < harmonics.length ? harmonics[i] : 0;
          sl.value = v;
          const valEl = sl.nextElementSibling;
          if (valEl) valEl.textContent = `${Math.round(v * 100)}%`;
          WTEngine.setHarmonic(i, v);
        });
        drawOxfordSpectrum();
      });
    });
  }

  function oxfordPreset(name) {
    const presets = {
      sine:    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      saw:     [1, 0.5, 0.33, 0.25, 0.2, 0.17, 0.14, 0.12, 0.11, 0.1, 0.09, 0.08, 0.07, 0.06, 0.05, 0.04],
      square:  [1, 0, 0.33, 0, 0.2, 0, 0.14, 0, 0.11, 0, 0.09, 0, 0.07, 0, 0.05, 0],
      strings: [1, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2, 0.15, 0.1, 0.07, 0.04, 0.02, 0.01, 0, 0, 0],
      brass:   [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05, 0.02, 0.01, 0, 0, 0],
      vocal:   [1, 0.6, 0.4, 0.8, 0.5, 0.3, 0.1, 0.2, 0.05, 0.1, 0.02, 0, 0, 0, 0, 0],
      clear:   new Array(16).fill(0),
    };
    return presets[name] || presets.sine;
  }

  function drawWavePreview() {
    const canvas = $('wt-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#09090d';
    ctx.fillRect(0, 0, W, H);

    const pos = parseFloat($('wt-position')?.value || 0);
    // Simple preview: draw two overlapping shapes
    ctx.strokeStyle = 'rgba(91,103,216,0.4)';
    ctx.lineWidth = 1;
    drawSimpleWave(ctx, W, H, 0, 0.4); // table A
    ctx.strokeStyle = 'rgba(230,200,74,0.4)';
    drawSimpleWave(ctx, W, H, 1, 0.4); // table B
    // Morphed
    ctx.strokeStyle = '#7b86f5';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#5b67d8';
    ctx.shadowBlur = 4;
    drawSimpleWave(ctx, W, H, pos, 1);
    ctx.shadowBlur = 0;
  }

  function drawSimpleWave(ctx, W, H, pos, alpha) {
    // Approximate: blend two sine-based waveforms
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const t = (x / W) * Math.PI * 2;
      const saw = (((t / (Math.PI * 2)) % 1) * 2 - 1);
      const sin = Math.sin(t);
      const v = sin * (1 - pos) + saw * pos;
      const y = (H / 2) - v * (H / 2 - 4);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function drawOxfordSpectrum() {
    const canvas = $('oxford-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#09090d';
    ctx.fillRect(0, 0, W, H);

    const sliders = document.querySelectorAll('#harmonic-grid input[type="range"]');
    const harmonics = Array.from(sliders).map(s => parseFloat(s.value));
    const n = harmonics.length;
    const bW = W / n - 2;

    harmonics.forEach((amp, i) => {
      const x = i * (W / n) + 1;
      const h = amp * (H - 12);
      const hue = 220 + (i / n) * 60;
      ctx.fillStyle = `hsl(${hue}, 70%, ${30 + amp * 40}%)`;
      ctx.fillRect(x, H - h - 8, bW, h);
      ctx.fillStyle = '#5a5d73';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(i + 1, x + bW / 2, H - 1);
    });
  }

  function bindWavetable() {
    buildWavetableUI();
    buildOxfordUI();

    bindCheck('wt-enabled', v => {
      WTEngine.setEnabled(v);
      if (v) {
        const ctx = Synth._getContext();
        WTEngine.setContext(ctx, Synth._voiceDestination);
      }
    });
    bindRange('wt-level',   v => WTEngine.setLevel(parseFloat(v)));
    bindRange('wt-octave',  v => WTEngine.setOctave(parseInt(v)));
    bindRange('wt-detune',  v => WTEngine.setDetune(parseFloat(v)));
    bindRange('wt-position',v => { WTEngine.setPosition(parseFloat(v)); drawWavePreview(); });

    // Mode toggle
    document.querySelectorAll('[data-wtmode]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-wtmode]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.wtmode;
        WTEngine.setMode(mode);
        $('wt-table-panel').style.display = mode === 'wavetable' ? '' : 'none';
        $('wt-oxford-panel').style.display  = mode === 'oxford'    ? '' : 'none';
      });
    });

    drawWavePreview();
    drawOxfordSpectrum();
  }

  // ── Mod Matrix ────────────────────────────────────────────
  function buildModMatrix() {
    const table = $('mod-matrix-table');
    if (!table) return;

    const { SOURCES, DESTINATIONS } = ModMatrix;

    // Header row
    const thead = document.createElement('thead');
    const hRow = document.createElement('tr');
    const thSrc = document.createElement('th');
    thSrc.textContent = 'Source \\ Dest';
    hRow.appendChild(thSrc);
    DESTINATIONS.forEach(dst => {
      const th = document.createElement('th');
      th.textContent = dst.label;
      hRow.appendChild(th);
    });
    thead.appendChild(hRow);
    table.appendChild(thead);

    // Body rows
    const tbody = document.createElement('tbody');
    SOURCES.forEach(src => {
      const row = document.createElement('tr');
      const tdLabel = document.createElement('td');
      tdLabel.className = 'src-label';
      tdLabel.textContent = src.label;
      row.appendChild(tdLabel);

      DESTINATIONS.forEach(dst => {
        const td = document.createElement('td');
        const cell = ModMatrix.getCell(src.id, dst.id);

        const wrap = document.createElement('div');
        wrap.className = 'matrix-cell';

        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = cell.enabled;
        chk.title = `Enable ${src.label} → ${dst.label}`;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = -1; slider.max = 1; slider.step = 0.01;
        slider.value = cell.amount;

        const valSpan = document.createElement('span');
        valSpan.className = 'cell-val';
        valSpan.textContent = cell.amount.toFixed(2);

        chk.addEventListener('change', () => {
          ModMatrix.setCellEnabled(src.id, dst.id, chk.checked);
        });
        slider.addEventListener('input', () => {
          const v = parseFloat(slider.value);
          valSpan.textContent = v.toFixed(2);
          ModMatrix.setCellAmount(src.id, dst.id, v);
        });

        wrap.appendChild(chk);
        wrap.appendChild(slider);
        wrap.appendChild(valSpan);
        td.appendChild(wrap);
        row.appendChild(td);
      });

      tbody.appendChild(row);
    });
    table.appendChild(tbody);
  }

  function bindModMatrix() {
    buildModMatrix();

    bindRange('lfo2-rate',  v => ModMatrix.setLFO2('rate', parseFloat(v)));
    bindRange('lfo2-depth', v => ModMatrix.setLFO2('depth',parseFloat(v)));
    bindWaveGroup('[data-osc="lfo2"]', v => ModMatrix.setLFO2('wave', v));

    // Source value display
    const dispEl = $('mod-src-display');
    if (dispEl) {
      ModMatrix.SOURCES.forEach(src => {
        const row = document.createElement('div');
        row.className = 'mod-src-val';
        row.innerHTML = `${src.label}: <span id="msv-${src.id}">0.00</span>`;
        dispEl.appendChild(row);
      });
    }
  }

  // ── Random Generator controls ─────────────────────────────
  function bindRandomGen() {
    const rootSel = $('rand-root');
    RandomGen.getRootNames().forEach((n, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = n;
      rootSel.appendChild(opt);
    });

    const scaleSel = $('rand-scale');
    RandomGen.getScaleNames().forEach(n => {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      scaleSel.appendChild(opt);
    });
    scaleSel.value = 'Major';

    // Callbacks
    RandomGen.setCallbacks(
      (note, vel) => {
        Synth.ensureContext();
        playNote(note, vel);
        setPianoKey(note, true);
        // Flash
        const flash = $('rand-note-flash');
        if (flash) { flash.textContent = midiName(note); setTimeout(() => { if(flash) flash.textContent = ''; }, 150); }
      },
      (note) => {
        releaseNote(note);
        setPianoKey(note, false);
      }
    );

    $('rand-start-btn').addEventListener('click', () => {
      Synth.ensureContext();
      RandomGen.start();
      $('rand-status').textContent = 'Running';
      $('rand-start-btn').classList.add('active');
    });
    $('rand-stop-btn').addEventListener('click', () => {
      RandomGen.stop();
      $('rand-status').textContent = 'Stopped';
      $('rand-start-btn').classList.remove('active');
    });

    bindRange('rand-bpm',     v => RandomGen.set('bpm',        parseFloat(v)));
    bindRange('rand-swing',   v => RandomGen.set('swing',      parseFloat(v)));
    bindRange('rand-density', v => RandomGen.set('density',    parseFloat(v)));
    bindRange('rand-notelen', v => RandomGen.set('noteLength', parseFloat(v)));
    bindRange('rand-oct-low', v => { RandomGen.set('octaveLow',  parseInt(v)); $('rand-oct-low-v').textContent = v; });
    bindRange('rand-oct-high',v => { RandomGen.set('octaveHigh', parseInt(v)); $('rand-oct-high-v').textContent = v; });
    bindRange('rand-chord-size', v => { RandomGen.set('chordSize', parseInt(v)); $('rand-chord-size-v').textContent = v; });

    rootSel.addEventListener('change',  () => RandomGen.set('rootNote', parseInt(rootSel.value)));
    scaleSel.addEventListener('change', () => RandomGen.set('scale', scaleSel.value));

    // Step div buttons
    document.querySelectorAll('[data-stepdiv]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-stepdiv]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        RandomGen.set('stepDiv', parseInt(btn.dataset.stepdiv));
      });
    });

    // Mode buttons
    document.querySelectorAll('[data-randmode]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-randmode]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        RandomGen.set('mode', btn.dataset.randmode);
      });
    });
  }

  // ── Presets ───────────────────────────────────────────────
  function initPresets() {
    const sel = $('preset-select');
    Presets.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });

    sel.addEventListener('change', () => {
      const p = Presets[parseInt(sel.value)];
      if (!p) return;
      Synth.loadPreset(p);
      syncUIToState();
    });

    $('save-preset-btn').addEventListener('click', () => {
      const name = prompt('Preset name:', 'My Preset');
      if (!name) return;
      const snap = JSON.parse(JSON.stringify(Synth.getState()));
      snap.name = name;
      Presets.push(snap);
      const opt = document.createElement('option');
      opt.value = Presets.length - 1;
      opt.textContent = name;
      sel.appendChild(opt);
      sel.value = Presets.length - 1;
    });
  }

  // ── Sync UI from engine state ─────────────────────────────
  function syncUIToState() {
    const s = Synth.getState();

    function sr(id, v) {
      const el = $(id); if (!el) return;
      el.value = v;
      const vEl = $(id + '-v'); if (vEl) vEl.textContent = fmt(id, v);
    }
    function sc(id, v) { const el = $(id); if (el) el.checked = v; }
    function sw(attr, val) {
      document.querySelectorAll(`[${attr}]`).forEach(b => {
        b.classList.toggle('active', (b.dataset.wave || b.dataset.filter) === val);
      });
    }

    sc('osc1-enabled', s.osc1.enabled);
    sw('data-osc="1"', s.osc1.wave);
    sr('osc1-octave', s.osc1.octave); sr('osc1-detune', s.osc1.detune); sr('osc1-level', s.osc1.level);

    sc('osc2-enabled', s.osc2.enabled);
    sw('data-osc="2"', s.osc2.wave);
    sr('osc2-octave', s.osc2.octave); sr('osc2-detune', s.osc2.detune); sr('osc2-level', s.osc2.level);

    sc('noise-enabled', s.noise.enabled);
    sw('data-osc="noise"', s.noise.type);
    sr('noise-level', s.noise.level);

    sr('env-attack',s.env.attack); sr('env-decay',s.env.decay);
    sr('env-sustain',s.env.sustain); sr('env-release',s.env.release);
    drawEnvelope();

    document.querySelectorAll('[data-filter]').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === s.filter.type);
    });
    sr('filter-cutoff', s.filter.cutoff); sr('filter-resonance', s.filter.resonance);
    sr('fenv-amount', s.fenv.amount); sr('fenv-attack', s.fenv.attack);
    sr('fenv-decay', s.fenv.decay); sr('fenv-sustain', s.fenv.sustain); sr('fenv-release', s.fenv.release);

    sc('lfo-enabled', s.lfo.enabled);
    sw('data-osc="lfo"', s.lfo.wave);
    sr('lfo-rate', s.lfo.rate); sr('lfo-depth', s.lfo.depth);
    const lt = $('lfo-target'); if (lt) lt.value = s.lfo.target;

    sc('dist-enabled', s.dist.enabled); sr('dist-drive', s.dist.drive);
    sc('chorus-enabled', s.chorus.enabled); sr('chorus-rate', s.chorus.rate);
    sr('chorus-depth', s.chorus.depth); sr('chorus-mix', s.chorus.mix);
    sc('delay-enabled', s.delay.enabled); sr('delay-time', s.delay.time);
    sr('delay-feedback', s.delay.feedback); sr('delay-mix', s.delay.mix);
    sc('reverb-enabled', s.reverb.enabled); sr('reverb-size', s.reverb.size);
    sr('reverb-damp', s.reverb.damp); sr('reverb-mix', s.reverb.mix);

    const mvEl = $('master-vol-disp');
    if (mvEl) mvEl.textContent = `${Math.round(s.masterVolume * 100)}%`;
  }

  // ── Envelope canvas draw ──────────────────────────────────
  function drawEnvelope() {
    const canvas = $('env-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const s = Synth.getState().env;
    const { attack, decay, sustain, release } = s;
    const pad = 8;
    const total = attack + decay + 0.5 + release;
    const sc = (W - pad * 2) / total;
    const y0 = H - pad, yTop = pad;
    const yS = y0 - (y0 - yTop) * sustain;
    const xA = pad + attack * sc;
    const xD = xA + decay * sc;
    const xSE = xD + 0.5 * sc;
    const xR = xSE + release * sc;

    ctx.clearRect(0, 0, W, H);

    // Fill
    ctx.fillStyle = 'rgba(91,103,216,0.1)';
    ctx.beginPath();
    ctx.moveTo(pad, y0); ctx.lineTo(xA, yTop); ctx.lineTo(xD, yS);
    ctx.lineTo(xSE, yS); ctx.lineTo(xR, y0); ctx.closePath();
    ctx.fill();

    // Line
    ctx.strokeStyle = '#7b86f5';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#5b67d8'; ctx.shadowBlur = 5;
    ctx.beginPath();
    ctx.moveTo(pad, y0); ctx.lineTo(xA, yTop); ctx.lineTo(xD, yS);
    ctx.lineTo(xSE, yS); ctx.lineTo(xR, y0);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // ── Visualizer ────────────────────────────────────────────
  let vizMode = 'waveform';

  function startVisualizer() {
    const canvas = $('viz-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    function draw() {
      requestAnimationFrame(draw);
      const analyser = Synth.getAnalyser();
      if (!analyser) return;
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#09090d'; ctx.fillRect(0, 0, W, H);

      if (vizMode === 'waveform') {
        const buf = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(buf);
        ctx.strokeStyle = '#7b86f5'; ctx.lineWidth = 1.5;
        ctx.shadowColor = '#5b67d8'; ctx.shadowBlur = 4;
        ctx.beginPath();
        buf.forEach((v, i) => {
          const x = (i / buf.length) * W;
          const y = (1 - (v + 1) / 2) * H;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke(); ctx.shadowBlur = 0;
      } else {
        const buf = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(buf);
        const bW = W / 128;
        for (let i = 0; i < 128; i++) {
          const v = buf[i] / 255;
          const h2 = v * H;
          const hue = 240 + v * 50;
          ctx.fillStyle = `hsl(${hue}, 70%, ${25 + v * 45}%)`;
          ctx.fillRect(i * bW, H - h2, bW - 1, h2);
        }
      }

      // Update mod matrix source display
      ModMatrix.SOURCES.forEach(src => {
        const el = document.getElementById('msv-' + src.id);
        if (el) el.textContent = (ModMatrix.sourceValues[src.id] || 0).toFixed(2);
      });
    }
    draw();
  }

  // ── Octave buttons ────────────────────────────────────────
  function bindOctaveButtons() {
    $('kbd-oct-dn').addEventListener('click', () => {
      kbOctave = Math.max(0, kbOctave - 1);
      $('kbd-oct-disp').textContent = kbOctave;
      buildPiano();
    });
    $('kbd-oct-up').addEventListener('click', () => {
      kbOctave = Math.min(8, kbOctave + 1);
      $('kbd-oct-disp').textContent = kbOctave;
      buildPiano();
    });
  }

  // ── Init ──────────────────────────────────────────────────
  function init() {
    Synth.init();

    initTabs();
    buildPiano();
    bindOctaveButtons();
    bindSubtractive();
    bindFM();
    bindWavetable();
    bindModMatrix();
    bindRandomGen();
    initPresets();
    initKeyboardInput();
    syncUIToState();
    startVisualizer();
    drawEnvelope();

    // Resume audio context on first interaction
    ['click','keydown','touchstart'].forEach(evt => {
      document.addEventListener(evt, () => Synth.ensureContext(), { once: true, passive: true });
    });

    console.log('[QOIX] UI ready');
  }

  document.addEventListener('DOMContentLoaded', init);

  return { updateActiveNotes: updateActiveNotesDisplay };

})();
