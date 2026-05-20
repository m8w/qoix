/* ============================================================
   QOIX Synthesizer — Wavetable Oscillator
   ============================================================
   Two modes:
     1. Wavetable  — scan through a bank of named single-cycle
                     waveforms. Position and morph-speed param.
     2. Oxford     — OSCar-style additive harmonic oscillator.
                     Directly set amplitude of harmonics 1–16.
   ============================================================ */

'use strict';

const WTEngine = (() => {

  // ── Wavetable bank (each table = 2048 samples, 1 cycle) ───
  // Built procedurally from harmonic series
  const TABLE_SIZE = 2048;

  function buildTable(harmonicAmps) {
    // harmonicAmps[0] = amplitude of 1st harmonic (fundamental), etc.
    const real = new Float32Array(harmonicAmps.length + 1);
    const imag = new Float32Array(harmonicAmps.length + 1);
    real[0] = 0; imag[0] = 0;
    harmonicAmps.forEach((amp, i) => {
      imag[i + 1] = amp;
    });
    return { real, imag };
  }

  // Named wavetable positions (harmonic amplitude arrays)
  const WAVETABLE_BANK = {
    'Sine': buildTable([1]),
    'Triangle': buildTable([1, 0, -1/9, 0, 1/25, 0, -1/49, 0, 1/81]),
    'Square': buildTable([1, 0, 1/3, 0, 1/5, 0, 1/7, 0, 1/9, 0, 1/11]),
    'Sawtooth': buildTable([1, 1/2, 1/3, 1/4, 1/5, 1/6, 1/7, 1/8, 1/9, 1/10, 1/11, 1/12]),
    'Ramp': buildTable([-1, 1/2, -1/3, 1/4, -1/5, 1/6, -1/7, 1/8]),
    'Pulse 25%': buildTable([1, -0.5, 0, 0.5, -1, 0.5, 0, -0.5, 1, -0.5]),
    'Half Sine': buildTable([0.6366, 0, -0.2122, 0, 0.1273, 0, -0.0909, 0, 0.0707]),
    'Vocal Ah': buildTable([1, 0.6, 0.4, 0.8, 0.5, 0.3, 0.1, 0.2, 0.05, 0.1, 0.02]),
    'Vocal Eh': buildTable([1, 0.9, 0.3, 0.4, 0.6, 0.2, 0.3, 0.1, 0.2, 0.05]),
    'Vocal Oh': buildTable([1, 0.3, 0.5, 0.1, 0.2, 0.05, 0.1, 0.02, 0.05]),
    'Cello': buildTable([1, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2, 0.15, 0.1, 0.07, 0.04, 0.02]),
    'Brass': buildTable([1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05, 0.02]),
    'Reed': buildTable([1, 0, 0.7, 0, 0.4, 0, 0.2, 0, 0.1, 0, 0.05]),
    'Glass': buildTable([0.5, 0, 0, 0.8, 0, 0, 0.3, 0, 0, 0.1, 0, 0, 0.05]),
    'Bell 1': buildTable([1, 0, 0.5, 0, 0, 0.3, 0, 0, 0.15, 0, 0, 0, 0.07]),
    'Bell 2': buildTable([0.8, 0, 0, 0.6, 0, 0, 0.4, 0, 0, 0, 0.2, 0, 0, 0.1]),
    'Formant': buildTable([0.2, 0.5, 1.0, 0.8, 0.4, 0.1, 0.05, 0.3, 0.6, 0.4, 0.2, 0.1]),
    'Organ 1': buildTable([1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]),
    'Organ 2': buildTable([1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
    'Chiptune': buildTable([1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
  };

  const TABLE_NAMES = Object.keys(WAVETABLE_BANK);

  // ── Oxford (OSCar) harmonic oscillator ───────────────────
  // 16 harmonics, freely settable
  const DEFAULT_OXFORD_HARMONICS = new Float32Array(16).fill(0);
  DEFAULT_OXFORD_HARMONICS[0] = 1.0; // fundamental

  // ── State ─────────────────────────────────────────────────
  const state = {
    enabled: false,
    mode: 'wavetable',         // 'wavetable' | 'oxford'
    // Wavetable mode
    tableA: 'Sine',
    tableB: 'Sawtooth',
    position: 0,               // 0=tableA, 1=tableB
    positionMod: 0,            // LFO modulation amount for position
    // Oxford mode
    harmonics: Array.from(DEFAULT_OXFORD_HARMONICS),
    // Shared
    level: 0.7,
    octave: 0,
    detune: 0,
  };

  // ── Context ───────────────────────────────────────────────
  let _ctx = null;
  let _destination = null;
  const activeVoices = new Map();

  // Cached PeriodicWave objects per context
  const _waveCache = new Map();

  function setContext(ctx, destination) {
    _ctx = ctx;
    _destination = destination;
    _waveCache.clear();
  }

  // ── Build PeriodicWave from table definition ──────────────
  function getPeriodicWave(tableName) {
    if (_waveCache.has(tableName)) return _waveCache.get(tableName);
    const t = WAVETABLE_BANK[tableName];
    if (!t) return null;
    const wave = _ctx.createPeriodicWave(t.real, t.imag, { disableNormalization: false });
    _waveCache.set(tableName, wave);
    return wave;
  }

  function getOxfordWave() {
    const n = state.harmonics.length;
    const real = new Float32Array(n + 1);
    const imag = new Float32Array(n + 1);
    real[0] = 0; imag[0] = 0;
    state.harmonics.forEach((amp, i) => { imag[i + 1] = amp; });
    return _ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  // ── Morphed wave (linear interpolation between A and B) ──
  function getMorphedWave(pos) {
    pos = Math.max(0, Math.min(1, pos));
    const tA = WAVETABLE_BANK[state.tableA];
    const tB = WAVETABLE_BANK[state.tableB];
    if (!tA || !tB) return null;
    const len = Math.max(tA.imag.length, tB.imag.length);
    const real = new Float32Array(len);
    const imag = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const a = i < tA.imag.length ? tA.imag[i] : 0;
      const b = i < tB.imag.length ? tB.imag[i] : 0;
      imag[i] = a * (1 - pos) + b * pos;
    }
    return _ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  // ── Note on ───────────────────────────────────────────────
  function noteOn(midiNote, velocity = 1) {
    if (!_ctx || !state.enabled) return;
    if (activeVoices.has(midiNote)) noteOff(midiNote, true);

    const baseFreq = (typeof Microtonal !== 'undefined' && Microtonal.getState().enabled)
      ? Microtonal.noteToFreq(midiNote)
      : 440 * Math.pow(2, (midiNote - 69) / 12);
    const freq = baseFreq * Math.pow(2, state.octave);
    const now = _ctx.currentTime;

    const osc = _ctx.createOscillator();

    // Set waveform
    if (state.mode === 'oxford') {
      osc.setPeriodicWave(getOxfordWave());
    } else {
      const wave = getMorphedWave(state.position);
      if (wave) osc.setPeriodicWave(wave);
    }

    osc.frequency.value = freq;
    osc.detune.value = state.detune;

    const gain = _ctx.createGain();
    gain.gain.value = state.level * velocity;

    osc.connect(gain);
    gain.connect(_destination);
    osc.start(now);

    activeVoices.set(midiNote, { osc, gain });
  }

  // ── Note off ──────────────────────────────────────────────
  function noteOff(midiNote, immediate = false) {
    const voice = activeVoices.get(midiNote);
    if (!voice) return;
    const now = _ctx.currentTime;
    const rel = immediate ? 0.02 : 0.1;
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + rel);
    try { voice.osc.stop(now + rel + 0.05); } catch(e) {}
    activeVoices.delete(midiNote);
  }

  function panic() {
    activeVoices.forEach((_, n) => noteOff(n, true));
    activeVoices.clear();
  }

  // ── Update live voices with new waveform ─────────────────
  function updateWaveform() {
    activeVoices.forEach(({ osc }) => {
      if (state.mode === 'oxford') {
        osc.setPeriodicWave(getOxfordWave());
      } else {
        const wave = getMorphedWave(state.position);
        if (wave) osc.setPeriodicWave(wave);
      }
    });
  }

  // ── State setters ─────────────────────────────────────────
  function setEnabled(v) { state.enabled = v; if (!v) panic(); }
  function setMode(m) { state.mode = m; updateWaveform(); }
  function setTableA(n) { state.tableA = n; updateWaveform(); }
  function setTableB(n) { state.tableB = n; updateWaveform(); }
  function setPosition(v) { state.position = parseFloat(v); updateWaveform(); }
  function setHarmonic(idx, v) {
    state.harmonics[idx] = parseFloat(v);
    updateWaveform();
  }
  function setLevel(v) {
    state.level = parseFloat(v);
    activeVoices.forEach(({ gain }) => { gain.gain.value = state.level; });
  }
  function setOctave(v) { state.octave = parseInt(v); }
  function setDetune(v) {
    state.detune = parseFloat(v);
    activeVoices.forEach(({ osc }) => { osc.detune.value = state.detune; });
  }

  function getState() { return state; }
  function getTableNames() { return TABLE_NAMES; }

  function loadState(s) {
    Object.assign(state, s);
    _waveCache.clear();
    updateWaveform();
  }

  return {
    setContext, noteOn, noteOff, panic,
    setEnabled, setMode, setTableA, setTableB,
    setPosition, setHarmonic, setLevel, setOctave, setDetune,
    getState, getTableNames, loadState,
    get activeVoices() { return activeVoices; },
  };

})();
