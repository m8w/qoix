/* ============================================================
   QOIX Synthesizer — Core Audio Engine
   ============================================================ */

'use strict';

const Synth = (() => {

  // ── Context ───────────────────────────────────────────────
  let ctx = null;
  let masterGain = null;
  let masterPanner = null;
  let modAmpGain = null;   // mod matrix Amplitude destination (tremolo VCA)
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

  // ── Mod matrix bus (ConstantSourceNodes, persistent) ─────
  let modBusPitch     = null;   // → all osc detune  (cents)
  let modBusFilterCut = null;   // → master filter freq (Hz)
  let modBusOsc1Det   = null;   // → osc1 detune (cents)
  let modBusOsc2Det   = null;
  let modBusOsc3Det   = null;
  let modBusPan       = null;   // → master pan (-1..+1)

  // Mod matrix JS state
  let jsLFOPhase    = 0;
  let _lastNoteVal  = 0;   // 0..1
  let _lastVelVal   = 0;   // 0..1

  // ── Active voices ─────────────────────────────────────────
  const activeVoices = new Map(); // midiNote -> voice object

  // ── Quality / performance settings ───────────────────────
  // Defaults tuned for M2 Mac; reduce for lower-end hardware
  const quality = {
    maxVoices:    64,      // polyphony limit (voice stealing kicks in above this)
    fftSize:      4096,    // analyser resolution (must be power of 2, max 32768)
    reverbDense:  true,    // use denser early-reflection IR (more CPU, better quality)
    distCurve:    1024,    // distortion waveshaper table resolution
    noiseSeconds: 4,       // seconds of noise buffer (longer = less audible loop)
  };

  // ── State ─────────────────────────────────────────────────
  const state = {
    masterVolume: 0.7,
    masterPan: 0,          // -1 = hard left, 0 = centre, +1 = hard right
    osc1: { enabled: true,  wave: 'sawtooth', octave: 0,  detune: 0,  level: 0.8, pan: 0, voices: 1, unisonSpread: 20,
            filter: { type: 'lowpass', cutoff: 18000, resonance: 0.7, lfoDepth: 0, envAmt: 0 },
            fmFrom: 'none', fmIndex: 0.5 },
    osc2: { enabled: false, wave: 'square',   octave: 0,  detune: 7,  level: 0.5, pan: 0, voices: 1, unisonSpread: 20,
            filter: { type: 'lowpass', cutoff: 18000, resonance: 0.7, lfoDepth: 0, envAmt: 0 },
            fmFrom: 'none', fmIndex: 0.5, mixMode: 'add' },
    osc3: { enabled: false, wave: 'triangle', octave: -1, detune: -7, level: 0.5, pan: 0, voices: 1, unisonSpread: 20,
            filter: { type: 'lowpass', cutoff: 18000, resonance: 0.7, lfoDepth: 0, envAmt: 0 },
            fmFrom: 'none', fmIndex: 0.5, mixMode: 'add' },
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
    analyser.fftSize = quality.fftSize;
    analyser.smoothingTimeConstant = 0.82;

    // Master pan sits between the analyser and the master gain, so the LFO
    // auto-pan and the mod matrix Pan destination move the whole mix.
    masterPanner = ctx.createStereoPanner();
    masterPanner.pan.value = clamp(state.masterPan, -1, 1);

    // Mod matrix Amplitude VCA — unity until something is routed to it, and
    // placed before the analyser so the visualiser shows the tremolo.
    modAmpGain = ctx.createGain();
    modAmpGain.gain.value = 1;

    // Build FX chain: source → dist → chorus → delay → reverb → analyser → master → out
    buildEffectChain();

    masterGain.connect(ctx.destination);

    // Mod matrix ConstantSource buses
    function makeModBus() {
      const cs = ctx.createConstantSource();
      cs.offset.value = 0;
      cs.start();
      return cs;
    }
    modBusPitch     = makeModBus();
    modBusFilterCut = makeModBus();
    modBusOsc1Det   = makeModBus();
    modBusOsc2Det   = makeModBus();
    modBusOsc3Det   = makeModBus();
    modBusPan       = makeModBus();
    modBusPan.connect(masterPanner.pan);

    console.log(`[QOIX] Audio engine initialized — ${ctx.sampleRate}Hz, ${quality.maxVoices} voices, FFT ${quality.fftSize}`);
  }

  // ── Quality setters (call before or after init) ───────────
  function setQuality(param, value) {
    quality[param] = value;
    if (param === 'fftSize' && analyser) {
      analyser.fftSize = value;
    }
    if (param === 'maxVoices') {
      // Voice stealing will use new limit on next noteOn
    }
  }

  function getQuality() { return quality; }

  function ensureContext() {
    if (!ctx) init();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  // ── Distortion curve ──────────────────────────────────────
  function makeDistortionCurve(amount) {
    const n = quality.distCurve;
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
    const len = Math.floor(rate * duration);
    const impulse = ctx.createBuffer(2, len, rate);

    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      if (quality.reverbDense) {
        // Denser IR: early reflections + exponential tail (better quality, M2-friendly)
        const earlyEnd = Math.min(Math.floor(rate * 0.08), len); // 80ms early reflections
        for (let i = 0; i < len; i++) {
          const env = Math.pow(1 - i / len, decay);
          // Early reflections: stronger, slightly correlated L/R
          const early = i < earlyEnd ? (Math.random() * 2 - 1) * 1.5 : 0;
          // Late tail: diffuse noise
          const late  = (Math.random() * 2 - 1);
          data[i] = (early + late) * env * 0.5;
        }
      } else {
        // Lightweight IR: simple exponential noise
        for (let i = 0; i < len; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        }
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

    postReverb.connect(modAmpGain);
    modAmpGain.connect(analyser);
    analyser.connect(masterPanner);
    masterPanner.connect(masterGain);

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
    const len = ctx.sampleRate * quality.noiseSeconds;
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

  // ── Voice stealing: kill oldest voice when at polyphony limit ──
  function stealVoiceIfNeeded() {
    if (activeVoices.size < quality.maxVoices) return;
    // Find the oldest voice (smallest startTime)
    let oldestNote = null, oldestTime = Infinity;
    activeVoices.forEach((voice, note) => {
      if (voice.startTime < oldestTime) { oldestTime = voice.startTime; oldestNote = note; }
    });
    if (oldestNote !== null) noteOff(oldestNote, true);
  }

  // ── Note on ───────────────────────────────────────────────
  function noteOn(midiNote, velocity = 1) {
    ensureContext();
    if (activeVoices.has(midiNote)) noteOff(midiNote, true);
    stealVoiceIfNeeded();

    _lastNoteVal = midiNote / 127;
    _lastVelVal  = velocity;

    const freq = midiToFreq(midiNote);
    const now = ctx.currentTime;
    const s = state;

    // Voice gain (amp envelope)
    const ampEnv = ctx.createGain();
    ampEnv.gain.setValueAtTime(0, now);
    ampEnv.gain.linearRampToValueAtTime(velocity, now + s.env.attack);
    ampEnv.gain.linearRampToValueAtTime(s.env.sustain * velocity, now + s.env.attack + s.env.decay);

    // Oscillators
    const oscs = [];
    // Per-osc filters keyed by osc name
    const oscFilters = {};
    // Per-osc stereo panners keyed by osc name (filter → panner → mixer)
    const oscPanners = {};

    // Mixer: merges all per-osc filter outputs before the master filter
    const oscMixer = ctx.createGain();

    // Each oscillator gets its own stereo panner so OSC 1/2/3 can be placed
    // independently across the stereo field.
    function makeOscPanner(oscState) {
      const p = ctx.createStereoPanner();
      p.pan.setValueAtTime(clamp(oscState.pan || 0, -1, 1), now);
      p.connect(oscMixer);
      return p;
    }

    function makeOscFilter(fState, targetNode) {
      const f = ctx.createBiquadFilter();
      f.type = fState.type;
      f.frequency.setValueAtTime(fState.cutoff, now);
      f.Q.value = fState.resonance;

      // Per-osc filter envelope using global fenv ADSR shape scaled by envAmt
      if (fState.envAmt !== 0) {
        const base = fState.cutoff;
        const amt  = fState.envAmt;
        f.frequency.setValueAtTime(base, now);
        f.frequency.linearRampToValueAtTime(
          clamp(base + amt, 20, 20000), now + s.fenv.attack
        );
        f.frequency.linearRampToValueAtTime(
          clamp(base + amt * s.fenv.sustain, 20, 20000),
          now + s.fenv.attack + s.fenv.decay
        );
      }

      // Per-osc filter LFO modulation (independent of global LFO target)
      if (s.lfo.enabled && lfoOsc && fState.lfoDepth > 0) {
        const lfoFiltGain = ctx.createGain();
        lfoFiltGain.gain.value = fState.lfoDepth * s.lfo.depth * 5000;
        lfoOsc.connect(lfoFiltGain);
        lfoFiltGain.connect(f.frequency);
      }

      f.connect(targetNode);
      return f;
    }

    const oscGroups = { osc1: [], osc2: [], osc3: [] };
    const rawSums   = {};

    // Build unison voices for one osc; returns a GainNode summing all voices (pre-filter)
    function buildUnisonOsc(oscState, group) {
      const rawSum  = ctx.createGain();
      rawSum.gain.value = 1;
      const nVoices = Math.max(1, Math.round(oscState.voices || 1));
      const spread  = oscState.unisonSpread || 0;
      for (let v = 0; v < nVoices; v++) {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = oscState.wave;
        osc.frequency.value = freq * Math.pow(2, oscState.octave);
        const spreadOffset = nVoices > 1 ? ((v / (nVoices - 1)) - 0.5) * 2 * spread : 0;
        osc.detune.value = oscState.detune + spreadOffset;
        gain.gain.value = oscState.level / nVoices;
        osc.connect(gain);
        gain.connect(rawSum);
        osc.start(now);
        oscs.push(osc);
        group.push(osc);
      }
      return rawSum;
    }

    if (s.osc1.enabled) rawSums.osc1 = buildUnisonOsc(s.osc1, oscGroups.osc1);
    if (s.osc2.enabled) rawSums.osc2 = buildUnisonOsc(s.osc2, oscGroups.osc2);
    if (s.osc3.enabled) rawSums.osc3 = buildUnisonOsc(s.osc3, oscGroups.osc3);

    // ── OSC-to-OSC FM routing ─────────────────────────────────
    // Kept per voice so the mod matrix FM Index destination can move them
    const fmGains = [];
    ['osc1', 'osc2', 'osc3'].forEach(tgtKey => {
      const tgtState = s[tgtKey];
      const srcKey   = tgtState.fmFrom;
      if (!srcKey || srcKey === 'none' || !rawSums[srcKey] || !oscGroups[tgtKey].length) return;
      const fmGain = ctx.createGain();
      const baseFreq = freq * Math.pow(2, tgtState.octave);
      fmGain.gain.value = (tgtState.fmIndex || 0) * baseFreq;
      rawSums[srcKey].connect(fmGain);
      oscGroups[tgtKey].forEach(o => fmGain.connect(o.frequency));
      fmGains.push({ node: fmGain, baseFreq, oscKey: tgtKey });
    });

    // ── Mix mode: route rawSum → [processing] → per-osc filter ──
    function routeOscToFilter(rawSum, oscState, filterNode) {
      const mode = oscState.mixMode || 'add';
      if (mode === 'sub') {
        const negGain = ctx.createGain();
        negGain.gain.value = -1;
        rawSum.connect(negGain);
        negGain.connect(filterNode);
      } else if (mode === 'ring' && rawSums.osc1 && rawSum !== rawSums.osc1) {
        // Ring mod: osc1 amplitude-modulates this osc
        const ringGain = ctx.createGain();
        ringGain.gain.value = 0;
        rawSums.osc1.connect(ringGain.gain);
        rawSum.connect(ringGain);
        ringGain.connect(filterNode);
      } else if (mode === 'xor' && rawSums.osc1 && rawSum !== rawSums.osc1) {
        // XOR approx: full-wave rectify(this - osc1)
        const negA = ctx.createGain();
        negA.gain.value = -1;
        rawSums.osc1.connect(negA);
        const diff = ctx.createGain();
        rawSum.connect(diff);
        negA.connect(diff);
        const absShaper = ctx.createWaveShaper();
        const absCurve = new Float32Array(512);
        for (let i = 0; i < 512; i++) absCurve[i] = Math.abs((i / 511) * 2 - 1);
        absShaper.curve = absCurve;
        diff.connect(absShaper);
        absShaper.connect(filterNode);
      } else {
        rawSum.connect(filterNode);
      }
    }

    if (s.osc1.enabled) {
      const p1 = makeOscPanner(s.osc1);
      const f1 = makeOscFilter(s.osc1.filter, p1);
      oscPanners.osc1 = p1;
      oscFilters.osc1 = f1;
      rawSums.osc1.connect(f1);
    }
    if (s.osc2.enabled) {
      const p2 = makeOscPanner(s.osc2);
      const f2 = makeOscFilter(s.osc2.filter, p2);
      oscPanners.osc2 = p2;
      oscFilters.osc2 = f2;
      routeOscToFilter(rawSums.osc2, s.osc2, f2);
    }
    if (s.osc3.enabled) {
      const p3 = makeOscPanner(s.osc3);
      const f3 = makeOscFilter(s.osc3.filter, p3);
      oscPanners.osc3 = p3;
      oscFilters.osc3 = f3;
      routeOscToFilter(rawSums.osc3, s.osc3, f3);
    }

    if (s.noise.enabled) {
      const src = ctx.createBufferSource();
      src.buffer = getNoiseBuffer(s.noise.type);
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = s.noise.level;
      src.connect(gain);
      gain.connect(oscMixer);
      src.start(now);
      oscs.push(src);
    }

    // Master filter
    const filter = ctx.createBiquadFilter();
    filter.type = s.filter.type;
    filter.frequency.setValueAtTime(s.filter.cutoff, now);
    filter.Q.value = s.filter.resonance;

    // Master filter envelope
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

    // LFO routing
    if (s.lfo.enabled && lfoOsc) {
      const lfoTarget = s.lfo.target;
      if (lfoTarget === 'pitch') {
        oscs.forEach(o => { if (o.detune) lfoGain.connect(o.detune); });
      } else if (lfoTarget === 'filter') {
        lfoGain.connect(filter.frequency);
      } else if (lfoTarget === 'amplitude') {
        lfoGain.connect(ampEnv.gain);
      }
    }

    oscMixer.connect(filter);
    filter.connect(ampEnv);
    ampEnv.connect(Synth._voiceDestination);

    // Connect mod matrix buses (ConstantSourceNodes add to AudioParam automation)
    const modBusConns = [];
    function conn(bus, param) {
      if (!bus) return;
      bus.connect(param);
      modBusConns.push({ node: bus, param });
    }
    [...oscGroups.osc1, ...oscGroups.osc2, ...oscGroups.osc3].forEach(o => conn(modBusPitch, o.detune));
    oscGroups.osc1.forEach(o => conn(modBusOsc1Det, o.detune));
    oscGroups.osc2.forEach(o => conn(modBusOsc2Det, o.detune));
    oscGroups.osc3.forEach(o => conn(modBusOsc3Det, o.detune));
    conn(modBusFilterCut, filter.frequency);

    activeVoices.set(midiNote, { oscs, oscMixer, oscGroups, ampEnv, filter, oscFilters, oscPanners, fmGains, modBusConns, startTime: now });
    UI && UI.updateActiveNotes && UI.updateActiveNotes();
  }

  // ── Note off ──────────────────────────────────────────────
  function noteOff(midiNote, immediate = false) {
    const voice = activeVoices.get(midiNote);
    if (!voice) return;

    const now = ctx.currentTime;
    const rel = immediate ? 0.02 : state.env.release;
    const fRel = immediate ? 0.02 : state.fenv.release;

    // Disconnect mod matrix buses from this voice's params
    if (voice.modBusConns) {
      voice.modBusConns.forEach(({ node, param }) => {
        try { node.disconnect(param); } catch(e) {}
      });
    }

    voice.ampEnv.gain.cancelScheduledValues(now);
    voice.ampEnv.gain.setValueAtTime(voice.ampEnv.gain.value, now);
    voice.ampEnv.gain.linearRampToValueAtTime(0, now + rel);

    if (state.fenv.amount !== 0) {
      voice.filter.frequency.cancelScheduledValues(now);
      voice.filter.frequency.setValueAtTime(voice.filter.frequency.value, now);
      voice.filter.frequency.linearRampToValueAtTime(state.filter.cutoff, now + fRel);
    }

    // Release per-osc filter envelopes
    if (voice.oscFilters) {
      ['osc1', 'osc2', 'osc3'].forEach(key => {
        const f = voice.oscFilters[key];
        if (!f || !state[key] || state[key].filter.envAmt === 0) return;
        f.frequency.cancelScheduledValues(now);
        f.frequency.setValueAtTime(f.frequency.value, now);
        f.frequency.linearRampToValueAtTime(state[key].filter.cutoff, now + fRel);
      });
    }

    const stopTime = now + rel + 0.05;
    voice.oscs.forEach(o => {
      try { o.stop(stopTime); } catch (e) { /* ignore */ }
    });

    // Keep voice in activeVoices until release is fully done so panic() can reach it.
    // The note is removed from the active-notes display immediately but the audio nodes
    // remain tracked so they can be hard-killed if needed.
    UI && UI.updateActiveNotes && UI.updateActiveNotes();
    setTimeout(() => {
      // Only drop the map entry if it is still *this* voice. Replaying the same
      // note during its release tail installs a new voice under the same key —
      // deleting it here would leave that new voice untracked and sounding
      // forever (no noteOff and no panic could ever reach it).
      if (activeVoices.get(midiNote) === voice) activeVoices.delete(midiNote);
      // Disconnect the remaining chain after release tail to free memory
      try { voice.oscMixer.disconnect(); } catch(e) {}
      try { voice.filter.disconnect();   } catch(e) {}
      try { voice.ampEnv.disconnect();   } catch(e) {}
      if (voice.oscPanners) {
        Object.values(voice.oscPanners).forEach(pn => { try { pn.disconnect(); } catch(e) {} });
      }
      if (voice.oscFilters) {
        Object.values(voice.oscFilters).forEach(f => { try { f.disconnect(); } catch(e) {} });
      }
      // The note list still showed the note through its release tail and was
      // never refreshed once the tail ended, leaving phantom "held" notes.
      UI && UI.updateActiveNotes && UI.updateActiveNotes();
    }, (rel + 0.15) * 1000);
  }

  // ── Panic ─────────────────────────────────────────────────
  function panic() {
    if (!ctx) return;
    const now = ctx.currentTime;

    // 1. Instantly silence master output
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(0, now);

    // 2. Hard-kill every tracked voice (including those in release phase)
    activeVoices.forEach(voice => {
      // Disconnect mod matrix buses
      if (voice.modBusConns) {
        voice.modBusConns.forEach(({ node, param }) => { try { node.disconnect(param); } catch(e) {} });
      }
      // Stop all source nodes immediately
      voice.oscs.forEach(o => { try { o.stop(now); } catch(e) {} });
      // Sever the entire per-voice signal chain from top to bottom
      try { voice.oscMixer.disconnect(); } catch(e) {}
      if (voice.oscFilters) {
        Object.values(voice.oscFilters).forEach(f => { try { f.disconnect(); } catch(e) {} });
      }
      if (voice.oscPanners) {
        Object.values(voice.oscPanners).forEach(pn => { try { pn.disconnect(); } catch(e) {} });
      }
      try { voice.filter.disconnect(); } catch(e) {}
      try { voice.ampEnv.gain.cancelScheduledValues(now); } catch(e) {}
      try { voice.ampEnv.disconnect(); } catch(e) {}
    });
    activeVoices.clear();

    // 3. Restore master gain with a very short anti-click ramp
    masterGain.gain.linearRampToValueAtTime(state.masterVolume, now + 0.025);

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
    lfoPanConnected = false;
    updateLFOPanRouting();
  }

  function stopLFO() {
    if (lfoOsc) { try { lfoOsc.stop(); } catch(e){} lfoOsc.disconnect(); }
    if (lfoGain) lfoGain.disconnect();
    lfoOsc = null;
    lfoGain = null;
    lfoPanConnected = false;
  }

  // Auto-pan is a *global* target: it drives the master panner once, rather
  // than being wired per-voice like pitch/filter/amp (which would stack up
  // one LFO connection per held note).
  let lfoPanConnected = false;
  function updateLFOPanRouting() {
    if (!masterPanner) return;
    const want = !!(lfoGain && state.lfo.enabled && state.lfo.target === 'pan');
    if (want && !lfoPanConnected) {
      lfoGain.connect(masterPanner.pan);
      lfoPanConnected = true;
    } else if (!want && lfoPanConnected) {
      try { lfoGain.disconnect(masterPanner.pan); } catch(e) {}
      lfoPanConnected = false;
    }
  }

  // Bipolar waveform used by the JS-side LFO 1 mirror, matching the shape
  // selected for the audio LFO
  function lfoShape(wave, phase) {
    const t = (phase / (Math.PI * 2)) % 1;
    switch (wave) {
      case 'triangle': return 4 * Math.abs(t - 0.5) - 1;
      case 'square':   return t < 0.5 ? 1 : -1;
      case 'sawtooth': return t * 2 - 1;
      default:         return Math.sin(phase);
    }
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
    // Pan is audible on held notes, so move the live voices too
    if (param === 'pan' && ctx) {
      const now = ctx.currentTime;
      const v = clamp(value, -1, 1);
      activeVoices.forEach(voice => {
        const pn = voice.oscPanners && voice.oscPanners[oscKey];
        if (pn) pn.pan.setValueAtTime(v, now);
      });
    }
  }

  // Master pan: the base position the LFO auto-pan and the mod matrix Pan
  // destination modulate around.
  function setMasterPan(v) {
    state.masterPan = clamp(parseFloat(v) || 0, -1, 1);
    if (masterPanner) masterPanner.pan.setValueAtTime(state.masterPan, ctx.currentTime);
  }

  function setEnv(param, value) { state.env[param] = value; }
  function setFEnv(param, value) { state.fenv[param] = value; }

  function setFilter(param, value) {
    state.filter[param] = value;
  }

  function setOscFilter(oscKey, param, value) {
    state[oscKey].filter[param] = value;
    if (!ctx) return;
    const now = ctx.currentTime;
    activeVoices.forEach(voice => {
      const f = voice.oscFilters && voice.oscFilters[oscKey];
      if (!f) return;
      if (param === 'cutoff')    f.frequency.setValueAtTime(value, now);
      if (param === 'resonance') f.Q.value = value;
      if (param === 'type')      f.type = value;
    });
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
    if (param === 'target') updateLFOPanRouting();
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

  // ── Mod matrix application (called each animation frame) ──
  let _fmIndexWasModulated = false;
  let _lfo1RateWasModulated = false;
  function applyModMatrix(dt) {
    if (!ctx || !modBusPitch) return;

    // JS-tracked LFO phase (mirrors the Web Audio LFO for mod matrix input).
    // It free-runs whether or not the LFO panel is switched on: that toggle
    // governs the LFO's own target, while the matrix is a separate patch bay
    // and its LFO 1 row would otherwise be dead until the panel was enabled.
    const lfo1Rate = ModMatrix.rateFor(state.lfo.rate, 'lfo1_rate');
    jsLFOPhase += lfo1Rate * dt * Math.PI * 2;
    if (jsLFOPhase > Math.PI * 2) jsLFOPhase %= Math.PI * 2;
    const lfo1Val = lfoShape(state.lfo.wave, jsLFOPhase);

    // Envelope followers from the oldest active voice: Env 1 tracks the amp
    // ADSR, Env 2 the filter ADSR, so they are genuinely different curves.
    let envVal = 0, env2Val = 0;
    if (activeVoices.size > 0) {
      const voice = activeVoices.values().next().value;
      const age = ctx.currentTime - voice.startTime;
      const follow = ({ attack, decay, sustain }) => {
        if (age < attack)         return attack > 0 ? age / attack : 1;
        if (age < attack + decay) return decay > 0 ? 1 - (1 - sustain) * (age - attack) / decay : sustain;
        return sustain;
      };
      envVal  = follow(state.env);
      env2Val = follow(state.fenv);
    }

    ModMatrix.tick(dt, lfo1Val, envVal, _lastNoteVal, _lastVelVal, env2Val);

    const mv  = ModMatrix.modValues;
    const now = ctx.currentTime;

    // Helper: look up defaultRange for a destination
    const getRange = id => (ModMatrix.DESTINATIONS.find(d => d.id === id) || {}).defaultRange || 1;

    // ConstantSource offsets (additive on top of existing automation)
    modBusPitch    .offset.setValueAtTime(mv.pitch     * getRange('pitch')      * 100, now); // semitones→cents
    modBusFilterCut.offset.setValueAtTime(mv.filter_cut * getRange('filter_cut'),       now); // Hz
    modBusOsc1Det  .offset.setValueAtTime(mv.osc1_det   * getRange('osc1_det'),         now); // cents
    modBusOsc2Det  .offset.setValueAtTime(mv.osc2_det   * getRange('osc2_det'),         now);
    modBusOsc3Det  .offset.setValueAtTime(mv.osc3_det   * getRange('osc3_det'),         now);
    modBusPan      .offset.setValueAtTime(clamp(mv.pan   * getRange('pan'), -1, 1),      now); // -1..+1

    // Filter resonance — direct (no conflict with envelope)
    if (mv.filter_res !== 0) {
      activeVoices.forEach(voice => {
        voice.filter.Q.value = clamp(state.filter.resonance + mv.filter_res * getRange('filter_res'), 0.1, 30);
      });
    }

    // Amplitude — a VCA that scales the mix rather than offsetting it, so a
    // routing can only duck below unity (never boost into clipping). At full
    // source it sits at unity, at zero source it is down by the routed depth:
    //   velocity → amp at 0.8  ⇒  0.2 … 1.0 across the velocity range
    //   LFO      → amp at 0.5  ⇒  tremolo between 0.5 and 1.0
    const ampDepth = ModMatrix.modDepths.amp || 0;
    if (modAmpGain) {
      const target = ampDepth > 0 ? clamp(1 - ampDepth + mv.amp * getRange('amp'), 0, 1) : 1;
      // Smoothed — this runs at frame rate and a stepped gain would zipper
      modAmpGain.gain.setTargetAtTime(target, now, 0.008);
    }

    // FM Index — offsets both the osc-to-osc FM depth on the Subtractive tab
    // and the operator indices of the FM Synthesis engine
    const fmOffset = mv.fm_index * getRange('fm_index');
    if (mv.fm_index !== 0 || _fmIndexWasModulated) {
      activeVoices.forEach(voice => {
        if (!voice.fmGains) return;
        voice.fmGains.forEach(({ node, baseFreq, oscKey }) => {
          const base = state[oscKey] ? (state[oscKey].fmIndex || 0) : 0;
          node.gain.setTargetAtTime(clamp(base + fmOffset, 0, 8) * baseFreq, now, 0.008);
        });
      });
      _fmIndexWasModulated = mv.fm_index !== 0;
    }
    if (typeof FMEngine !== 'undefined' && FMEngine.setModIndex) FMEngine.setModIndex(fmOffset);

    // WT Position — the wavetable engine caches waveforms per step, so this is
    // cheap to call every frame
    if (typeof WTEngine !== 'undefined' && WTEngine.setModPosition) {
      WTEngine.setModPosition(mv.wt_pos * getRange('wt_pos'));
    }

    // LFO1 rate
    if (lfoOsc && (mv.lfo1_rate !== 0 || _lfo1RateWasModulated)) {
      lfoOsc.frequency.setValueAtTime(ModMatrix.rateFor(state.lfo.rate, 'lfo1_rate'), now);
      _lfo1RateWasModulated = mv.lfo1_rate !== 0;
    }
  }

  // ── Load preset ───────────────────────────────────────────
  function loadPreset(preset) {
    // Pan is not carried by the built-in presets — recentre it so a patch
    // always loads with the stereo image its designer intended.
    if (preset.masterPan === undefined) state.masterPan = 0;
    ['osc1', 'osc2', 'osc3'].forEach(k => {
      if (!preset[k] || preset[k].pan === undefined) state[k].pan = 0;
    });

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
    updateLFOPanRouting();

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
    setMasterPan(state.masterPan);
  }

  // ── Helpers ───────────────────────────────────────────────
  function midiToFreq(note) {
    if (typeof Microtonal !== 'undefined' && Microtonal.getState().enabled) {
      return Microtonal.noteToFreq(note);
    }
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
    setMasterVolume, setMasterPan,
    setOsc, setEnv, setFEnv,
    setFilter, setOscFilter, setLFO, applyModMatrix,
    setDistortion, setChorus, setDelay, setReverb,
    loadPreset,
    getState, getAnalyser, getActiveVoices,
    midiToFreq, _getContext,
    setQuality, getQuality,
    _voiceDestination: null,
    _chorusWetGain: null,
    get _masterPanner() { return masterPanner; },
  };

})();
