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
        id.includes('swing') || id.includes('depth') || id.includes('fm-index'))
      return `${Math.round(v * 100)}%`;
    if (id.includes('attack') || id.includes('decay') || id.includes('release') ||
        id.includes('time') && id.includes('delay'))
      return v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(2)}s`;
    if (id.includes('cutoff')) return v >= 1000 ? `${(v/1000).toFixed(1)}kHz` : `${Math.round(v)}Hz`;
    if (id.includes('resonance')) return v.toFixed(1);
    if (id.includes('fenv-amount') || id.includes('filt-envamt')) return (v >= 0 ? '+' : '') + Math.round(v) + 'Hz';
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
    if (id.includes('voices')) return `${Math.round(v)}`;
    if (id.includes('spread')) return `${Math.round(v)}¢`;
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
        fn(btn.dataset.wave || btn.dataset.filter || btn.dataset.ftype || btn.dataset.wtmode || btn.dataset.wtset || btn.dataset.fmsrc || btn.dataset.mixmode);
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

    // Show C2 (MIDI 36) through C7 (MIDI 96) — 5 full octaves + final C
    const START = 36; // C2
    const END   = 96; // C7

    // Build hint map: midiNote → keyboard character
    const kbHints = {};
    Object.entries(KEY_MAP).forEach(([k, offset]) => {
      kbHints[kbOctave * 12 + offset] = k === "'" ? "'" : k.toUpperCase();
    });

    const BLACK_PATTERN = [false,true,false,true,false,false,true,false,true,false,true,false];

    for (let note = START; note <= END; note++) {
      const semi    = note % 12;
      const octave  = Math.floor(note / 12) - 1;
      const isBlack = BLACK_PATTERN[semi];
      const hint    = kbHints[note] || '';

      const key = document.createElement('div');
      key.className = `key ${isBlack ? 'black' : 'white'}`;
      key.dataset.midi = note;
      if (hint) key.classList.add('kb-range');

      if (!isBlack) {
        const label = document.createElement('div');
        label.className = 'key-label';
        // Only show note name on C notes
        const nameHtml = semi === 0
          ? `<div class="key-note">C<sub style="font-size:0.58em">${octave}</sub></div>`
          : '';
        const hintHtml = hint ? `<div class="key-hint">${hint}</div>` : '';
        if (nameHtml || hintHtml) {
          label.innerHTML = nameHtml + hintHtml;
          key.appendChild(label);
        }
      } else if (hint) {
        const hintEl = document.createElement('div');
        hintEl.className = 'key-hint';
        hintEl.textContent = hint;
        key.appendChild(hintEl);
      }

      const on  = () => { Synth.ensureContext(); playNote(note, 0.88); key.classList.add('active'); };
      const off = () => { releaseNote(note); key.classList.remove('active'); };
      key.addEventListener('mousedown',  e => { e.preventDefault(); on(); });
      key.addEventListener('mouseup',    off);
      key.addEventListener('mouseleave', () => { if (key.classList.contains('active')) off(); });
      key.addEventListener('touchstart', e => { e.preventDefault(); on(); }, { passive: false });
      key.addEventListener('touchend',    e => { e.preventDefault(); off(); }, { passive: false });
      key.addEventListener('touchcancel', e => { e.preventDefault(); off(); }, { passive: false });
      pianoEl.appendChild(key);
    }
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
    if (SpectralFFT.getState().enabled) SpectralFFT.noteOn(midiNote, velocity);
    if (OP1Phase.getState().enabled) OP1Phase.noteOn(midiNote, velocity);
    Recorder.recordNoteOn(midiNote, velocity);
    updateActiveNotesDisplay();
  }

  function releaseNote(midiNote) {
    Synth.noteOff(midiNote);
    FMEngine.noteOff(midiNote);
    WTEngine.noteOff(midiNote);
    SpectralFFT.noteOff(midiNote);
    OP1Phase.noteOff(midiNote);
    Recorder.recordNoteOff(midiNote);
    updateActiveNotesDisplay();
  }

  function panicAll() {
    Synth.panic();
    FMEngine.panic();
    WTEngine.panic();
    SpectralFFT.panic();
    OP1Phase.panic();
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
  // Clicking a toggle label leaves its (visually hidden) checkbox
  // focused, so blocking on "an INPUT has focus" silently killed
  // note keys until you clicked elsewhere. Only block for controls
  // that actually consume typed characters.
  function isTextEntry(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return tag === 'INPUT' && !/^(checkbox|radio|range|button|submit|reset|file)$/i.test(el.type);
  }

  function initKeyboardInput() {
    document.addEventListener('keydown', e => {
      if (isTextEntry(e.target)) return;
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
    bindRange('osc1-voices', v => Synth.setOsc('osc1','voices', parseInt(v)));
    bindRange('osc1-spread', v => Synth.setOsc('osc1','unisonSpread', parseFloat(v)));

    bindCheck('osc2-enabled', v => Synth.setOsc('osc2','enabled',v));
    bindWaveGroup('[data-osc="2"]', v => Synth.setOsc('osc2','wave',v));
    bindRange('osc2-octave', v => Synth.setOsc('osc2','octave',parseInt(v)));
    bindRange('osc2-detune', v => Synth.setOsc('osc2','detune',parseFloat(v)));
    bindRange('osc2-level',  v => Synth.setOsc('osc2','level', parseFloat(v)));
    bindRange('osc2-voices', v => Synth.setOsc('osc2','voices', parseInt(v)));
    bindRange('osc2-spread', v => Synth.setOsc('osc2','unisonSpread', parseFloat(v)));

    bindCheck('osc3-enabled', v => Synth.setOsc('osc3','enabled',v));
    bindWaveGroup('[data-osc="3"]', v => Synth.setOsc('osc3','wave',v));
    bindRange('osc3-octave', v => Synth.setOsc('osc3','octave',parseInt(v)));
    bindRange('osc3-detune', v => Synth.setOsc('osc3','detune',parseFloat(v)));
    bindRange('osc3-level',  v => Synth.setOsc('osc3','level', parseFloat(v)));
    bindRange('osc3-voices', v => Synth.setOsc('osc3','voices', parseInt(v)));
    bindRange('osc3-spread', v => Synth.setOsc('osc3','unisonSpread', parseFloat(v)));

    bindCheck('noise-enabled', v => Synth.setOsc('noise','enabled',v));
    bindWaveGroup('[data-osc="noise"]', v => Synth.setOsc('noise','type',v));
    bindRange('noise-level', v => Synth.setOsc('noise','level',parseFloat(v)));

    // Per-OSC filters
    [1, 2, 3].forEach(n => {
      const key = `osc${n}`;
      bindWaveGroup(`[data-oscfilt="${n}"]`, v => Synth.setOscFilter(key, 'type', v));
      bindRange(`osc${n}-filt-cutoff`,    v => Synth.setOscFilter(key, 'cutoff',    parseFloat(v)));
      bindRange(`osc${n}-filt-resonance`, v => Synth.setOscFilter(key, 'resonance', parseFloat(v)));
      bindRange(`osc${n}-filt-lfodepth`,  v => Synth.setOscFilter(key, 'lfoDepth',  parseFloat(v)));
      bindRange(`osc${n}-filt-envamt`,    v => Synth.setOscFilter(key, 'envAmt',    parseFloat(v)));
    });

    // Per-OSC FM modulation
    [1, 2, 3].forEach(n => {
      const key = `osc${n}`;
      bindWaveGroup(`[data-oscfm="${n}"]`,  v => Synth.setOsc(key, 'fmFrom', v));
      bindRange(`osc${n}-fm-index`,         v => Synth.setOsc(key, 'fmIndex', parseFloat(v)));
    });

    // Per-OSC mix modes (osc2 and osc3)
    [2, 3].forEach(n => {
      bindWaveGroup(`[data-oscmix="${n}"]`, v => Synth.setOsc(`osc${n}`, 'mixMode', v));
    });

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
      const initVal = h === 0 ? 1 : 0;

      const col = document.createElement('div');
      col.className = 'harmonic-col';

      const lbl = document.createElement('label');
      lbl.textContent = `H${h + 1}`;

      // Fader container: glowing bar behind + transparent-track slider on top
      const fader = document.createElement('div');
      fader.className = 'harm-fader';

      const bar = document.createElement('div');
      bar.className = 'harm-bar';
      bar.style.height = `${initVal * 100}%`;

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'harm-slider';
      slider.min = 0; slider.max = 1; slider.step = 0.01;
      slider.value = initVal;

      fader.appendChild(bar);
      fader.appendChild(slider);

      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = initVal === 1 ? '100%' : '0%';

      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        bar.style.height = `${v * 100}%`;
        val.textContent = `${Math.round(v * 100)}%`;
        WTEngine.setHarmonic(h, v);
        drawOxfordSpectrum();
      });

      col.appendChild(lbl);
      col.appendChild(fader);
      col.appendChild(val);
      grid.appendChild(col);
    }

    // Oxford preset buttons — sync bar heights too
    document.querySelectorAll('[data-oxford]').forEach(btn => {
      btn.addEventListener('click', () => {
        const harmonics = oxfordPreset(btn.dataset.oxford);
        grid.querySelectorAll('.harmonic-col').forEach((col, i) => {
          const v = i < harmonics.length ? harmonics[i] : 0;
          const sl  = col.querySelector('.harm-slider');
          const bar = col.querySelector('.harm-bar');
          const vEl = col.querySelector('.val');
          if (sl)  sl.value = v;
          if (bar) bar.style.height = `${v * 100}%`;
          if (vEl) vEl.textContent = `${Math.round(v * 100)}%`;
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

    // Header
    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    const corner = document.createElement('th');
    corner.textContent = 'SRC ↓  DST →';
    corner.className = 'mm-corner';
    hRow.appendChild(corner);
    DESTINATIONS.forEach(dst => {
      const th = document.createElement('th');
      th.textContent = dst.label;
      th.className = 'mm-dh';
      hRow.appendChild(th);
    });
    thead.appendChild(hRow);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    SOURCES.forEach(src => {
      const row = document.createElement('tr');

      const tdLabel = document.createElement('td');
      tdLabel.className = 'mm-src';
      tdLabel.textContent = src.label;
      row.appendChild(tdLabel);

      DESTINATIONS.forEach(dst => {
        const td   = document.createElement('td');
        const cell = ModMatrix.getCell(src.id, dst.id);

        // Toggle dot
        const dot = document.createElement('button');
        dot.className = 'mm-dot' + (cell.enabled ? ' active' : '');
        dot.title = `${src.label} → ${dst.label}`;

        // Amount slider
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'mm-amt';
        slider.min = -1; slider.max = 1; slider.step = 0.01;
        slider.value = cell.amount;

        // Amount value display
        const val = document.createElement('span');
        val.className = 'mm-val';
        const amtPct = Math.round(cell.amount * 100);
        val.textContent = (amtPct >= 0 ? '+' : '') + amtPct + '%';
        val.style.color = cell.amount > 0 ? 'var(--green)' : cell.amount < 0 ? 'var(--accent2)' : 'var(--dim)';

        if (cell.enabled) td.classList.add('mm-on');

        dot.addEventListener('click', () => {
          const now = !ModMatrix.getCell(src.id, dst.id).enabled;
          ModMatrix.setCellEnabled(src.id, dst.id, now);
          dot.classList.toggle('active', now);
          td.classList.toggle('mm-on', now);
        });

        slider.addEventListener('input', () => {
          const v = parseFloat(slider.value);
          const pct = Math.round(v * 100);
          val.textContent = (pct >= 0 ? '+' : '') + pct + '%';
          val.style.color = v > 0 ? 'var(--green)' : v < 0 ? 'var(--accent2)' : 'var(--dim)';
          ModMatrix.setCellAmount(src.id, dst.id, v);
        });

        td.appendChild(dot);
        td.appendChild(slider);
        td.appendChild(val);
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
  const STORAGE_KEY = 'qoix_user_patches';

  function loadUserPatches() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch(e) { return []; }
  }

  function saveUserPatches(patches) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(patches)); } catch(e) {}
  }

  function initPresets() {
    const sel    = $('preset-select');
    const saveBtn = $('save-preset-btn');

    // Track which option indices are user patches (vs built-in)
    const builtinCount = Presets.length;

    function rebuildOptions(selectIdx) {
      sel.innerHTML = '';
      // Built-in factory presets
      Presets.forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = 'builtin:' + i;
        opt.textContent = p.name;
        sel.appendChild(opt);
      });
      // User patches from localStorage
      const user = loadUserPatches();
      if (user.length) {
        const grp = document.createElement('optgroup');
        grp.label = '── My Patches ──';
        user.forEach((p, i) => {
          const opt = document.createElement('option');
          opt.value = 'user:' + i;
          opt.textContent = p.name;
          grp.appendChild(opt);
        });
        sel.appendChild(grp);
      }
      if (selectIdx !== undefined) sel.value = selectIdx;
    }

    rebuildOptions('builtin:0');

    sel.addEventListener('change', () => {
      const [type, idx] = sel.value.split(':');
      const p = type === 'user' ? loadUserPatches()[parseInt(idx)] : Presets[parseInt(idx)];
      if (!p) return;
      Synth.loadPreset(p);
      syncUIToState();
      // Show delete button only for user patches
      if ($('delete-preset-btn')) $('delete-preset-btn').style.display = type === 'user' ? '' : 'none';
    });

    // Save current settings as a named user patch
    saveBtn.addEventListener('click', () => {
      const name = prompt('Name this patch:', 'My Patch');
      if (!name || !name.trim()) return;
      const snap = JSON.parse(JSON.stringify(Synth.getState()));
      snap.name = name.trim();
      const user = loadUserPatches();
      user.push(snap);
      saveUserPatches(user);
      rebuildOptions('user:' + (user.length - 1));
      if ($('delete-preset-btn')) $('delete-preset-btn').style.display = '';
    });

    // Delete current user patch
    if ($('delete-preset-btn')) {
      $('delete-preset-btn').style.display = 'none';
      $('delete-preset-btn').addEventListener('click', () => {
        const [type, idx] = sel.value.split(':');
        if (type !== 'user') return;
        if (!confirm('Delete this patch?')) return;
        const user = loadUserPatches();
        user.splice(parseInt(idx), 1);
        saveUserPatches(user);
        rebuildOptions('builtin:0');
        if ($('delete-preset-btn')) $('delete-preset-btn').style.display = 'none';
      });
    }

    // Export current patch as a JSON file
    if ($('export-patch-btn')) {
      $('export-patch-btn').addEventListener('click', () => {
        const snap = JSON.parse(JSON.stringify(Synth.getState()));
        const name = snap.name || 'qoix-patch';
        snap.name = name;
        const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name.replace(/\s+/g, '-').toLowerCase() + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
      });
    }

    // Import a patch from a JSON file
    if ($('import-patch-input')) {
      $('import-patch-input').addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
          try {
            const patch = JSON.parse(ev.target.result);
            if (!patch || typeof patch !== 'object') throw new Error('Invalid patch');
            if (!patch.name) patch.name = file.name.replace(/\.json$/i, '');
            const user = loadUserPatches();
            user.push(patch);
            saveUserPatches(user);
            rebuildOptions('user:' + (user.length - 1));
            Synth.loadPreset(patch);
            syncUIToState();
            if ($('delete-preset-btn')) $('delete-preset-btn').style.display = '';
          } catch(err) { alert('Could not load patch: ' + err.message); }
        };
        reader.readAsText(file);
        e.target.value = '';
      });
    }
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

    // Per-osc filter sync
    [1, 2, 3].forEach(n => {
      const fs = s[`osc${n}`] && s[`osc${n}`].filter;
      if (!fs) return;
      const container = document.querySelector(`[data-oscfilt="${n}"]`);
      if (container) {
        container.querySelectorAll('.wb').forEach(b => {
          b.classList.toggle('active', b.dataset.ftype === fs.type);
        });
      }
      sr(`osc${n}-filt-cutoff`,    fs.cutoff);
      sr(`osc${n}-filt-resonance`, fs.resonance);
      sr(`osc${n}-filt-lfodepth`,  fs.lfoDepth);
      sr(`osc${n}-filt-envamt`,    fs.envAmt);
    });

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

    let lastDrawTs = 0;

    function draw(ts) {
      requestAnimationFrame(draw);
      const dt = lastDrawTs > 0 ? Math.min((ts - lastDrawTs) / 1000, 0.05) : 1 / 60;
      lastDrawTs = ts;

      // Drive mod matrix each frame
      Synth.applyModMatrix(dt);

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

      // Voice meter
      updateVoiceMeter();

      // Update mod matrix source display
      ModMatrix.SOURCES.forEach(src => {
        const el = document.getElementById('msv-' + src.id);
        if (el) el.textContent = (ModMatrix.sourceValues[src.id] || 0).toFixed(2);
      });
    }
    requestAnimationFrame(draw);
  }

  // ── Quality panel ─────────────────────────────────────────
  function bindQuality() {
    // Populate initial hardware info once context is running
    function updateHardwareInfo() {
      const ctx = Synth._getContext();
      if (!ctx) return;
      const srEl  = $('sample-rate-disp');
      const bufEl = $('buffer-size-disp');
      if (srEl)  srEl.textContent  = `${ctx.sampleRate / 1000}kHz`;
      if (bufEl) bufEl.textContent = ctx.baseLatency
        ? `${Math.round(ctx.baseLatency * 1000)}ms`
        : '—';
    }
    // Retry until context is ready
    const hwTimer = setInterval(() => {
      if (Synth._getContext()) { updateHardwareInfo(); clearInterval(hwTimer); }
    }, 200);

    // Max voices
    const mvEl = $('q-max-voices');
    if (mvEl) {
      mvEl.addEventListener('input', () => {
        const v = parseInt(mvEl.value);
        Synth.setQuality('maxVoices', v);
        $('q-max-voices-v').textContent = v;
        $('voice-max').textContent = v;
      });
    }

    // FFT size
    const fftEl = $('q-fft-size');
    if (fftEl) {
      fftEl.addEventListener('change', () => {
        Synth.setQuality('fftSize', parseInt(fftEl.value));
      });
    }

    // Reverb quality
    document.querySelectorAll('[data-reverbq]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-reverbq]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        Synth.setQuality('reverbDense', btn.dataset.reverbq === 'dense');
      });
    });

    // Distortion curve resolution
    const dcEl = $('q-dist-curve');
    if (dcEl) {
      dcEl.addEventListener('change', () => {
        Synth.setQuality('distCurve', parseInt(dcEl.value));
      });
    }
  }

  // Update voice meter (called from the draw loop)
  function updateVoiceMeter() {
    const q    = Synth.getQuality ? Synth.getQuality() : { maxVoices: 32 };
    const used = Synth.getActiveVoices().size;
    const pct  = Math.min(100, (used / q.maxVoices) * 100);
    const bar  = $('voice-meter');
    const cnt  = $('voice-count');
    if (bar) bar.style.width = pct + '%';
    if (cnt) cnt.textContent = used;
  }

  // ── Offline Renderer UI ──────────────────────────────────
  function bindRenderer() {
    let parsedMidi = null;

    const dropzone    = $('render-dropzone');
    const fileInput   = $('render-file-input');
    const renderBtn   = $('render-start-btn');
    const progWrap    = $('render-progress-wrap');
    const progFill    = $('render-progress-fill');
    const statusMsg   = $('render-status-msg');
    const dlWrap      = $('render-download-wrap');
    const dlLink      = $('render-download-link');
    const dlInfo      = $('render-file-info');
    const midiInfo    = $('render-midi-info');

    if (!dropzone) return;

    // Drag-and-drop
    dropzone.addEventListener('click',     () => fileInput.click());
    dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
    dropzone.addEventListener('dragleave', ()  => dropzone.classList.remove('drag-over'));
    dropzone.addEventListener('drop',      e  => {
      e.preventDefault(); dropzone.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f) loadMidiFile(f);
    });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadMidiFile(fileInput.files[0]); });

    function loadMidiFile(file) {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          parsedMidi = Renderer.parseMidi(e.target.result);
          parsedMidi._filename = file.name;
          showMidiInfo(file.name, parsedMidi);
          renderBtn.disabled = false;
          dlWrap.style.display = 'none';
        } catch(err) {
          alert('Could not parse MIDI file: ' + err.message);
        }
      };
      reader.readAsArrayBuffer(file);
    }

    function showMidiInfo(name, info) {
      $('ri-filename').textContent = name;
      const dur = info.duration;
      $('ri-duration').textContent = dur < 60 ? dur.toFixed(1) + 's' : Math.floor(dur/60) + 'm ' + Math.round(dur%60) + 's';
      $('ri-notes').textContent    = info.noteCount;
      $('ri-format').textContent   = 'Type ' + info.format;
      $('ri-tracks').textContent   = info.numTracks;
      midiInfo.style.display       = '';
    }

    // Tail slider display
    const tailEl = $('render-tail');
    if (tailEl) {
      tailEl.addEventListener('input', () => {
        $('render-tail-v').textContent = tailEl.value + 's';
      });
    }

    renderBtn.addEventListener('click', async () => {
      if (!parsedMidi) return;
      renderBtn.disabled = true;
      progWrap.style.display = '';
      dlWrap.style.display   = 'none';

      const sr  = parseInt($('render-sr').value  || '48000');
      const bd  = parseInt($('render-bd').value  || '24');
      const tail = parseFloat($('render-tail')?.value || '5');

      try {
        const result = await Renderer.render(
          parsedMidi.events,
          Synth.getState(),
          { sampleRate: sr, bitDepth: bd, tailSeconds: tail },
          (pct, msg) => {
            progFill.style.width = pct + '%';
            statusMsg.textContent = msg || '';
          }
        );

        // Build download link
        const url = URL.createObjectURL(result.wavBlob);
        const safeName = (parsedMidi._filename || 'render').replace(/\.[^.]+$/, '');
        dlLink.href     = url;
        dlLink.download = `qoix-${safeName}-${sr/1000}k-${bd}bit.wav`;
        const mb = (result.wavBlob.size / 1024 / 1024).toFixed(1);
        const durStr = result.duration < 60
          ? result.duration.toFixed(1) + 's'
          : Math.floor(result.duration/60) + 'm ' + Math.round(result.duration%60) + 's';
        dlInfo.textContent = `${sr/1000} kHz · ${bd}-bit · ${durStr} · ${mb} MB`;
        dlWrap.style.display = '';
      } catch(err) {
        statusMsg.textContent = 'Error: ' + err.message;
        console.error('[QOIX Renderer]', err);
      }

      renderBtn.disabled = false;
    });
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

  // ── Session Recorder ──────────────────────────────────────
  function bindRecorder() {
    const recBtn   = $('rec-record-btn');
    const stopBtn  = $('rec-stop-btn');
    const playBtn  = $('rec-play-btn');
    const saveBtn  = $('rec-save-btn');
    const loadInp  = $('rec-load-input');
    const statusEl = $('rec-status-msg');
    const indEl    = $('rec-indicator');
    const infoEl   = $('rec-info');

    Recorder.setUpdateCallback(updateRecorderUI);

    function updateRecorderUI() {
      const rec  = Recorder.isRecording();
      const play = Recorder.isPlaying();
      const has  = Recorder.hasSession();

      recBtn.disabled  = rec || play;
      stopBtn.disabled = !rec && !play;
      playBtn.disabled = !has || rec || play;
      saveBtn.disabled = !has || rec || play;

      recBtn.classList.toggle('rec-active', rec);
      indEl.classList.toggle('rec-dot-active', rec || play);

      if (rec)       statusEl.textContent = 'Recording…';
      else if (play) statusEl.textContent = 'Playing back…';
      else if (has)  statusEl.textContent = `Session ready — ${Recorder.getDuration().toFixed(1)}s, ${Recorder.getNoteCount()} notes`;
      else           statusEl.textContent = 'Ready';

      if (has) {
        infoEl.style.display = '';
        $('rec-duration').textContent = Recorder.getDuration().toFixed(2) + 's';
        $('rec-note-count').textContent = Recorder.getNoteCount();
      } else {
        infoEl.style.display = 'none';
      }
    }

    recBtn.addEventListener('click', () => {
      Synth.ensureContext();
      Recorder.startRecording();
    });

    stopBtn.addEventListener('click', () => {
      if (Recorder.isRecording()) Recorder.stopRecording();
      else if (Recorder.isPlaying()) Recorder.stopPlayback();
    });

    playBtn.addEventListener('click', () => {
      Synth.ensureContext();
      Recorder.startPlayback();
    });

    saveBtn.addEventListener('click', () => {
      const name = ($('rec-session-name') || {}).value || 'qoix-session';
      Recorder.saveSession(name);
    });

    if (loadInp) {
      loadInp.addEventListener('change', () => {
        const file = loadInp.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
          try {
            const session = Recorder.loadSession(e.target.result);
            if ($('rec-session-name')) $('rec-session-name').value = session.name || 'Session';
          } catch (err) {
            alert('Could not load session: ' + err.message);
          }
        };
        reader.readAsText(file);
        loadInp.value = '';
      });
    }

    // Expose piano key toggle for playback visualization
    UI._setPianoKeyExternal = (note, active) => {
      const el = document.querySelector(`[data-midi="${note}"]`);
      if (el) el.classList.toggle('active', active);
    };

    updateRecorderUI();
  }

  // ── Microtonal ────────────────────────────────────────────
  const NOTE_NAMES_FULL = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  function buildMicroRootSelect() {
    const sel = $('micro-root-select');
    if (!sel) return;
    sel.innerHTML = '';
    for (let midi = 0; midi <= 127; midi++) {
      const oct = Math.floor(midi / 12) - 1;
      const name = NOTE_NAMES_FULL[midi % 12] + oct;
      const opt = document.createElement('option');
      opt.value = midi;
      opt.textContent = `${name} (${midi})`;
      if (midi === 60) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function buildMicroScaleSelect() {
    const sel = $('micro-scale-select');
    if (!sel) return;
    sel.innerHTML = '';
    Microtonal.getScaleNames().forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
  }

  function updateMicroDisplay() {
    const st = Microtonal.getState();
    const descEl = $('micro-scale-desc');
    const tableEl = $('micro-cents-table');
    const loadedEl = $('micro-loaded-name');

    if (descEl && st.scale) descEl.textContent = st.scale.description || '';
    if (loadedEl) loadedEl.textContent = st.scaleName || '';

    if (!tableEl || !st.scale) return;
    const rows = Microtonal.getCentsTable();
    tableEl.innerHTML = rows.map((r, i) =>
      `<div class="micro-degree-row">
        <span class="micro-deg">${i === 0 ? '&#9670;' : i}</span>
        <span class="micro-cents">${r.cents >= 0 ? '+' : ''}${r.cents.toFixed(3)}&#x00A2;</span>
        <span class="micro-label">${r.label}</span>
      </div>`
    ).join('');
  }

  function bindMicrotonal() {
    buildMicroScaleSelect();
    buildMicroRootSelect();
    updateMicroDisplay();

    // Enable toggle
    const enableCb = $('micro-enabled');
    if (enableCb) enableCb.addEventListener('change', () => {
      Microtonal.setEnabled(enableCb.checked);
    });

    // Scale selection
    const scaleSel = $('micro-scale-select');
    if (scaleSel) scaleSel.addEventListener('change', () => {
      Microtonal.setScaleByName(scaleSel.value);
      updateMicroDisplay();
    });

    // Root note
    const rootSel = $('micro-root-select');
    if (rootSel) rootSel.addEventListener('change', () => {
      const midi = parseInt(rootSel.value);
      Microtonal.setRoot(midi);
      const rootV = $('micro-root-v');
      if (rootV) rootV.textContent = NOTE_NAMES_FULL[midi % 12] + (Math.floor(midi / 12) - 1);
    });

    // Load .scl file
    const sclInput = $('micro-scl-input');
    if (sclInput) sclInput.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          Microtonal.loadScl(ev.target.result);
          updateMicroDisplay();
          // Sync the scale select to show "(custom)" or just leave as-is
          const loadedEl = $('micro-loaded-name');
          if (loadedEl) loadedEl.textContent = 'Custom: ' + file.name;
        } catch (err) {
          alert('Error loading .scl file: ' + err.message);
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    // Reset to built-in
    const resetBtn = $('micro-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => {
      const sel = $('micro-scale-select');
      const name = sel ? sel.value : '12-EDO (Standard)';
      Microtonal.setScaleByName(name);
      updateMicroDisplay();
    });
  }

  // ── Spectral / FrFT Engine ────────────────────────────────
  function fmtSpectral(id, v) {
    v = parseFloat(v);
    if (id.includes('level') || id.includes('sustain') || id.includes('eigen'))
      return `${Math.round(v * 100)}%`;
    if (id.includes('alpha'))
      return v.toFixed(2);
    if (id.includes('ratio'))
      return v.toFixed(2);
    if (id.includes('chirp'))
      return v.toFixed(1);
    if (id.includes('-a') || id.includes('-d') || id.includes('-r'))
      return v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(2)}s`;
    return `${v}`;
  }

  function bindSpectralRange(id, fn) {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      fn(v);
      const vEl = $(id + '-v');
      if (vEl) vEl.textContent = fmtSpectral(id, el.value);
    });
  }

  function bindSpectral() {
    // Enable toggle: init SpectralFFT lazily on first enable
    const enableCb = $('spectral-enabled');
    if (enableCb) {
      enableCb.addEventListener('change', () => {
        const v = enableCb.checked;
        if (v) {
          Synth.ensureContext();
          SpectralFFT.init();
        }
        SpectralFFT.setEnabled(v);
      });
    }

    // FrFT alpha
    bindSpectralRange('spectral-alpha', v => SpectralFFT.setAlpha(v));

    // Chirp shape buttons
    const chirpBtns = $('spectral-chirp-btns');
    if (chirpBtns) {
      chirpBtns.querySelectorAll('.wb').forEach(btn => {
        btn.addEventListener('click', () => {
          chirpBtns.querySelectorAll('.wb').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          SpectralFFT.setChirpShape(btn.dataset.chirp);
        });
      });
    }

    // Three operator blocks
    [0, 1, 2].forEach(idx => {
      const enCb = $(`spectral-op${idx}-en`);
      if (enCb) enCb.addEventListener('change', () => SpectralFFT.setOp(idx, 'enabled', enCb.checked));
      bindSpectralRange(`spectral-op${idx}-ratio`, v => SpectralFFT.setOp(idx, 'ratio', v));
      bindSpectralRange(`spectral-op${idx}-chirp`, v => SpectralFFT.setOp(idx, 'chirpRatio', v));
      bindSpectralRange(`spectral-op${idx}-level`, v => SpectralFFT.setOp(idx, 'level', v));
    });

    // Eigenspace
    bindSpectralRange('eigen-p1',  v => SpectralFFT.setEigen('p1',  v));
    bindSpectralRange('eigen-pm1', v => SpectralFFT.setEigen('pm1', v));
    bindSpectralRange('eigen-pi',  v => SpectralFFT.setEigen('pi',  v));
    bindSpectralRange('eigen-pmi', v => SpectralFFT.setEigen('pmi', v));

    // Spectral ADSR envelope
    bindSpectralRange('spectral-env-a', v => SpectralFFT.setEnv('attack',  v));
    bindSpectralRange('spectral-env-d', v => SpectralFFT.setEnv('decay',   v));
    bindSpectralRange('spectral-env-s', v => SpectralFFT.setEnv('sustain', v));
    bindSpectralRange('spectral-env-r', v => SpectralFFT.setEnv('release', v));
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
    bindQuality();
    initPresets();
    initKeyboardInput();
    bindRenderer();
    bindRecorder();
    bindSpectral();
    bindMicrotonal();
    OP1Panel.init();
    syncUIToState();
    startVisualizer();
    drawEnvelope();

    // Resume audio context on first interaction
    ['click','keydown','touchstart'].forEach(evt => {
      document.addEventListener(evt, () => Synth.ensureContext(), { once: true, passive: true });
    });

    // Global safety net: release all notes if touch is cancelled at the system level
    // (e.g. notification banner, scroll gesture, phone call) or page goes hidden.
    document.addEventListener('touchcancel', () => panicAll(), { passive: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) panicAll(); });

    // Fix slide-between-keys: track which piano key each touch is currently over
    // and fire on/off as fingers move across keys.
    const _touchNotes = new Map(); // touchId -> midiNote currently sounding
    document.addEventListener('touchmove', e => {
      for (const touch of e.changedTouches) {
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        const keyEl = el && el.closest('[data-midi]');
        const newNote = keyEl ? parseInt(keyEl.dataset.midi) : null;
        const oldNote = _touchNotes.get(touch.identifier);
        if (oldNote !== newNote) {
          if (oldNote != null) { releaseNote(oldNote); keyEl && keyEl.classList.remove('active'); const old = document.querySelector(`[data-midi="${oldNote}"]`); if (old) old.classList.remove('active'); }
          if (newNote != null) { Synth.ensureContext(); playNote(newNote, 0.88); keyEl.classList.add('active'); _touchNotes.set(touch.identifier, newNote); }
          else { _touchNotes.delete(touch.identifier); }
        }
      }
    }, { passive: true });
    document.addEventListener('touchstart', e => {
      for (const touch of e.changedTouches) {
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        const keyEl = el && el.closest('[data-midi]');
        if (keyEl) _touchNotes.set(touch.identifier, parseInt(keyEl.dataset.midi));
      }
    }, { passive: true });
    document.addEventListener('touchend', e => {
      for (const touch of e.changedTouches) {
        const note = _touchNotes.get(touch.identifier);
        if (note != null) releaseNote(note);
        _touchNotes.delete(touch.identifier);
      }
    }, { passive: true });
    document.addEventListener('touchcancel', e => {
      for (const touch of e.changedTouches) {
        const note = _touchNotes.get(touch.identifier);
        if (note != null) releaseNote(note);
        _touchNotes.delete(touch.identifier);
      }
    }, { passive: true });

    // Desktop (Electron) integrations
    if (window.qoixApp) {
      initDesktopIntegrations();
    }

    // Web MIDI (works in Electron + Chrome)
    initMIDI();

    console.log('[QOIX] UI ready —', window.qoixApp ? 'Desktop' : 'Browser');
  }

  // ── Desktop / Electron menu events ────────────────────────
  function initDesktopIntegrations() {
    const app = window.qoixApp;

    app.onMenuEvent('menu:panic',        () => panicAll());
    app.onMenuEvent('menu:octave-up',    () => { kbOctave = Math.min(8, kbOctave + 1); $('kbd-oct-disp').textContent = kbOctave; buildPiano(); });
    app.onMenuEvent('menu:octave-down',  () => { kbOctave = Math.max(0, kbOctave - 1); $('kbd-oct-disp').textContent = kbOctave; buildPiano(); });
    app.onMenuEvent('menu:rand-start',   () => { Synth.ensureContext(); RandomGen.start(); $('rand-status').textContent = 'Running'; });
    app.onMenuEvent('menu:rand-stop',    () => { RandomGen.stop(); $('rand-status').textContent = 'Stopped'; });

    app.onMenuEvent('menu:export-preset', async () => {
      const name  = prompt('Preset name to export:', 'My Preset');
      if (!name) return;
      const data  = { name, ...JSON.parse(JSON.stringify(Synth.getState())) };
      const result = await app.savePresetFile(name, data);
      if (result.ok) alert(`Saved: ${result.filePath}`);
    });

    app.onMenuEvent('menu:import-preset', async (filePath) => {
      const result = await app.readPresetFile(filePath);
      if (!result.ok) { alert('Could not read preset: ' + result.error); return; }
      Synth.loadPreset(result.data);
      syncUIToState();
      // Add to preset list
      const sel = $('preset-select');
      if (sel) {
        const opt = document.createElement('option');
        opt.value = Presets.length;
        opt.textContent = result.data.name || 'Imported';
        Presets.push(result.data);
        sel.appendChild(opt);
        sel.value = Presets.length - 1;
      }
    });

    // macOS: hide traffic-light offset for titlebar
    if (app.platform === 'darwin') {
      document.body.classList.add('macos-titlebar');
    }
  }

  // ── Web MIDI ───────────────────────────────────────────────
  function initMIDI() {
    if (!navigator.requestMIDIAccess) return;
    navigator.requestMIDIAccess({ sysex: false }).then(access => {
      console.log('[QOIX] MIDI access granted');

      function connectInput(input) {
        input.onmidimessage = (msg) => {
          const [status, note, velocity] = msg.data;
          const cmd = status & 0xf0;
          if (cmd === 0x90 && velocity > 0) {       // note on
            Synth.ensureContext();
            playNote(note, velocity / 127);
            setPianoKey(note, true);
          } else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) { // note off
            releaseNote(note);
            setPianoKey(note, false);
          } else if (cmd === 0xb0 && note === 1) {  // CC1 = mod wheel
            ModMatrix.setModWheel(velocity / 127);
          } else if (cmd === 0xb0 && note === 123) { // all notes off
            panicAll();
          }
        };
      }

      // Connect existing inputs
      access.inputs.forEach(connectInput);

      // Hot-plug
      access.onstatechange = (e) => {
        if (e.port.type === 'input' && e.port.state === 'connected') {
          connectInput(e.port);
          console.log('[QOIX] MIDI device connected:', e.port.name);
        }
      };

      // Show MIDI indicator
      const footer = document.querySelector('footer');
      if (footer && access.inputs.size > 0) {
        const tag = document.createElement('span');
        tag.style.cssText = 'color:#4fc97e;margin-left:8px;font-weight:600;';
        tag.textContent = `● MIDI (${access.inputs.size} device${access.inputs.size > 1 ? 's' : ''})`;
        footer.appendChild(tag);
      }
    }).catch(() => {
      console.log('[QOIX] MIDI not available');
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  return { updateActiveNotes: updateActiveNotesDisplay };

})();
