/* ============================================================
   QOIX Synthesizer — Core Audio Engine
   ============================================================ */

'use strict';

const Synth = (() => {

  // ── Context ───────────────────────────────────────────────
  let ctx = null;
  let masterGain = null;
  let analyser = null;

  // ── Effect nodes (persistent) ─────────────────────────────
  let distortionNode = null;
  let distortionBypass = null;
  let chorusNode = null;
  let chorusLFO = null;
  let chorusBypass = null;
  let delayNode = null;
  let delayFeedback = null;
  let delayWet = null;
  let delayDry = null;
  let reverbNode = null;
  let reverbWet = null;
  let reverbDry = null;

  // ── LFO ───────────────────────────────────────────────────
  let lfoOsc = null;
  let lfoGain = null;

  // ── Active voices ─────────────────────────────────────────
  const activeVoices = new Map(); // midiNote -> voice object

  // ── State ─────────────────────────────────────────────────
  const state = {
    masterVolume: 0.7,
    osc1: { enabled: true,  wave: 'sawtooth', octave: 0, detune: 0,  level: 0.8 },
    osc2: { enabled: false, wave: 'square',   octave: 0, detune: 7,  level: 0.5 },
    noise: { enabled: false, type: 'white', level: 0.2 },
    env:  { attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.3 },
    fenv: { amount: 2000, attack: 0.01, decay: 0.2, sustain: 0.3, release: 0.2 },
    filter: { type: 'lowpass', cutoff: 8000, resonance: 1 },
    lfo:  { enabled: false, wave: 'sine', rate: 4, depth: 0.3, target: 'pitch' },
    dist: { enabled: false, drive: 80 },
    chorus: { enabled: false, rate: 1.5, depth: 0.003, mix: 0.5 },
    delay: { enabled: false, time: 0.375, feedback: 0.4, mix: 0.3 },
    reverb: { enabled: false, size: 2, damp: 0.5, mix: 0.2 },
  };

  // ── Init ──────────────────────────────────────────────────
  function init() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = state.masterVolume;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;

    // Build FX chain: source → dist → chorus → delay → reverb → analyser → master → out
    buildEffectChain();

    masterGain.connect(ctx.destination);
    console.log('[QOIX] Audio engine initialized');
  }

  function ensureContext() {
    if (!ctx) init();
    if (ctx.state === 'suspended') ctx.resume();
  }

  // ── Distortion curve ──────────────────────────────────────
  function makeDistortionCurve(amount) {
    const n = 256;
    const curve = new Float32Array(n);
    const k = amount;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  // ── Reverb IR ─────────────────────────────────────────────
  function buildImpulse(duration, decay) {
    const rate = ctx.sampleRate;
    const len = rate * duration;
    const impulse = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const ch_data = impulse.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        ch_data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return impulse;
  }

  // ── Build FX chain ────────────────────────────────────────
  function buildEffectChain() {
    const s = state;

    // Distortion
    distortionNode = ctx.createWaveShaper();
    distortionNode.curve = makeDistortionCurve(s.dist.drive);
    distortionNode.oversample = '4x';
    distortionBypass = ctx.createGain();
    distortionBypass.gain.value = s.dist.enabled ? 0 : 1;

    // Chorus (delay-based)
    const chorusDelay = ctx.createDelay(0.1);
    chorusDelay.delayTime.value = 0.02;
    chorusLFO = ctx.createOscillator();
    chorusLFO.frequency.value = s.chorus.rate;
    const chorusLFOGain = ctx.createGain();
    chorusLFOGain.gain.value = s.chorus.depth;
    chorusLFO.connect(chorusLFOGain);
    chorusLFOGain.connect(chorusDelay.delayTime);
    chorusLFO.start();
    const chorusWet = ctx.createGain();
    chorusWet.gain.value = s.chorus.enabled ? s.chorus.mix : 0;
    chorusBypass = ctx.createGain();
    chorusBypass.gain.value = 1;

    // Delay
    delayNode = ctx.createDelay(2);
    delayNode.delayTime.value = s.delay.time;
    delayFeedback = ctx.createGain();
    delayFeedback.gain.value = s.delay.feedback;
    delayWet = ctx.createGain();
    delayWet.gain.value = s.delay.enabled ? s.delay.mix : 0;
    delayDry = ctx.createGain();
    delayDry.gain.value = 1;
    delayNode.connect(delayFeedback);
    delayFeedback.connect(delayNode);
    delayNode.connect(delayWet);

    // Reverb
    reverbNode = ctx.createConvolver();
    reverbNode.buffer = buildImpulse(s.reverb.size, s.reverb.damp * 5 + 1);
    reverbWet = ctx.createGain();
    reverbWet.gain.value = s.reverb.enabled ? s.reverb.mix : 0;
    reverbDry = ctx.createGain();
    reverbDry.gain.value = 1;

    // Connect chain
    // Main path: distortionBypass + distortionNode merge → chorus → delay split → reverb split → analyser
    const preFX = ctx.createGain(); // single merge point

    // Distortion split
    distortionNode.connect(preFX);
    distortionBypass.connect(preFX);

    // Chorus
    preFX.connect(chorusBypass);
    preFX.connect(chorusDelay);
    chorusDelay.connect(chorusWet);
    const postChorus = ctx.createGain();
    chorusBypass.connect(postChorus);
    chorusWet.connect(postChorus);

    // Delay
    postChorus.connect(delayDry);
    postChorus.connect(delayNode);
    const postDelay = ctx.createGain();
    delayDry.connect(postDelay);
    delayWet.connect(postDelay);

    // Reverb
    postDelay.connect(reverbDry);
    postDelay.connect(reverbNode);
    reverbNode.connect(reverbWet);
    const postReverb = ctx.createGain();
    reverbDry.connect(postReverb);
    reverbWet.connect(postReverb);

    postReverb.connect(analyser);
    analyser.connect(masterGain);

    // Save reference so voices can connect to distortion inputs
    Synth._fxInput = { distortionNode, distortionBypass };
    Synth._preChorusRef = preFX;

    // Actually voices will connect directly to preFX
    Synth._voiceDestination = preFX;
  }

  // ── Noise buffer ──────────────────────────────────────────
  const _noiseBuffers = {};
  function getNoiseBuffer(type) {
    if (_noiseBuffers[type]) return _noiseBuffers[type];
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    if (type === 'white') {
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } else {
      // Pink noise approximation
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0;
      for (let i = 0; i < len; i++) {
        const wh = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + wh * 0.0555179;
        b1 = 0.99332 * b1 + wh * 0.0750759;
        b2 = 0.96900 * b2 + wh * 0.1538520;
        b3 = 0.86650 * b3 + wh * 0.3104856;
        b4 = 0.55000 * b4 + wh * 0.5329522;
        b5 = -0.7616 * b5 - wh * 0.0168980;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + wh * 0.5362) * 0.11;
      }
    }
    _noiseBuffers[type] = buf;
    return buf;
  }

  // ── Note on ───────────────────────────────────────────────
  function noteOn(midiNote, velocity = 1) {
    ensureContext();
    if (activeVoices.has(midiNote)) noteOff(midiNote, true);

    const freq = midiToFreq(midiNote);
    const now = ctx.currentTime;
    const s = state;

    // Voice gain (amp envelope)
    const ampEnv = ctx.createGain();
    ampEnv.gain.setValueAtTime(0, now);
    ampEnv.gain.linearRampToValueAtTime(velocity, now + s.env.attack);
    ampEnv.gain.linearRampToValueAtTime(s.env.sustain * velocity, now + s.env.attack + s.env.decay);

    // Filter node
    const filter = ctx.createBiquadFilter();
    filter.type = s.filter.type;
    filter.frequency.setValueAtTime(s.filter.cutoff, now);
    filter.Q.value = s.filter.resonance;

    // Filter envelope
    const fEnvAmount = s.fenv.amount;
    if (fEnvAmount !== 0) {
      const baseCutoff = s.filter.cutoff;
      filter.frequency.setValueAtTime(baseCutoff, now);
      filter.frequency.linearRampToValueAtTime(
        clamp(baseCutoff + fEnvAmount, 20, 20000), now + s.fenv.attack
      );
      filter.frequency.linearRampToValueAtTime(
        clamp(baseCutoff + fEnvAmount * s.fenv.sustain, 20, 20000),
        now + s.fenv.attack + s.fenv.decay
      );
    }

    // Oscillators
    const oscs = [];

    if (s.osc1.enabled) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = s.osc1.wave;
      osc.frequency.value = freq * Math.pow(2, s.osc1.octave);
      osc.detune.value = s.osc1.detune;
      gain.gain.value = s.osc1.level;
      osc.connect(gain);
      gain.connect(filter);
      osc.start(now);
      oscs.push(osc);
    }

    if (s.osc2.enabled) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = s.osc2.wave;
      osc.frequency.value = freq * Math.pow(2, s.osc2.octave);
      osc.detune.value = s.osc2.detune;
      gain.gain.value = s.osc2.level;
      osc.connect(gain);
      gain.connect(filter);
      osc.start(now);
      oscs.push(osc);
    }

    if (s.noise.enabled) {
      const src = ctx.createBufferSource();
      src.buffer = getNoiseBuffer(s.noise.type);
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = s.noise.level;
      src.connect(gain);
      gain.connect(filter);
      src.start(now);
      oscs.push(src);
    }

    // LFO
    if (s.lfo.enabled && lfoOsc) {
      const lfoTarget = s.lfo.target;
      if (lfoTarget === 'pitch') {
        oscs.forEach(o => {
          if (o.detune) lfoGain.connect(o.detune);
        });
      } else if (lfoTarget === 'filter') {
        lfoGain.connect(filter.frequency);
      } else if (lfoTarget === 'amplitude') {
        lfoGain.connect(ampEnv.gain);
      }
    }

    filter.connect(ampEnv);
    ampEnv.connect(Synth._voiceDestination);

    activeVoices.set(midiNote, { oscs, ampEnv, filter, startTime: now });
    UI && UI.updateActiveNotes && UI.updateActiveNotes();
  }

  // ── Note off ──────────────────────────────────────────────
  function noteOff(midiNote, immediate = false) {
    const voice = activeVoices.get(midiNote);
    if (!voice) return;

    const now = ctx.currentTime;
    const rel = immediate ? 0.02 : state.env.release;
    const fRel = immediate ? 0.02 : state.fenv.release;

    voice.ampEnv.gain.cancelScheduledValues(now);
    voice.ampEnv.gain.setValueAtTime(voice.ampEnv.gain.value, now);
    voice.ampEnv.gain.linearRampToValueAtTime(0, now + rel);

    if (state.fenv.amount !== 0) {
      voice.filter.frequency.cancelScheduledValues(now);
      voice.filter.frequency.setValueAtTime(voice.filter.frequency.value, now);
      voice.filter.frequency.linearRampToValueAtTime(state.filter.cutoff, now + fRel);
    }

    const stopTime = now + rel + 0.05;
    voice.oscs.forEach(o => {
      try { o.stop(stopTime); } catch (e) { /* ignore */ }
    });

    setTimeout(() => {
      activeVoices.delete(midiNote);
      UI && UI.updateActiveNotes && UI.updateActiveNotes();
    }, (rel + 0.1) * 1000);

    activeVoices.delete(midiNote);
    UI && UI.updateActiveNotes && UI.updateActiveNotes();
  }

  // ── Panic ─────────────────────────────────────────────────
  function panic() {
    activeVoices.forEach((_, note) => noteOff(note, true));
    activeVoices.clear();
    UI && UI.updateActiveNotes && UI.updateActiveNotes();
  }

  // ── LFO management ───────────────────────────────────────
  function startLFO() {
    if (lfoOsc) { lfoOsc.stop(); lfoOsc.disconnect(); }
    lfoOsc = ctx.createOscillator();
    lfoGain = ctx.createGain();
    lfoOsc.type = state.lfo.wave;
    lfoOsc.frequency.value = state.lfo.rate;
    lfoGain.gain.value = computeLFODepth();
    lfoOsc.connect(lfoGain);
    lfoOsc.start();
  }

  function stopLFO() {
    if (lfoOsc) { try { lfoOsc.stop(); } catch(e){} lfoOsc.disconnect(); }
    if (lfoGain) lfoGain.disconnect();
    lfoOsc = null;
    lfoGain = null;
  }

  function computeLFODepth() {
    const d = state.lfo.depth;
    switch (state.lfo.target) {
      case 'pitch':     return d * 200;     // cents
      case 'filter':    return d * 5000;    // Hz
      case 'amplitude': return d * 0.5;
      case 'pan':       return d;
    }
    return d;
  }

  // ── Param updates ─────────────────────────────────────────
  function setMasterVolume(v) {
    state.masterVolume = v;
    if (masterGain) masterGain.gain.value = v;
  }

  function setOsc(oscKey, param, value) {
    state[oscKey][param] = value;
  }

  function setEnv(param, value) { state.env[param] = value; }
  function setFEnv(param, value) { state.fenv[param] = value; }

  function setFilter(param, value) {
    state.filter[param] = value;
  }

  function setLFO(param, value) {
    state.lfo[param] = value;
    if (lfoOsc) {
      if (param === 'rate') lfoOsc.frequency.value = value;
      if (param === 'depth') lfoGain.gain.value = computeLFODepth();
      if (param === 'wave') lfoOsc.type = value;
      if (param === 'target') lfoGain.gain.value = computeLFODepth();
    }
    if (param === 'enabled') {
      if (value) startLFO();
      else stopLFO();
    }
  }

  function setDistortion(param, value) {
    state.dist[param] = value;
    if (!distortionNode) return;
    if (param === 'drive') distortionNode.curve = makeDistortionCurve(value);
    if (param === 'enabled') {
      distortionBypass.gain.value = value ? 0 : 1;
    }
  }

  function setChorus(param, value) {
    state.chorus[param] = value;
    if (!chorusLFO) return;
    if (param === 'rate') chorusLFO.frequency.value = value;
    if (param === 'mix' || param === 'enabled') {
      // Find chorusWet gain - simplify by rebuilding
      // For now: just update state, toggled on rebuild
    }
    if (param === 'enabled') {
      // Update wet gain
      _updateChorusMix();
    }
    if (param === 'mix') _updateChorusMix();
  }

  function _updateChorusMix() {
    // We need a reference to chorusWet - let's store it
    if (Synth._chorusWetGain) {
      Synth._chorusWetGain.gain.value = state.chorus.enabled ? state.chorus.mix : 0;
    }
  }

  function setDelay(param, value) {
    state.delay[param] = value;
    if (param === 'time' && delayNode) delayNode.delayTime.value = value;
    if (param === 'feedback' && delayFeedback) delayFeedback.gain.value = value;
    if (param === 'mix' || param === 'enabled') {
      if (delayWet) delayWet.gain.value = state.delay.enabled ? state.delay.mix : 0;
    }
  }

  function setReverb(param, value) {
    state.reverb[param] = value;
    if ((param === 'size' || param === 'damp') && reverbNode) {
      reverbNode.buffer = buildImpulse(state.reverb.size, state.reverb.damp * 5 + 1);
    }
    if (param === 'mix' || param === 'enabled') {
      if (reverbWet) reverbWet.gain.value = state.reverb.enabled ? state.reverb.mix : 0;
    }
  }

  // ── Load preset ───────────────────────────────────────────
  function loadPreset(preset) {
    // Deep merge preset into state
    deepMerge(state, preset);

    // Rebuild noise buffers if needed
    Object.keys(_noiseBuffers).forEach(k => delete _noiseBuffers[k]);

    // Sync LFO
    if (state.lfo.enabled) {
      if (!lfoOsc) startLFO();
      else {
        lfoOsc.frequency.value = state.lfo.rate;
        lfoOsc.type = state.lfo.wave;
        lfoGain.gain.value = computeLFODepth();
      }
    } else {
      stopLFO();
    }

    // Sync FX nodes
    setDistortion('enabled', state.dist.enabled);
    setDistortion('drive', state.dist.drive);
    setDelay('enabled', state.delay.enabled);
    setDelay('time', state.delay.time);
    setDelay('feedback', state.delay.feedback);
    setDelay('mix', state.delay.mix);
    setReverb('enabled', state.reverb.enabled);
    setReverb('size', state.reverb.size);
    setReverb('damp', state.reverb.damp);
    setReverb('mix', state.reverb.mix);
    setMasterVolume(state.masterVolume);
  }

  // ── Helpers ───────────────────────────────────────────────
  function midiToFreq(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function deepMerge(target, source) {
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key]) target[key] = {};
        deepMerge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
  }

  function getState() { return state; }
  function getAnalyser() { return analyser; }
  function getActiveVoices() { return activeVoices; }
  function _getContext() { return ctx; }

  return {
    init, ensureContext,
    noteOn, noteOff, panic,
    setMasterVolume,
    setOsc, setEnv, setFEnv,
    setFilter, setLFO,
    setDistortion, setChorus, setDelay, setReverb,
    loadPreset,
    getState, getAnalyser, getActiveVoices,
    midiToFreq, _getContext,
    _voiceDestination: null,
    _chorusWetGain: null,
  };

})();
