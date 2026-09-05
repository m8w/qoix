/* ============================================================
   QOIX Synthesizer — Wavetable Oscillator
   ============================================================
   Two modes:
     1. Wavetable  — a wave sequence of 2-8 single-cycle frames.
                     One position control scans the whole series,
                     interpolating between neighbouring frames.
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
    // Wavetable mode — an ordered wave sequence; position 0..1 scans it
    // end to end, morphing between each neighbouring pair in turn.
    frames: ['Sine', 'Sawtooth'],
    position: 0,               // 0 = first frame, 1 = last frame
    positionMod: 0,            // LFO modulation amount for position
    // Oxford mode
    harmonics: Array.from(DEFAULT_OXFORD_HARMONICS),
    // Shared
    level: 0.7,
    octave: 0,
    detune: 0,
  };

  const MIN_FRAMES = 2;
  const MAX_FRAMES = 8;

  const DEFAULT_STATE = JSON.parse(JSON.stringify(state));

  // ── Context ───────────────────────────────────────────────
  let _ctx = null;
  let _destination = null;
  const activeVoices = new Map();

  // Mod matrix offset on the table position, applied on top of state.position
  let _modPosition = 0;

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

  // Table position including any mod matrix modulation
  function effectivePosition() {
    return Math.max(0, Math.min(1, state.position + _modPosition));
  }

  // Where a 0..1 position lands in the series: which pair of frames, and how
  // far between them. With N frames there are N-1 morph segments.
  function locate(pos) {
    const n = state.frames.length;
    if (n < 2) return { a: state.frames[0], b: state.frames[0], frac: 0, index: 0 };
    const p = Math.max(0, Math.min(1, pos)) * (n - 1);
    const i = Math.min(Math.floor(p), n - 2);
    return { a: state.frames[i], b: state.frames[i + 1], frac: p - i, index: i };
  }

  // ── Morphed wave (interpolated between the two frames in play) ──
  // Quantised to 1/128 of the whole series and cached: the mod matrix can
  // sweep the position every frame without rebuilding a PeriodicWave.
  function getMorphedWave(pos) {
    pos = Math.max(0, Math.min(1, pos));
    const step = Math.round(pos * 128);
    const key  = `${state.frames.join('>')}|${step}`;
    if (_waveCache.has(key)) return _waveCache.get(key);
    const seg = locate(step / 128);
    pos = seg.frac;
    const tA = WAVETABLE_BANK[seg.a];
    const tB = WAVETABLE_BANK[seg.b];
    if (!tA || !tB) return null;
    const len = Math.max(tA.imag.length, tB.imag.length);
    const real = new Float32Array(len);
    const imag = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const a = i < tA.imag.length ? tA.imag[i] : 0;
      const b = i < tB.imag.length ? tB.imag[i] : 0;
      imag[i] = a * (1 - pos) + b * pos;
    }
    const wave = _ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    _waveCache.set(key, wave);
    return wave;
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
      const wave = getMorphedWave(effectivePosition());
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
        const wave = getMorphedWave(effectivePosition());
        if (wave) osc.setPeriodicWave(wave);
      }
    });
  }

  // ── State setters ─────────────────────────────────────────
  function setEnabled(v) { state.enabled = v; if (!v) panic(); }
  function setMode(m) { state.mode = m; updateWaveform(); }
  // ── Wave sequence management ──────────────────────────────
  function framesChanged() {
    _waveCache.clear();          // cache keys embed the frame list
    _lastAppliedStep = null;
    updateWaveform();
  }

  function setFrame(index, name) {
    if (index < 0 || index >= state.frames.length) return;
    if (!WAVETABLE_BANK[name]) return;
    state.frames[index] = name;
    framesChanged();
  }

  function addFrame(name) {
    if (state.frames.length >= MAX_FRAMES) return false;
    const last = state.frames[state.frames.length - 1];
    state.frames.push(WAVETABLE_BANK[name] ? name : last);
    framesChanged();
    return true;
  }

  function removeFrame(index) {
    if (state.frames.length <= MIN_FRAMES) return false;
    if (index < 0 || index >= state.frames.length) return false;
    state.frames.splice(index, 1);
    framesChanged();
    return true;
  }

  function getFrames() { return state.frames.slice(); }
  function getFrameLimits() { return { min: MIN_FRAMES, max: MAX_FRAMES }; }

  // Which pair of frames a position sits between, for the UI readout
  function positionInfo(pos) {
    const seg = locate(pos === undefined ? effectivePosition() : pos);
    return { index: seg.index, frac: seg.frac, a: seg.a, b: seg.b, count: state.frames.length };
  }

  // One cycle of the morphed waveform, for drawing the real shape rather
  // than an approximation of it
  function renderWaveform(pos, samples) {
    const seg = locate(pos);
    const tA = WAVETABLE_BANK[seg.a], tB = WAVETABLE_BANK[seg.b];
    if (!tA || !tB) return null;
    const len = Math.max(tA.imag.length, tB.imag.length);
    const out = new Float32Array(samples);
    let peak = 0;
    for (let x = 0; x < samples; x++) {
      const t = (x / samples) * Math.PI * 2;
      let v = 0;
      for (let h = 1; h < len; h++) {
        const a = h < tA.imag.length ? tA.imag[h] : 0;
        const b = h < tB.imag.length ? tB.imag[h] : 0;
        const amp = a * (1 - seg.frac) + b * seg.frac;
        if (amp !== 0) v += amp * Math.sin(h * t);
      }
      out[x] = v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    if (peak > 0) for (let x = 0; x < samples; x++) out[x] /= peak;
    return out;
  }

  // Legacy two-table API, kept so older callers and patches still work
  function setTableA(n) { setFrame(0, n); }
  function setTableB(n) { setFrame(state.frames.length - 1, n); }
  function setPosition(v) { state.position = parseFloat(v); updateWaveform(); }

  // Mod matrix → WT Position. Called every frame, so only push a new waveform
  // when the quantised position actually moves.
  let _lastAppliedStep = null;
  function setModPosition(v) {
    _modPosition = parseFloat(v) || 0;
    const step = Math.round(effectivePosition() * 128);
    if (step === _lastAppliedStep) return;
    _lastAppliedStep = step;
    if (state.mode === 'wavetable' && activeVoices.size) updateWaveform();
  }
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
    if (Array.isArray(s.harmonics)) state.harmonics = Array.from(s.harmonics);

    // Patches saved before wave sequences carry tableA/tableB instead
    if (Array.isArray(s.frames) && s.frames.length >= MIN_FRAMES) {
      state.frames = s.frames.slice(0, MAX_FRAMES);
    } else if (s.tableA || s.tableB) {
      state.frames = [s.tableA || 'Sine', s.tableB || 'Sawtooth'];
    }
    delete state.tableA; delete state.tableB;
    state.frames = state.frames.filter(n => WAVETABLE_BANK[n]);
    while (state.frames.length < MIN_FRAMES) state.frames.push('Sine');

    _waveCache.clear();
    _lastAppliedStep = null;
    updateWaveform();
  }

  // Back to factory defaults (used when a patch carries no wavetable settings)
  function reset() {
    loadState(JSON.parse(JSON.stringify(DEFAULT_STATE)));
    _modPosition = 0;
  }

  return {
    setContext, noteOn, noteOff, panic,
    setEnabled, setMode, setTableA, setTableB,
    setFrame, addFrame, removeFrame, getFrames, getFrameLimits,
    positionInfo, renderWaveform,
    setPosition, setModPosition, setHarmonic, setLevel, setOctave, setDetune,
    getState, getTableNames, loadState, reset,
    get activeVoices() { return activeVoices; },
  };

})();
