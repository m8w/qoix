/* ============================================================
   QOIX Synthesizer — FM Engine (DX7-style 4-Operator)
   ============================================================
   Terminology:
     Carrier  = operator whose output goes to audio output
     Modulator= operator whose output modulates a carrier's freq
     Ratio    = frequency multiplier relative to base note
     Index    = modulation depth (how much modulator affects carrier)

   Algorithms (4 operators: A=1, B=2, C=3, D=4):
     0: A(B(C(D)))         — serial chain
     1: A(B(C)+D)          — C+D mod B mod A
     2: A(B)+C(D)          — two parallel 2-op stacks
     3: A(B+C+D)           — A modulated by B,C,D parallel
     4: A+B(C(D))          — A carrier + B<-C<-D chain
     5: A+B+C(D)           — three carriers, D mods C
     6: A(B)+C+D           — A<-B, C and D are carriers
     7: A+B+C+D            — all carriers (additive)
   ============================================================ */

'use strict';

const FMEngine = (() => {

  // ── Default state ─────────────────────────────────────────
  const defaultState = {
    enabled: false,
    algorithm: 2,
    operators: [
      { ratio: 1,   level: 0.8, attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.3, feedback: 0 },
      { ratio: 2,   level: 0.6, attack: 0.01, decay: 0.15,sustain: 0.5, release: 0.3, feedback: 0 },
      { ratio: 3,   level: 0.4, attack: 0.005,decay: 0.1, sustain: 0.3, release: 0.2, feedback: 0 },
      { ratio: 0.5, level: 0.5, attack: 0.01, decay: 0.25,sustain: 0.4, release: 0.4, feedback: 0 },
    ],
    globalFeedback: 0,
  };

  let state = JSON.parse(JSON.stringify(defaultState));

  // ── Algorithms: array of {carriers:[], mods:[{from,to}]} ──
  const ALGORITHMS = [
    // 0: D→C→B→A (serial)
    { carriers: [0], mods: [{from:3,to:2},{from:2,to:1},{from:1,to:0}] },
    // 1: D→C, D→B, B+C→A
    { carriers: [0], mods: [{from:3,to:2},{from:3,to:1},{from:2,to:0},{from:1,to:0}] },
    // 2: C→A output, D→B output (two 2-op stacks)
    { carriers: [0,1], mods: [{from:2,to:0},{from:3,to:1}] },
    // 3: B+C+D all mod A
    { carriers: [0], mods: [{from:1,to:0},{from:2,to:0},{from:3,to:0}] },
    // 4: A carrier, D→C→B and B→A (A+serial)
    { carriers: [0,3], mods: [{from:3,to:2},{from:2,to:1},{from:1,to:0}] },
    // 5: A+B carriers, D→C and C mods B
    { carriers: [0,1,2], mods: [{from:3,to:2},{from:2,to:1}] },
    // 6: A←B, C, D all carriers
    { carriers: [0,2,3], mods: [{from:1,to:0}] },
    // 7: all carriers (additive FM)
    { carriers: [0,1,2,3], mods: [] },
  ];

  // Algorithm display strings for UI
  const ALGORITHM_LABELS = [
    'D→C→B→A', 'D→C+B→A', 'C→A | D→B', 'B+C+D→A',
    'A + D→C→B', 'A+B + D→C', 'A←B | C | D', 'A+B+C+D',
  ];

  // ── Active FM voices ──────────────────────────────────────
  const fmVoices = new Map();

  // ── Context reference (set from outside) ─────────────────
  let _ctx = null;
  let _destination = null;

  function setContext(ctx, destination) {
    _ctx = ctx;
    _destination = destination;
  }

  // ── Note on ───────────────────────────────────────────────
  function noteOn(midiNote, velocity = 1, filter) {
    if (!_ctx || !state.enabled) return;
    if (fmVoices.has(midiNote)) noteOff(midiNote, true);

    const baseFreq = (typeof Microtonal !== 'undefined' && Microtonal.getState().enabled)
      ? Microtonal.noteToFreq(midiNote)
      : 440 * Math.pow(2, (midiNote - 69) / 12);
    const now = _ctx.currentTime;
    const algo = ALGORITHMS[state.algorithm];
    const ops = state.operators;

    // Create oscillators and gain nodes for each operator
    const oscNodes = [];
    const envGains = [];
    const fmGains  = [];  // gain for FM signal (before adding to carrier freq)

    for (let i = 0; i < 4; i++) {
      const op = ops[i];
      const osc = _ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = baseFreq * op.ratio;

      // Amplitude envelope
      const envGain = _ctx.createGain();
      envGain.gain.setValueAtTime(0, now);
      envGain.gain.linearRampToValueAtTime(op.level * velocity, now + op.attack);
      envGain.gain.linearRampToValueAtTime(
        op.level * op.sustain * velocity,
        now + op.attack + op.decay
      );

      // FM output gain (scales modulation amount; use frequency * ratio as index)
      const fmGain = _ctx.createGain();
      // Modulation index: depth scales as ratio * baseFreq * level
      fmGain.gain.value = baseFreq * op.ratio * op.level * velocity;

      osc.connect(envGain);
      envGain.connect(fmGain);

      osc.start(now);
      oscNodes.push(osc);
      envGains.push(envGain);
      fmGains.push(fmGain);
    }

    // Wire modulations according to algorithm
    // Modulator output → modulate carrier frequency param
    algo.mods.forEach(({from, to}) => {
      fmGains[from].connect(oscNodes[to].frequency);
    });

    // Carriers → filter or destination
    const mixGain = _ctx.createGain();
    mixGain.gain.value = 1 / Math.max(algo.carriers.length, 1);

    algo.carriers.forEach(i => {
      envGains[i].connect(mixGain);
    });

    // Connect to filter if provided, else direct to destination
    const dest = filter || _destination;
    mixGain.connect(dest);

    fmVoices.set(midiNote, { oscNodes, envGains, fmGains, mixGain, now });
  }

  // ── Note off ──────────────────────────────────────────────
  function noteOff(midiNote, immediate = false) {
    const voice = fmVoices.get(midiNote);
    if (!voice) return;

    const now = _ctx.currentTime;

    voice.oscNodes.forEach((osc, i) => {
      const op = state.operators[i];
      const rel = immediate ? 0.02 : op.release;
      const g = voice.envGains[i].gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + rel);
      try { osc.stop(now + rel + 0.05); } catch(e) {}
    });

    fmVoices.delete(midiNote);
  }

  // ── Panic ─────────────────────────────────────────────────
  function panic() {
    fmVoices.forEach((_, note) => noteOff(note, true));
    fmVoices.clear();
  }

  // ── State setters ─────────────────────────────────────────
  function setEnabled(v) { state.enabled = v; if (!v) panic(); }
  function setAlgorithm(v) { state.algorithm = parseInt(v); }
  function setOperator(opIdx, param, value) {
    state.operators[opIdx][param] = parseFloat(value);
  }

  function getState() { return state; }
  function loadState(s) { state = JSON.parse(JSON.stringify(s)); }
  function getAlgorithmLabels() { return ALGORITHM_LABELS; }
  function getAlgorithms() { return ALGORITHMS; }

  return {
    setContext, noteOn, noteOff, panic,
    setEnabled, setAlgorithm, setOperator,
    getState, loadState,
    getAlgorithmLabels, getAlgorithms,
    get fmVoices() { return fmVoices; },
  };

})();
