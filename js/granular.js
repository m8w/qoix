/* ============================================================
   QOIX — Granular Synthesis Engine
   ============================================================
   Real grain-cloud synthesis, built from first principles on
   top of the Web Audio graph — no third-party DSP.

   Three grain sources:
     sample     — granulate a loaded (file or mic) AudioBuffer
     oscillator — grains are short bursts of a tone (classic
                  Xenakis/Roads-style synthetic grain clouds)
     noise      — grains are short bursts carved from a noise
                  buffer, scannable like a sample

   Each grain is an independently-scheduled AudioBufferSourceNode
   or OscillatorNode, windowed by a per-shape gain envelope
   (Hann / Tukey / Triangular / Gaussian / Rectangular) written
   with setValueCurveAtTime, then panned and summed into a
   per-voice ADSR bus.
   ============================================================ */

'use strict';

const GranularEngine = (() => {

  // ── Shared audio context (set by init) ─────────────────────
  let ctx  = null;
  let dest = null;   // connects to Synth._voiceDestination

  const activeVoices = new Map(); // midiNote -> voice object

  // ── Scheduler timing ────────────────────────────────────────
  const SCHED_INTERVAL_MS = 25;    // how often the lookahead tick runs
  const SCHED_AHEAD_SEC   = 0.15;  // how far ahead grains get scheduled
  let schedulerTimer = null;
  let lastTickTime    = 0;

  // ── State ───────────────────────────────────────────────────
  const state = {
    enabled: false,

    source: 'oscillator',   // 'sample' | 'oscillator' | 'noise'
    oscWave: 'sine',

    buffer:         null,   // AudioBuffer — loaded sample
    bufferReversed: null,   // pre-reversed copy for reverse grains
    sampleName:     '',

    grain: {
      size:         80,     // ms
      sizeSpray:    0.15,   // 0..1 fraction of size, randomized per grain
      density:      20,     // grains / sec
      timingJitter: 0.15,   // 0..1 fraction of interval, randomized
      position:     0,      // 0..1 — scan position within buffer/noise
      positionSpray:20,     // ms, converted to seconds jitter around position
      pitchSpray:   0,      // semitones, +/- random per grain
      panSpread:    0.5,    // 0..1
      reverse:      0,      // 0..1 probability a grain plays reversed
      window:       'hann', // hann | tukey | triangular | gaussian | rectangular
    },

    scan: {
      enabled: false,
      mode:    'loop',      // loop | pingpong
      period:  8,           // seconds for a full sweep across the buffer
      freeze:  false,
      _dir:    1,           // internal ping-pong direction
    },

    env: { attack: 0.05, decay: 0.1, sustain: 0.8, release: 0.3 },
  };

  // ── Init (called once, shares context from Synth) ──────────
  function init() {
    if (ctx) return;
    ctx  = Synth._getContext();
    dest = Synth._voiceDestination;
  }

  function ensureInit() {
    if (!ctx) init();
  }

  // ── Grain window curves (cached per shape) ──────────────────
  const _windowCache = {};
  function computeWindowCurve(shape, N = 128) {
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1); // 0..1
      let y;
      switch (shape) {
        case 'hann':
          y = 0.5 * (1 - Math.cos(2 * Math.PI * x));
          break;
        case 'tukey': {
          const a = 0.5; // taper ratio
          if (x < a / 2) y = 0.5 * (1 + Math.cos(Math.PI * (2 * x / a - 1)));
          else if (x > 1 - a / 2) y = 0.5 * (1 + Math.cos(Math.PI * (2 * x / a - 2 / a + 1)));
          else y = 1;
          break;
        }
        case 'triangular':
          y = 1 - Math.abs(2 * x - 1);
          break;
        case 'gaussian': {
          const sigma = 0.16;
          y = Math.exp(-0.5 * Math.pow((x - 0.5) / sigma, 2));
          break;
        }
        case 'rectangular':
        default: {
          // Near-flat with a fast anti-click taper at the very edges
          const edge = 0.03;
          if (x < edge) y = x / edge;
          else if (x > 1 - edge) y = (1 - x) / edge;
          else y = 1;
        }
      }
      curve[i] = Math.max(0, Math.min(1, y));
    }
    return curve;
  }

  function getWindowCurve(shape) {
    if (!_windowCache[shape]) _windowCache[shape] = computeWindowCurve(shape);
    return _windowCache[shape];
  }

  // ── Noise source buffer (shared, independent of Synth's) ───
  let _noiseBuffer = null;
  function getNoiseBuffer() {
    if (_noiseBuffer) return _noiseBuffer;
    const len = ctx.sampleRate * 3; // 3s of white noise to scan through
    _noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = _noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return _noiseBuffer;
  }

  // ── Sample loading ───────────────────────────────────────────
  function reverseBuffer(buf) {
    const rev = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch);
      const dst = rev.getChannelData(ch);
      for (let i = 0; i < src.length; i++) dst[i] = src[src.length - 1 - i];
    }
    return rev;
  }

  function loadSample(arrayBuffer, name) {
    ensureInit();
    if (!ctx) return Promise.reject(new Error('Audio context unavailable'));
    return ctx.decodeAudioData(arrayBuffer.slice(0)).then(buf => {
      state.buffer         = buf;
      state.bufferReversed = reverseBuffer(buf);
      state.sampleName     = name || 'Sample';
      state.source         = 'sample';
      state.grain.position  = 0;
      return buf;
    });
  }

  function clearSample() {
    state.buffer = null;
    state.bufferReversed = null;
    state.sampleName = '';
  }

  // ── Live mic capture ────────────────────────────────────────
  let _mediaStream   = null;
  let _mediaRecorder  = null;
  let _recordedChunks = [];

  function startRecording() {
    ensureInit();
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      _mediaStream    = stream;
      _recordedChunks = [];
      const mimeType = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm' : '';
      _mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      _mediaRecorder.ondataavailable = e => { if (e.data.size > 0) _recordedChunks.push(e.data); };
      _mediaRecorder.start();
    });
  }

  function stopRecording() {
    return new Promise((resolve, reject) => {
      if (!_mediaRecorder) { reject(new Error('Not recording')); return; }
      _mediaRecorder.onstop = async () => {
        try {
          _mediaStream.getTracks().forEach(t => t.stop());
          _mediaStream = null;
          const blob = new Blob(_recordedChunks, { type: _mediaRecorder.mimeType || 'audio/webm' });
          _recordedChunks = [];
          const arrBuf = await blob.arrayBuffer();
          const buf = await loadSample(arrBuf, 'Mic Recording');
          resolve(buf);
        } catch (err) { reject(err); }
      };
      _mediaRecorder.stop();
      _mediaRecorder = null;
    });
  }

  function isRecording() { return !!_mediaRecorder; }

  // ── Pitch helper (microtonal-aware, mirrors other engines) ─
  function midiFreq(midiNote) {
    return (typeof Microtonal !== 'undefined' && Microtonal.getState().enabled)
      ? Microtonal.noteToFreq(midiNote)
      : 440 * Math.pow(2, (midiNote - 69) / 12);
  }

  // ── Grain scheduling ──────────────────────────────────────────
  function scheduleGrain(voice, when) {
    const s = state.grain;
    const now = when;

    const sizeSec = Math.max(0.003, (s.size / 1000) * (1 + (Math.random() * 2 - 1) * s.sizeSpray));
    const g = ctx.createGain();
    g.gain.setValueCurveAtTime(getWindowCurve(s.window), now, sizeSec);

    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, (Math.random() * 2 - 1) * s.panSpread));

    g.connect(pan);
    pan.connect(voice.bus);

    const pitchRatio = Math.pow(2, ((Math.random() * 2 - 1) * s.pitchSpray) / 12);
    const nodes = [];

    if (state.source === 'sample' && state.buffer) {
      const reversed = Math.random() < s.reverse;
      const buf = reversed ? state.bufferReversed : state.buffer;
      const dur = buf.duration;

      const posSprayMs = (Math.random() * 2 - 1) * s.positionSpray;
      let posSec = s.position * dur + posSprayMs / 1000;
      // wrap around the buffer instead of hard-clipping at the edges
      posSec = ((posSec % dur) + dur) % dur;
      if (reversed) posSec = dur - posSec;
      const offset = Math.max(0, Math.min(dur - 0.001, posSec));

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = (voice.freqRatio || 1) * pitchRatio;
      src.connect(g);
      const playable = Math.max(0.001, Math.min(sizeSec, dur - offset));
      try { src.start(now, offset, playable); } catch (e) {}
      try { src.stop(now + sizeSec + 0.02); } catch (e) {}
      nodes.push(src);

    } else if (state.source === 'noise') {
      const buf = getNoiseBuffer();
      const dur = buf.duration;
      const posSprayMs = (Math.random() * 2 - 1) * s.positionSpray;
      let posSec = s.position * dur + posSprayMs / 1000;
      posSec = ((posSec % dur) + dur) % dur;
      const offset = Math.max(0, Math.min(dur - 0.001, posSec));

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = (voice.freqRatio || 1) * pitchRatio;
      src.connect(g);
      const playable = Math.max(0.001, Math.min(sizeSec, dur - offset));
      try { src.start(now, offset, playable); } catch (e) {}
      try { src.stop(now + sizeSec + 0.02); } catch (e) {}
      nodes.push(src);

    } else {
      // oscillator (default / fallback when no sample loaded)
      const osc = ctx.createOscillator();
      osc.type = state.oscWave;
      osc.frequency.value = voice.freq * pitchRatio;
      osc.connect(g);
      try { osc.start(now); } catch (e) {}
      try { osc.stop(now + sizeSec + 0.02); } catch (e) {}
      nodes.push(osc);
    }

    // Self-cleaning: disconnect once the grain's amplitude window has closed
    const cleanupDelay = (sizeSec + 0.05) * 1000;
    setTimeout(() => {
      nodes.forEach(n => { try { n.disconnect(); } catch (e) {} });
      try { g.disconnect(); } catch (e) {}
      try { pan.disconnect(); } catch (e) {}
    }, cleanupDelay + (when - ctx.currentTime) * 1000);
  }

  // ── Global scan-position clock (shared by all voices) ──────
  function advanceScan(dtSec) {
    const sc = state.scan;
    if (!sc.enabled || sc.freeze || dtSec <= 0) return;
    const step = dtSec / Math.max(0.05, sc.period);
    if (sc.mode === 'pingpong') {
      state.grain.position += step * sc._dir;
      if (state.grain.position >= 1) { state.grain.position = 1; sc._dir = -1; }
      else if (state.grain.position <= 0) { state.grain.position = 0; sc._dir = 1; }
    } else {
      state.grain.position = (state.grain.position + step) % 1;
    }
  }

  // ── Lookahead scheduler tick ─────────────────────────────────
  function schedulerTick() {
    const now = ctx.currentTime;
    const dt  = lastTickTime > 0 ? now - lastTickTime : SCHED_INTERVAL_MS / 1000;
    lastTickTime = now;

    advanceScan(dt);

    activeVoices.forEach(voice => {
      if (voice.released) return;
      const s = state.grain;
      const baseInterval = 1 / Math.max(0.5, s.density);
      while (voice.nextGrainTime < now + SCHED_AHEAD_SEC) {
        scheduleGrain(voice, Math.max(voice.nextGrainTime, now));
        const jitter = 1 + (Math.random() * 2 - 1) * s.timingJitter;
        voice.nextGrainTime += baseInterval * Math.max(0.1, jitter);
      }
    });
  }

  function startScheduler() {
    if (schedulerTimer) return;
    lastTickTime = 0;
    schedulerTimer = setInterval(schedulerTick, SCHED_INTERVAL_MS);
  }

  function stopSchedulerIfIdle() {
    if (activeVoices.size === 0 && schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
  }

  // ── Note On ────────────────────────────────────────────────
  function noteOn(midiNote, velocity = 1) {
    ensureInit();
    if (!state.enabled || !ctx) return;
    if (activeVoices.has(midiNote)) noteOff(midiNote, true);

    const now  = ctx.currentTime;
    const freq = midiFreq(midiNote);
    const e = state.env;

    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0, now);
    bus.gain.linearRampToValueAtTime(velocity, now + e.attack);
    bus.gain.linearRampToValueAtTime(e.sustain * velocity, now + e.attack + e.decay);
    bus.connect(dest);

    activeVoices.set(midiNote, {
      bus,
      freq,
      freqRatio: freq / 261.6256, // relative to middle C (sample base pitch)
      nextGrainTime: now,
      released: false,
      startTime: now,
    });

    startScheduler();
  }

  // ── Note Off ──────────────────────────────────────────────
  function noteOff(midiNote, immediate = false) {
    const voice = activeVoices.get(midiNote);
    if (!voice) return;

    voice.released = true;
    const now = ctx.currentTime;
    const rel = immediate ? 0.02 : state.env.release;

    voice.bus.gain.cancelScheduledValues(now);
    voice.bus.gain.setValueAtTime(voice.bus.gain.value, now);
    voice.bus.gain.linearRampToValueAtTime(0, now + rel);

    setTimeout(() => {
      // Only remove this exact voice — a fast retrigger may already have
      // replaced the map entry for this note with a fresh one.
      if (activeVoices.get(midiNote) === voice) activeVoices.delete(midiNote);
      try { voice.bus.disconnect(); } catch (e) {}
      stopSchedulerIfIdle();
    }, (rel + 0.15) * 1000);
  }

  // ── Panic ─────────────────────────────────────────────────
  function panic() {
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
    if (!ctx) { activeVoices.clear(); return; }
    const now = ctx.currentTime;
    activeVoices.forEach(voice => {
      try {
        voice.bus.gain.cancelScheduledValues(now);
        voice.bus.gain.setValueAtTime(0, now);
      } catch (e) {}
      try { voice.bus.disconnect(); } catch (e) {}
    });
    activeVoices.clear();
  }

  // ── Live param updates ──────────────────────────────────────
  function setEnabled(v)         { state.enabled = v; if (!v) panic(); }
  function setSource(v)          { state.source = v; }
  function setOscWave(v)         { state.oscWave = v; }
  function setGrainParam(p, v)   { if (p in state.grain) state.grain[p] = v; }
  function setWindow(v)          { state.grain.window = v; }
  function setPosition(v)        { state.grain.position = Math.max(0, Math.min(1, v)); }
  function setScanEnabled(v)     { state.scan.enabled = v; }
  function setScanMode(v)        { state.scan.mode = v; state.scan._dir = 1; }
  function setScanPeriod(v)      { state.scan.period = v; }
  function setFreeze(v)          { state.scan.freeze = v; }
  function setEnv(p, v)          { if (p in state.env) state.env[p] = v; }

  function getState()        { return state; }
  function getActiveVoices() { return activeVoices; }
  function getScanPosition() { return state.grain.position; }

  return {
    init, ensureInit, noteOn, noteOff, panic,
    loadSample, clearSample,
    startRecording, stopRecording, isRecording,
    setEnabled, setSource, setOscWave,
    setGrainParam, setWindow, setPosition,
    setScanEnabled, setScanMode, setScanPeriod, setFreeze,
    setEnv,
    getState, getActiveVoices, getScanPosition,
  };

})();
