/* ============================================================
   QOIX — OP-1 "Phase" Engine
   ============================================================
   A phase-distortion synthesiser in the spirit of the
   Teenage Engineering OP-1 "phase" engine, driven by four
   colour-coded encoders (blue / green / white / orange) across
   four pages (synth · envelope · fx · lfo).

   Sound generation is Casio-CZ style phase distortion: a linear
   phase ramp is warped through a two-segment breakpoint function
   before it indexes a sine table. At shape=0 the warp is the
   identity (pure sine); as shape rises the first half-cycle is
   stretched across almost the whole period, producing the
   familiar sine→saw→resonant sweep with no filter involved.

   Two such oscillators run per voice with an adjustable phase
   offset and detune between them — that offset is what the
   "phase" name refers to, and it is what the display draws.

   Rendering happens in an AudioWorklet (2x oversampled, DC
   blocked, soft clipped). The worklet source is inlined and
   loaded from a Blob URL so the single-file standalone build
   keeps working. Browsers without AudioWorklet fall back to
   cached PeriodicWave oscillators.
   ============================================================ */

'use strict';

const OP1Phase = (() => {

  // ── OP-1 encoder colours ──────────────────────────────────
  const COLORS = {
    blue:   '#2f7ae5',
    green:  '#42c25a',
    white:  '#e8eef1',
    orange: '#f2871f',
  };

  const MAX_VOICES = 16;

  // ── Audio context / graph ─────────────────────────────────
  let ctx        = null;
  let dest       = null;   // Synth._voiceDestination
  let voiceBus   = null;   // all voices sum here
  let driveNode  = null;   // WaveShaper
  let filterNode = null;   // lowpass
  let levelNode  = null;   // engine output level
  let lfoOsc     = null;   // OscillatorNode or AudioBufferSourceNode (S&H)
  let lfoDepth   = null;   // GainNode — depth * destination scale

  let workletReady  = false;
  let workletFailed = false;

  const activeVoices = new Map();   // midiNote → voice

  // ── State ─────────────────────────────────────────────────
  const state = {
    enabled: false,
    page:    0,

    // synth page
    shape:  0.35,   // 0..1  phase-distortion amount
    shift:  0.00,   // 0..1  phase offset of osc B (turns)
    detune: 7,      // cents, osc B relative to osc A
    mix:    0.50,   // 0..1  equal-power A↔B crossfade

    // envelope page
    env: { attack: 0.008, decay: 0.30, sustain: 0.65, release: 0.45 },

    // fx page
    fx:  { drive: 0.12, cutoff: 0.80, res: 0.10, level: 0.80 },

    // lfo page
    lfo: { rate: 3.2, depth: 0.0, dest: 'shape', shape: 'sine' },
  };

  const LFO_DESTS  = ['shape', 'shift', 'pitch', 'cutoff'];
  const LFO_SHAPES = ['sine', 'triangle', 'sawtooth', 'square', 'random'];

  // How far each destination swings at depth = 1
  const LFO_SCALE = { shape: 0.5, shift: 0.5, pitch: 120, cutoff: 2400 };

  // ── Worklet source (inlined so the standalone build works) ─
  const WORKLET_SRC = `
class QoixPhaseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency', defaultValue: 440, minValue: 0.01, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'shape',     defaultValue: 0.3, minValue: 0,    maxValue: 1,     automationRate: 'a-rate' },
      { name: 'shift',     defaultValue: 0,   minValue: 0,    maxValue: 1,     automationRate: 'a-rate' },
      { name: 'detune',    defaultValue: 0,   minValue: -2400, maxValue: 2400, automationRate: 'a-rate' },
      { name: 'mix',       defaultValue: 0.5, minValue: 0,    maxValue: 1,     automationRate: 'a-rate' },
      { name: 'vibrato',   defaultValue: 0,   minValue: -2400, maxValue: 2400, automationRate: 'a-rate' }
    ];
  }

  constructor() {
    super();
    this.phA = 0;
    this.phB = 0;
    this.dcX = 0;
    this.dcY = 0;
    this.lp  = 0;
    this.dead = false;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.dead = true; };
  }

  // Two-segment phase warp — the heart of phase distortion.
  // d=0 leaves the ramp untouched (sine); d→1 crams the second
  // half of the sine into a vanishing slice of the period.
  static warp(p, d) {
    const b = 0.5 + 0.45 * d;
    return p < b ? (0.5 * p / b) : (0.5 + 0.5 * (p - b) / (1 - b));
  }

  process(inputs, outputs, params) {
    const out = outputs[0][0];
    if (!out) return !this.dead;

    const P    = params;
    const kFrq = P.frequency, kShp = P.shape, kSft = P.shift;
    const kDet = P.detune,    kMix = P.mix,   kVib = P.vibrato;
    const at   = (arr, i) => arr.length > 1 ? arr[i] : arr[0];

    const sr2  = sampleRate * 2;   // 2x oversampled
    const TAU  = Math.PI * 2;
    const W    = QoixPhaseProcessor.warp;

    for (let i = 0; i < out.length; i++) {
      const f    = at(kFrq, i);
      const vib  = at(kVib, i);
      const shp  = Math.min(1, Math.max(0, at(kShp, i)));
      const sft  = at(kSft, i);
      const det  = at(kDet, i);
      const mix  = Math.min(1, Math.max(0, at(kMix, i)));

      const gA   = Math.cos(mix * Math.PI * 0.5);
      const gB   = Math.sin(mix * Math.PI * 0.5);
      const incA = (f * Math.pow(2, vib / 1200)) / sr2;
      const incB = (f * Math.pow(2, (vib + det) / 1200)) / sr2;

      let acc = 0;
      for (let k = 0; k < 2; k++) {
        this.phA += incA; if (this.phA >= 1) this.phA -= Math.floor(this.phA);
        this.phB += incB; if (this.phB >= 1) this.phB -= Math.floor(this.phB);

        let pb = this.phB + sft;
        pb -= Math.floor(pb);

        acc += Math.sin(TAU * W(this.phA, shp)) * gA
             + Math.sin(TAU * W(pb,       shp)) * gB;
      }
      // Makeup gain: the warp trades level for brightness, so the
      // shape knob stays roughly loudness-neutral end to end.
      let s = acc * 0.5 * (1 + 0.55 * shp);

      // One-pole lowpass — takes the edge off the oversampled fold-back
      this.lp += 0.70 * (s - this.lp);
      s = this.lp;

      // DC blocker: phase distortion is not symmetric about zero
      this.dcY = s - this.dcX + 0.9975 * this.dcY;
      this.dcX = s;
      s = this.dcY;

      // Soft clip
      out[i] = s < -1.4 ? -0.95 : s > 1.4 ? 0.95 : s - (s * s * s) / 5.88;
    }
    return !this.dead;
  }
}
registerProcessor('qoix-phase', QoixPhaseProcessor);
`;

  // ── Init ──────────────────────────────────────────────────
  function init() {
    if (ctx) { refreshDest(); return; }
    ctx  = Synth._getContext();
    if (!ctx) return;
    dest = Synth._voiceDestination;

    buildGraph();
    loadWorklet();
  }

  function ensureInit() {
    if (!ctx) init(); else refreshDest();
  }

  // Synth rebuilds its FX chain on quality changes — follow it.
  function refreshDest() {
    if (!ctx || !levelNode) return;
    const d = Synth._voiceDestination;
    if (d && d !== dest) {
      dest = d;
      try { levelNode.disconnect(); } catch (e) {}
      levelNode.connect(dest);
    }
  }

  function loadWorklet() {
    if (workletReady || workletFailed) return;
    if (!ctx.audioWorklet) { workletFailed = true; return; }
    let url;
    try {
      url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    } catch (e) { workletFailed = true; return; }

    ctx.audioWorklet.addModule(url)
      .then(() => { workletReady = true; })
      .catch(err => {
        console.warn('[QOIX] OP-1 worklet unavailable, using PeriodicWave fallback:', err);
        workletFailed = true;
      })
      .finally(() => { try { URL.revokeObjectURL(url); } catch (e) {} });
  }

  // ── Engine output chain ───────────────────────────────────
  function buildGraph() {
    voiceBus   = ctx.createGain();  voiceBus.gain.value = 1;

    driveNode  = ctx.createWaveShaper();
    driveNode.oversample = '2x';

    filterNode = ctx.createBiquadFilter();
    filterNode.type = 'lowpass';

    levelNode  = ctx.createGain();

    voiceBus.connect(driveNode);
    driveNode.connect(filterNode);
    filterNode.connect(levelNode);
    if (dest) levelNode.connect(dest);

    applyFX();
    buildLFO();
  }

  // Drive curve: identity at 0, progressively harder tanh-ish saturation.
  function driveCurve(amount) {
    const n = 1024;
    const c = new Float32Array(n);
    const k = amount * amount * 60;          // 0 → 60
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = k < 0.001 ? x : ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return c;
  }

  function applyFX() {
    if (!ctx) return;
    const f = state.fx;
    driveNode.curve = driveCurve(f.drive);
    // 60 Hz → 18 kHz, exponential so the knob feels even
    filterNode.frequency.value = 60 * Math.pow(300, f.cutoff);
    filterNode.Q.value = 0.7 + f.res * 22;
    // Trim output as drive/resonance add gain
    levelNode.gain.value = f.level * (1 - f.drive * 0.35) * 0.9;
  }

  // ── LFO ───────────────────────────────────────────────────
  function sampleHoldBuffer() {
    // 32 held random steps, one second long at playbackRate 1
    const steps = 32;
    const buf   = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data  = buf.getChannelData(0);
    const span  = Math.floor(data.length / steps);
    for (let s = 0; s < steps; s++) {
      const v = Math.random() * 2 - 1;
      for (let i = s * span; i < (s + 1) * span && i < data.length; i++) data[i] = v;
    }
    return buf;
  }

  function buildLFO() {
    lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0;
    startLFOSource();
    connectLFODest();
  }

  function startLFOSource() {
    if (lfoOsc) { try { lfoOsc.stop(); } catch (e) {} try { lfoOsc.disconnect(); } catch (e) {} }

    if (state.lfo.shape === 'random') {
      lfoOsc = ctx.createBufferSource();
      lfoOsc.buffer = sampleHoldBuffer();
      lfoOsc.loop = true;
      lfoOsc.playbackRate.value = Math.max(0.02, state.lfo.rate / 4);
    } else {
      lfoOsc = ctx.createOscillator();
      lfoOsc.type = state.lfo.shape;
      lfoOsc.frequency.value = state.lfo.rate;
    }
    lfoOsc.connect(lfoDepth);
    try { lfoOsc.start(); } catch (e) {}
  }

  function connectLFODest() {
    try { lfoDepth.disconnect(); } catch (e) {}
    lfoDepth.gain.value = state.lfo.depth * (LFO_SCALE[state.lfo.dest] || 0);

    if (state.lfo.dest === 'cutoff') {
      lfoDepth.connect(filterNode.frequency);
    } else {
      activeVoices.forEach(v => connectLFOToVoice(v));
    }
  }

  function connectLFOToVoice(voice) {
    if (!voice.node || !voice.node.parameters) return;   // fallback voices
    const d = state.lfo.dest;
    if (d === 'cutoff') return;
    const target = voice.node.parameters.get(d === 'pitch' ? 'vibrato' : d);
    if (target) { try { lfoDepth.connect(target); } catch (e) {} }
  }

  // ── Note frequency (honours the microtonal engine) ────────
  function noteFreq(midiNote) {
    if (typeof Microtonal !== 'undefined' && Microtonal.getState && Microtonal.getState().enabled) {
      return Microtonal.noteToFreq(midiNote);
    }
    return 440 * Math.pow(2, (midiNote - 69) / 12);
  }

  // ── PeriodicWave fallback ─────────────────────────────────
  const _pwCache = {};
  function phaseDistortWave(shapeIdx) {
    const key = 'pd' + shapeIdx;
    if (_pwCache[key]) return _pwCache[key];

    const d = shapeIdx / 15;
    const b = 0.5 + 0.45 * d;
    const N = 1024, H = 64;
    const samples = new Float32Array(N);
    for (let n = 0; n < N; n++) {
      const p = n / N;
      const w = p < b ? (0.5 * p / b) : (0.5 + 0.5 * (p - b) / (1 - b));
      samples[n] = Math.sin(2 * Math.PI * w);
    }
    const real = new Float32Array(H), imag = new Float32Array(H);
    for (let k = 1; k < H; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const a = (2 * Math.PI * k * n) / N;
        re += samples[n] * Math.cos(a);
        im -= samples[n] * Math.sin(a);
      }
      real[k] = (2 * re) / N;
      imag[k] = (2 * im) / N;
    }
    _pwCache[key] = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    return _pwCache[key];
  }

  function buildFallbackVoice(freq, now) {
    const wave = phaseDistortWave(Math.round(state.shape * 15));
    const out  = ctx.createGain();

    const oscA = ctx.createOscillator();
    oscA.setPeriodicWave(wave);
    oscA.frequency.value = freq;
    const gA = ctx.createGain();
    gA.gain.value = Math.cos(state.mix * Math.PI * 0.5);
    oscA.connect(gA); gA.connect(out);

    const oscB = ctx.createOscillator();
    oscB.setPeriodicWave(wave);
    oscB.frequency.value = freq;
    oscB.detune.value = state.detune;
    const gB = ctx.createGain();
    gB.gain.value = Math.sin(state.mix * Math.PI * 0.5);
    oscB.connect(gB); gB.connect(out);

    // A fractional-period start delay is an exact static phase offset
    oscA.start(now);
    oscB.start(now + (state.shift % 1) / freq);

    return { node: out, oscs: [oscA, oscB], fbGains: { gA, gB }, fbOscs: { oscA, oscB } };
  }

  // ── Voice stealing ────────────────────────────────────────
  function stealIfNeeded() {
    if (activeVoices.size < MAX_VOICES) return;
    let oldest = null, t = Infinity;
    activeVoices.forEach((v, n) => { if (v.startTime < t) { t = v.startTime; oldest = n; } });
    if (oldest !== null) noteOff(oldest, true);
  }

  // ── Note on ───────────────────────────────────────────────
  function noteOn(midiNote, velocity = 1) {
    ensureInit();
    if (!state.enabled || !ctx) return;
    if (activeVoices.has(midiNote)) noteOff(midiNote, true);
    stealIfNeeded();

    const now  = ctx.currentTime;
    const freq = noteFreq(midiNote);
    const e    = state.env;

    let voice;
    if (workletReady) {
      const node = new AudioWorkletNode(ctx, 'qoix-phase', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
      });
      const p = node.parameters;
      p.get('frequency').setValueAtTime(freq, now);
      p.get('shape').setValueAtTime(state.shape, now);
      p.get('shift').setValueAtTime(state.shift, now);
      p.get('detune').setValueAtTime(state.detune, now);
      p.get('mix').setValueAtTime(state.mix, now);
      voice = { node, oscs: [] };
    } else {
      voice = buildFallbackVoice(freq, now);
    }

    const ampEnv = ctx.createGain();
    ampEnv.gain.setValueAtTime(0.0001, now);
    ampEnv.gain.linearRampToValueAtTime(velocity * 0.85, now + Math.max(0.001, e.attack));
    ampEnv.gain.setTargetAtTime(
      Math.max(0.0001, e.sustain * velocity * 0.85),
      now + e.attack,
      Math.max(0.01, e.decay) / 3
    );

    voice.node.connect(ampEnv);
    ampEnv.connect(voiceBus);
    voice.ampEnv   = ampEnv;
    voice.startTime = now;
    voice.freq     = freq;

    connectLFOToVoice(voice);
    activeVoices.set(midiNote, voice);
  }

  // ── Note off ──────────────────────────────────────────────
  function noteOff(midiNote, immediate = false) {
    const voice = activeVoices.get(midiNote);
    if (!voice || !ctx) return;
    activeVoices.delete(midiNote);

    const now = ctx.currentTime;
    const rel = immediate ? 0.015 : Math.max(0.02, state.env.release);

    try {
      voice.ampEnv.gain.cancelScheduledValues(now);
      voice.ampEnv.gain.setValueAtTime(Math.max(0.0001, voice.ampEnv.gain.value), now);
      voice.ampEnv.gain.exponentialRampToValueAtTime(0.0001, now + rel);
    } catch (e) {}

    const stopAt = now + rel + 0.03;
    voice.oscs.forEach(o => { try { o.stop(stopAt); } catch (e) {} });

    setTimeout(() => { teardown(voice); }, (rel + 0.12) * 1000);
  }

  function teardown(voice) {
    if (voice.node && voice.node.port) { try { voice.node.port.postMessage('stop'); } catch (e) {} }
    try { voice.node.disconnect(); }   catch (e) {}
    try { voice.ampEnv.disconnect(); } catch (e) {}
  }

  // ── Panic ─────────────────────────────────────────────────
  function panic() {
    if (!ctx) return;
    const now = ctx.currentTime;
    activeVoices.forEach(voice => {
      try { voice.ampEnv.gain.cancelScheduledValues(now); } catch (e) {}
      try { voice.ampEnv.gain.setValueAtTime(0, now); }     catch (e) {}
      voice.oscs.forEach(o => { try { o.stop(now); } catch (e) {} });
      teardown(voice);
    });
    activeVoices.clear();
  }

  // ── Live parameter updates ────────────────────────────────
  const GLIDE = 0.012;

  function pushVoiceParam(name, value) {
    if (!ctx) return;
    const now = ctx.currentTime;
    activeVoices.forEach(v => {
      if (v.node && v.node.parameters) {
        const p = v.node.parameters.get(name);
        if (p) { try { p.setTargetAtTime(value, now, GLIDE); } catch (e) {} }
      } else if (v.fbGains) {
        // fallback voices: only mix and detune are steerable live
        if (name === 'mix') {
          v.fbGains.gA.gain.setTargetAtTime(Math.cos(value * Math.PI * 0.5), now, GLIDE);
          v.fbGains.gB.gain.setTargetAtTime(Math.sin(value * Math.PI * 0.5), now, GLIDE);
        } else if (name === 'detune') {
          v.fbOscs.oscB.detune.setTargetAtTime(value, now, GLIDE);
        }
      }
    });
  }

  function setParam(name, value) {
    switch (name) {
      case 'shape':  state.shape  = value; pushVoiceParam('shape',  value); break;
      case 'shift':  state.shift  = value; pushVoiceParam('shift',  value); break;
      case 'detune': state.detune = value; pushVoiceParam('detune', value); break;
      case 'mix':    state.mix    = value; pushVoiceParam('mix',    value); break;
      default: break;
    }
  }

  function setEnv(name, value) { state.env[name] = value; }

  function setFX(name, value) {
    state.fx[name] = value;
    if (ctx) applyFX();
  }

  function setLFO(name, value) {
    state.lfo[name] = value;
    if (!ctx) return;
    if (name === 'rate') {
      if (state.lfo.shape === 'random') lfoOsc.playbackRate.value = Math.max(0.02, value / 4);
      else lfoOsc.frequency.setTargetAtTime(value, ctx.currentTime, 0.02);
    } else if (name === 'shape') {
      startLFOSource();
      connectLFODest();
    } else if (name === 'dest') {
      connectLFODest();
    } else if (name === 'depth') {
      lfoDepth.gain.setTargetAtTime(value * (LFO_SCALE[state.lfo.dest] || 0), ctx.currentTime, 0.02);
    }
  }

  function setEnabled(v) {
    state.enabled = v;
    if (v) { ensureInit(); }
    else   { panic(); }
  }

  function setPage(i) { state.page = Math.max(0, Math.min(3, i)); }

  // ── Patch snapshot / restore ──────────────────────────────
  function getPatch() {
    return JSON.parse(JSON.stringify({
      enabled: state.enabled,
      shape: state.shape, shift: state.shift, detune: state.detune, mix: state.mix,
      env: state.env, fx: state.fx, lfo: state.lfo,
    }));
  }

  function setPatch(p) {
    if (!p) return;
    if (typeof p.enabled === 'boolean') {
      state.enabled = p.enabled;
      if (!p.enabled) panic();
    }
    ['shape', 'shift', 'detune', 'mix'].forEach(k => {
      if (typeof p[k] === 'number') setParam(k, p[k]);
    });
    if (p.env) Object.keys(state.env).forEach(k => { if (typeof p.env[k] === 'number') state.env[k] = p.env[k]; });
    if (p.fx)  Object.keys(state.fx ).forEach(k => { if (typeof p.fx[k]  === 'number') state.fx[k]  = p.fx[k];  });
    if (p.lfo) Object.keys(state.lfo).forEach(k => { if (p.lfo[k] !== undefined) state.lfo[k] = p.lfo[k]; });
    if (ctx) { applyFX(); startLFOSource(); connectLFODest(); }
  }

  // ── Display helper: one cycle of the current waveform ─────
  // Shared by the panel so the drawing always matches the DSP.
  function renderCycle(out, phaseOffset = 0) {
    const n   = out.length;
    const b   = 0.5 + 0.45 * state.shape;
    const gA  = Math.cos(state.mix * Math.PI * 0.5);
    const gB  = Math.sin(state.mix * Math.PI * 0.5);
    const rat = Math.pow(2, state.detune / 1200);
    const warp = p => (p < b ? (0.5 * p / b) : (0.5 + 0.5 * (p - b) / (1 - b)));

    for (let i = 0; i < n; i++) {
      const t  = (i / n) * 2 + phaseOffset;      // two cycles across the display
      const pa = t - Math.floor(t);
      let   pb = t * rat + state.shift;
      pb -= Math.floor(pb);
      out[i] = Math.sin(2 * Math.PI * warp(pa)) * gA
             + Math.sin(2 * Math.PI * warp(pb)) * gB;
    }
    return out;
  }

  function getState()        { return state; }
  function getColors()       { return COLORS; }
  function getActiveVoices() { return activeVoices; }
  function isWorkletActive() { return workletReady; }
  function lfoOptions()      { return { dests: LFO_DESTS, shapes: LFO_SHAPES }; }

  return {
    init, noteOn, noteOff, panic,
    setParam, setEnv, setFX, setLFO, setEnabled, setPage,
    getPatch, setPatch,
    renderCycle, lfoOptions,
    getState, getColors, getActiveVoices, isWorkletActive,
  };

})();
