/* ============================================================
   QOIX Synthesizer — Offline MIDI Renderer
   ============================================================
   Parses standard MIDI files (.mid) and renders them using the
   current synth patch at a user-selected sample rate via
   OfflineAudioContext — no realtime constraint, no dropouts.
   Exports 24-bit stereo WAV.
   ============================================================ */

'use strict';

const Renderer = (() => {

  // ══════════════════════════════════════════════════════════
  //  MIDI BINARY PARSER
  // ══════════════════════════════════════════════════════════
  function parseMidi(arrayBuffer) {
    const raw = new Uint8Array(arrayBuffer);
    const dv  = new DataView(arrayBuffer);
    let pos   = 0;

    const readU8  = () => raw[pos++];
    const readU16 = () => { const v = dv.getUint16(pos); pos += 2; return v; };
    const readU32 = () => { const v = dv.getUint32(pos); pos += 4; return v; };
    const readStr = n => { let s = ''; for (let i=0;i<n;i++) s += String.fromCharCode(raw[pos++]); return s; };

    // Variable-length quantity (used for delta times and meta lengths)
    function readVLQ() {
      let val = 0, byte;
      do { byte = readU8(); val = (val << 7) | (byte & 0x7f); } while (byte & 0x80);
      return val;
    }

    if (readStr(4) !== 'MThd') throw new Error('Not a MIDI file');
    readU32(); // header length (always 6)
    const format    = readU16();
    const numTracks = readU16();
    const division  = readU16(); // ticks per quarter note

    const allEvents = [];

    for (let t = 0; t < numTracks; t++) {
      if (readStr(4) !== 'MTrk') throw new Error('Expected MTrk');
      const trackEnd  = pos + readU32();
      let   tick      = 0;
      let   lastStatus = 0;

      while (pos < trackEnd) {
        tick += readVLQ();

        let status = raw[pos];
        if (status & 0x80) { lastStatus = status; pos++; }
        else                { status = lastStatus; }          // running status

        const type = status & 0xf0;

        if (type === 0x90 || type === 0x80) {
          const note = readU8(), vel = readU8();
          const on   = type === 0x90 && vel > 0;
          allEvents.push({ tick, type: on ? 'noteOn' : 'noteOff', note, velocity: vel / 127 });
        } else if (type === 0xa0) { readU8(); readU8();               // poly aftertouch
        } else if (type === 0xb0) { readU8(); readU8();               // CC
        } else if (type === 0xc0) { readU8();                         // program change
        } else if (type === 0xd0) { readU8();                         // channel pressure
        } else if (type === 0xe0) { readU8(); readU8();               // pitch bend
        } else if (status === 0xff) {                                 // meta event
          const meta = readU8();
          const len  = readVLQ();
          if (meta === 0x51 && len === 3) {                           // set tempo
            const uspb = (readU8()<<16) | (readU8()<<8) | readU8();
            allEvents.push({ tick, type: 'tempo', uspb });
          } else { pos += len; }
        } else if (status === 0xf0 || status === 0xf7) {             // sysex
          pos += readVLQ();
        } else { pos++; }
      }
      pos = trackEnd;
    }

    allEvents.sort((a, b) => a.tick - b.tick);

    // ── Tick → seconds via tempo map ──
    const tempoMap = [{ tick: 0, time: 0, uspb: 500000 }]; // default 120 BPM
    allEvents.filter(e => e.type === 'tempo').forEach(e => {
      const last = tempoMap[tempoMap.length - 1];
      const time = last.time + ((e.tick - last.tick) / division) * (last.uspb / 1e6);
      tempoMap.push({ tick: e.tick, time, uspb: e.uspb });
    });

    function tickToSec(tick) {
      let ref = tempoMap[0];
      for (const t of tempoMap) { if (t.tick <= tick) ref = t; else break; }
      return ref.time + ((tick - ref.tick) / division) * (ref.uspb / 1e6);
    }

    const events = allEvents
      .filter(e => e.type === 'noteOn' || e.type === 'noteOff')
      .map(e => ({ ...e, time: tickToSec(e.tick) }));

    const lastTick = Math.max(0, ...allEvents.map(e => e.tick));
    const duration = tickToSec(lastTick);
    const noteCount = events.filter(e => e.type === 'noteOn').length;

    return { events, duration, noteCount, format, numTracks };
  }

  // ══════════════════════════════════════════════════════════
  //  WAV ENCODER  (24-bit stereo PCM)
  // ══════════════════════════════════════════════════════════
  function encodeWAV(audioBuffer, bitDepth = 24) {
    const nCh   = audioBuffer.numberOfChannels;
    const sr    = audioBuffer.sampleRate;
    const nSamp = audioBuffer.length;
    const bps   = bitDepth === 32 ? 4 : bitDepth === 16 ? 2 : 3; // bytes per sample
    const isFloat = bitDepth === 32;
    const dataSize   = nSamp * nCh * bps;
    const ab  = new ArrayBuffer(44 + dataSize);
    const dv  = new DataView(ab);
    const u8  = new Uint8Array(ab);
    const ws  = (off, s) => { for (let i=0;i<s.length;i++) dv.setUint8(off+i, s.charCodeAt(i)); };

    ws(0,  'RIFF'); dv.setUint32(4, 36 + dataSize, true);
    ws(8,  'WAVE'); ws(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, isFloat ? 3 : 1, true);  // 3=IEEE float, 1=PCM
    dv.setUint16(22, nCh, true);
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * nCh * bps, true);
    dv.setUint16(32, nCh * bps, true);
    dv.setUint16(34, bitDepth, true);
    ws(36, 'data'); dv.setUint32(40, dataSize, true);

    let p = 44;
    for (let i = 0; i < nSamp; i++) {
      for (let ch = 0; ch < nCh; ch++) {
        const s = Math.max(-1, Math.min(1, audioBuffer.getChannelData(ch)[i]));
        if (isFloat) { dv.setFloat32(p, s, true); p += 4; }
        else if (bitDepth === 24) {
          const v = Math.round(s * 0x7fffff);
          u8[p] = v & 0xff; u8[p+1] = (v >> 8) & 0xff; u8[p+2] = (v >> 16) & 0xff; p += 3;
        } else {
          dv.setInt16(p, Math.round(s * 0x7fff), true); p += 2;
        }
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  // ══════════════════════════════════════════════════════════
  //  OFFLINE SYNTH RENDERER
  // ══════════════════════════════════════════════════════════
  async function render(midiEvents, synthState, options = {}, onProgress = null) {
    const {
      sampleRate  = 48000,
      bitDepth    = 24,
      tailSeconds = 5,   // reverb + release decay tail after last note
    } = options;

    const s = synthState;
    const lastNote   = midiEvents.reduce((m, e) => Math.max(m, e.time), 0);
    const totalSec   = lastNote + tailSeconds;
    const totalSamp  = Math.ceil(sampleRate * totalSec);

    if (onProgress) onProgress(0, 'Building audio context…');

    const offCtx = new OfflineAudioContext(2, totalSamp, sampleRate);

    // ── Helpers ──────────────────────────────────────────────
    const clamp    = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const m2f      = n => 440 * Math.pow(2, (n - 69) / 12);

    // ── Distortion curve ──
    function distCurve(amount) {
      const n = 1024, c = new Float32Array(n);
      for (let i=0; i<n; i++) {
        const x = (i*2)/n - 1;
        c[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
      }
      return c;
    }

    // ── Reverb IR ──
    function makeImpulse(dur, decay) {
      const len = Math.floor(sampleRate * dur);
      const buf = offCtx.createBuffer(2, len, sampleRate);
      for (let ch=0; ch<2; ch++) {
        const d = buf.getChannelData(ch);
        const earlyEnd = Math.min(Math.floor(sampleRate * 0.08), len);
        for (let i=0; i<len; i++) {
          const env = Math.pow(1 - i/len, decay);
          d[i] = ((i < earlyEnd ? (Math.random()*2-1)*1.5 : 0) + (Math.random()*2-1)) * env * 0.5;
        }
      }
      return buf;
    }

    // ── Master ──
    const masterGain = offCtx.createGain();
    masterGain.gain.value = s.masterVolume;
    masterGain.connect(offCtx.destination);

    // ── Effect chain ──
    const voiceDest = offCtx.createGain(); // where voices connect

    // Distortion split
    const distNode   = offCtx.createWaveShaper();
    distNode.curve   = distCurve(s.dist.drive);
    distNode.oversample = '4x';
    const distBypass = offCtx.createGain();
    distBypass.gain.value = s.dist.enabled ? 0 : 1;
    const preFX = offCtx.createGain();
    voiceDest.connect(distNode);
    voiceDest.connect(distBypass);
    distNode.connect(preFX);
    distBypass.connect(preFX);

    // Chorus
    const chorusDelay = offCtx.createDelay(0.1);
    chorusDelay.delayTime.value = 0.02;
    const chorusLFO = offCtx.createOscillator();
    chorusLFO.frequency.value = s.chorus.rate;
    const cLFOGain = offCtx.createGain();
    cLFOGain.gain.value = s.chorus.depth;
    chorusLFO.connect(cLFOGain); cLFOGain.connect(chorusDelay.delayTime); chorusLFO.start(0);
    const chorusWet = offCtx.createGain(); chorusWet.gain.value = s.chorus.enabled ? s.chorus.mix : 0;
    const postChorus = offCtx.createGain();
    preFX.connect(postChorus); preFX.connect(chorusDelay);
    chorusDelay.connect(chorusWet); chorusWet.connect(postChorus);

    // Delay
    const delayNode = offCtx.createDelay(2);
    delayNode.delayTime.value = s.delay.time;
    const delayFB  = offCtx.createGain(); delayFB.gain.value = s.delay.feedback;
    const delayWet = offCtx.createGain(); delayWet.gain.value = s.delay.enabled ? s.delay.mix : 0;
    const postDelay = offCtx.createGain();
    delayNode.connect(delayFB); delayFB.connect(delayNode); delayNode.connect(delayWet);
    postChorus.connect(postDelay); postChorus.connect(delayNode);
    delayWet.connect(postDelay);

    // Reverb
    const revNode = offCtx.createConvolver();
    revNode.buffer = makeImpulse(s.reverb.size, s.reverb.damp * 5 + 1);
    const revWet = offCtx.createGain(); revWet.gain.value = s.reverb.enabled ? s.reverb.mix : 0;
    const postRev = offCtx.createGain();
    postDelay.connect(postRev); postDelay.connect(revNode);
    revNode.connect(revWet); revWet.connect(postRev);
    postRev.connect(masterGain);

    // ── LFO ──
    let lfoOsc = null, lfoGain = null;
    if (s.lfo.enabled) {
      lfoOsc = offCtx.createOscillator();
      lfoGain = offCtx.createGain();
      lfoOsc.type = s.lfo.wave;
      lfoOsc.frequency.value = s.lfo.rate;
      const d = s.lfo.depth;
      lfoGain.gain.value = { pitch: d*200, filter: d*5000, amplitude: d*0.5 }[s.lfo.target] ?? d;
      lfoOsc.connect(lfoGain); lfoOsc.start(0);
    }

    // ── Noise buffer ──
    let _noiseBuf = null;
    function noiseBuf(type) {
      if (_noiseBuf) return _noiseBuf;
      const len = sampleRate * 4;
      const buf = offCtx.createBuffer(1, len, sampleRate);
      const d   = buf.getChannelData(0);
      if (type === 'white') {
        for (let i=0; i<len; i++) d[i] = Math.random()*2-1;
      } else {
        let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0;
        for (let i=0; i<len; i++) {
          const w=Math.random()*2-1;
          b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
          b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
          b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
          d[i] = (b0+b1+b2+b3+b4+b5+w*0.5362)*0.11;
        }
      }
      return (_noiseBuf = buf);
    }

    // ── Note scheduling ──────────────────────────────────────
    const liveNotes = new Map(); // midiNote → voice

    function noteOn(midiNote, velocity, t) {
      if (liveNotes.has(midiNote)) noteOff(midiNote, t); // retrigger
      const freq = m2f(midiNote);

      // Amp envelope
      const ampEnv = offCtx.createGain();
      ampEnv.gain.setValueAtTime(0, t);
      ampEnv.gain.linearRampToValueAtTime(velocity,                        t + s.env.attack);
      ampEnv.gain.linearRampToValueAtTime(s.env.sustain * velocity,        t + s.env.attack + s.env.decay);

      const oscMixer = offCtx.createGain();
      const allOscs  = [];

      // Per-osc filter
      function makeOscFilt(fs) {
        const f = offCtx.createBiquadFilter();
        f.type = fs.type;
        f.frequency.setValueAtTime(fs.cutoff, t);
        f.Q.value = fs.resonance;
        if (fs.envAmt !== 0) {
          f.frequency.setValueAtTime(fs.cutoff, t);
          f.frequency.linearRampToValueAtTime(clamp(fs.cutoff + fs.envAmt, 20, 20000),                             t + s.fenv.attack);
          f.frequency.linearRampToValueAtTime(clamp(fs.cutoff + fs.envAmt * s.fenv.sustain, 20, 20000), t + s.fenv.attack + s.fenv.decay);
        }
        if (lfoOsc && fs.lfoDepth > 0) {
          const sc = offCtx.createGain(); sc.gain.value = fs.lfoDepth * s.lfo.depth * 5000;
          lfoOsc.connect(sc); sc.connect(f.frequency);
        }
        return f;
      }

      // Per-osc static pan + its own LFO->Pan depth
      function makeOscPan(oscState) {
        const p = offCtx.createStereoPanner();
        p.pan.value = oscState.pan || 0;
        if (lfoOsc && oscState.panLfoDepth > 0) {
          const sc = offCtx.createGain(); sc.gain.value = oscState.panLfoDepth * s.lfo.depth;
          lfoOsc.connect(sc); sc.connect(p.pan);
        }
        p.connect(oscMixer);
        return p;
      }

      // Build unison oscillator group
      function buildOscs(oscState, target) {
        if (!oscState.enabled) return;
        const nV = Math.max(1, Math.round(oscState.voices || 1));
        const sp = oscState.unisonSpread || 0;
        const width = oscState.stereoWidth || 0;
        for (let v=0; v<nV; v++) {
          const osc  = offCtx.createOscillator();
          const gain = offCtx.createGain();
          osc.type = oscState.wave;
          osc.frequency.value = freq * Math.pow(2, oscState.octave);
          const voicePos = nV > 1 ? ((v/(nV-1))-0.5)*2 : 0;
          osc.detune.value = oscState.detune + voicePos * sp;
          gain.gain.value = oscState.level / nV;
          osc.connect(gain);
          if (nV > 1 && width > 0) {
            const unisonPan = offCtx.createStereoPanner();
            unisonPan.pan.value = voicePos * width;
            gain.connect(unisonPan); unisonPan.connect(target);
          } else {
            gain.connect(target);
          }
          osc.start(t);
          allOscs.push(osc);
          if (lfoOsc && s.lfo.target === 'pitch') lfoGain.connect(osc.detune);
        }
      }

      const f1 = makeOscFilt(s.osc1.filter); f1.connect(makeOscPan(s.osc1));
      const f2 = makeOscFilt(s.osc2.filter); f2.connect(makeOscPan(s.osc2));
      const f3 = makeOscFilt(s.osc3.filter); f3.connect(makeOscPan(s.osc3));
      buildOscs(s.osc1, f1);
      buildOscs(s.osc2, f2);
      buildOscs(s.osc3, f3);

      if (s.noise.enabled) {
        const src = offCtx.createBufferSource();
        src.buffer = noiseBuf(s.noise.type); src.loop = true;
        const ng = offCtx.createGain(); ng.gain.value = s.noise.level;
        src.connect(ng); ng.connect(oscMixer); src.start(t);
        allOscs.push(src);
      }

      // Master filter
      const masterFilt = offCtx.createBiquadFilter();
      masterFilt.type = s.filter.type;
      masterFilt.frequency.setValueAtTime(s.filter.cutoff, t);
      masterFilt.Q.value = s.filter.resonance;
      if (s.fenv.amount !== 0) {
        masterFilt.frequency.setValueAtTime(s.filter.cutoff, t);
        masterFilt.frequency.linearRampToValueAtTime(clamp(s.filter.cutoff + s.fenv.amount, 20, 20000),                        t + s.fenv.attack);
        masterFilt.frequency.linearRampToValueAtTime(clamp(s.filter.cutoff + s.fenv.amount * s.fenv.sustain, 20, 20000), t + s.fenv.attack + s.fenv.decay);
      }
      const voicePan = offCtx.createStereoPanner();
      if (lfoOsc && s.lfo.target === 'filter')    lfoGain.connect(masterFilt.frequency);
      if (lfoOsc && s.lfo.target === 'amplitude') lfoGain.connect(ampEnv.gain);
      if (lfoOsc && s.lfo.target === 'pan')       lfoGain.connect(voicePan.pan);

      oscMixer.connect(masterFilt);
      masterFilt.connect(ampEnv);
      ampEnv.connect(voicePan);
      voicePan.connect(voiceDest);

      liveNotes.set(midiNote, { oscs: allOscs, ampEnv, masterFilt, velocity, noteOnTime: t });
    }

    function noteOff(midiNote, t) {
      const voice = liveNotes.get(midiNote);
      if (!voice) return;
      const rel  = s.env.release;
      const fRel = s.fenv.release;

      // Release from sustain level (accurate for held notes)
      const susVal = voice.velocity * s.env.sustain;
      voice.ampEnv.gain.setValueAtTime(susVal, t);
      voice.ampEnv.gain.linearRampToValueAtTime(0, t + rel);

      if (s.fenv.amount !== 0) {
        voice.masterFilt.frequency.setValueAtTime(
          clamp(s.filter.cutoff + s.fenv.amount * s.fenv.sustain, 20, 20000), t);
        voice.masterFilt.frequency.linearRampToValueAtTime(s.filter.cutoff, t + fRel);
      }

      const stopAt = t + rel + 0.1;
      voice.oscs.forEach(o => { try { o.stop(stopAt); } catch(e){} });
      liveNotes.delete(midiNote);
    }

    // ── Schedule all events ──
    if (onProgress) onProgress(10, 'Scheduling MIDI events…');
    midiEvents.forEach(ev => {
      if (ev.type === 'noteOn')  noteOn (ev.note, ev.velocity, ev.time);
      if (ev.type === 'noteOff') noteOff(ev.note, ev.time);
    });
    // Release any notes still held at end
    liveNotes.forEach((_, note) => noteOff(note, lastNote));

    // ── Render ──
    if (onProgress) onProgress(20, 'Rendering (this may take a moment)…');
    const rendered = await offCtx.startRendering();
    if (onProgress) onProgress(90, 'Encoding WAV…');

    const wavBlob = encodeWAV(rendered, bitDepth);
    if (onProgress) onProgress(100, 'Done');
    return { wavBlob, audioBuffer: rendered, sampleRate, bitDepth, duration: totalSec };
  }

  return { parseMidi, render, encodeWAV };

})();
