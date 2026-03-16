/* ============================================================
   QOIX Synthesizer — SN2 Modulation Matrix
   ============================================================
   An SN2-style (Source→N destinations, 2D routing) matrix
   where any modulation source can be routed to any destination
   with a bipolar amount.

   Sources:  LFO1, LFO2, Env1, Env2, Velocity, Note, Random,
             Mod Wheel, Aftertouch
   Destinations: Pitch, Filter Cutoff, Filter Resonance,
                 Amp Level, Pan, OSC1 Detune, OSC2 Detune,
                 FM Index, WT Position, LFO1 Rate, LFO2 Rate
   ============================================================ */

'use strict';

const ModMatrix = (() => {

  const SOURCES = [
    { id: 'lfo1',        label: 'LFO 1' },
    { id: 'lfo2',        label: 'LFO 2' },
    { id: 'env1',        label: 'Env 1' },
    { id: 'env2',        label: 'Env 2' },
    { id: 'velocity',    label: 'Velocity' },
    { id: 'note',        label: 'Note' },
    { id: 'random',      label: 'Random' },
    { id: 'modwheel',    label: 'Mod Wheel' },
  ];

  const DESTINATIONS = [
    { id: 'pitch',       label: 'Pitch',         defaultRange: 24   },   // semitones
    { id: 'filter_cut',  label: 'Filter Cutoff',  defaultRange: 8000 },   // Hz
    { id: 'filter_res',  label: 'Filter Res',     defaultRange: 20   },
    { id: 'amp',         label: 'Amplitude',      defaultRange: 1    },
    { id: 'pan',         label: 'Pan',            defaultRange: 1    },
    { id: 'osc1_det',    label: 'OSC1 Detune',    defaultRange: 100  },   // cents
    { id: 'osc2_det',    label: 'OSC2 Detune',    defaultRange: 100  },
    { id: 'osc3_det',    label: 'OSC3 Detune',    defaultRange: 100  },
    { id: 'fm_index',    label: 'FM Index',       defaultRange: 2    },
    { id: 'wt_pos',      label: 'WT Position',    defaultRange: 1    },
    { id: 'lfo1_rate',   label: 'LFO1 Rate',      defaultRange: 10   },   // Hz
    { id: 'lfo2_rate',   label: 'LFO2 Rate',      defaultRange: 10   },
  ];

  // Matrix: rows=sources, cols=destinations
  // Each cell: { amount: -1..+1, enabled: bool }
  const matrix = {};
  SOURCES.forEach(src => {
    matrix[src.id] = {};
    DESTINATIONS.forEach(dst => {
      matrix[src.id][dst.id] = { amount: 0, enabled: false };
    });
  });

  // Some useful defaults
  matrix.lfo1.pitch.amount    = 0.1;
  matrix.lfo1.pitch.enabled   = false;
  matrix.lfo2.filter_cut.amount = 0.4;
  matrix.velocity.amp.amount  = 0.8;
  matrix.velocity.amp.enabled = true;
  matrix.modwheel.lfo1_rate.amount = 0.5;

  // ── Source signal values (updated each frame) ─────────────
  const sourceValues = {};
  SOURCES.forEach(s => { sourceValues[s.id] = 0; });

  // Modulation results (destination → total mod value)
  const modValues = {};
  DESTINATIONS.forEach(d => { modValues[d.id] = 0; });

  // ── LFO2 (independent from synth LFO for mod matrix use) ──
  const lfo2State = {
    enabled: false, wave: 'sine', rate: 1.5, depth: 0.5, phase: 0,
  };
  let _lfo2Phase = 0;
  let _randomValue = 0;
  let _randomTimer = 0;
  let _modWheelValue = 0;

  // Called every audio frame tick (e.g. 60fps) to update source values
  let _noteValue = 0;    // 0..1 from MIDI note
  let _velocity = 0;     // 0..1
  let _envValue = 0;     // env from main synth
  let _lfo1Value = 0;    // from main synth LFO

  function tick(dt, lfo1Val, envVal, noteVal, velVal) {
    _lfo1Value = lfo1Val;
    _envValue  = envVal;
    _noteValue = noteVal;
    _velocity  = velVal;

    // LFO2
    _lfo2Phase += lfo2State.rate * dt * Math.PI * 2;
    const lfo2Val = Math.sin(_lfo2Phase) * lfo2State.depth;

    // Random (sample-and-hold)
    _randomTimer -= dt;
    if (_randomTimer <= 0) {
      _randomValue = Math.random() * 2 - 1;
      _randomTimer = 1 / Math.max(0.1, lfo2State.rate); // sync to lfo2 rate
    }

    sourceValues.lfo1     = lfo1Val;
    sourceValues.lfo2     = lfo2Val;
    sourceValues.env1     = envVal;
    sourceValues.env2     = envVal * 0.7; // env2 as alternative curve
    sourceValues.velocity = velVal;
    sourceValues.note     = noteVal;
    sourceValues.random   = _randomValue;
    sourceValues.modwheel = _modWheelValue;

    // Compute destination sums
    DESTINATIONS.forEach(dst => {
      let sum = 0;
      SOURCES.forEach(src => {
        const cell = matrix[src.id][dst.id];
        if (cell.enabled && cell.amount !== 0) {
          sum += sourceValues[src.id] * cell.amount;
        }
      });
      modValues[dst.id] = sum;
    });
  }

  function setModWheel(v) { _modWheelValue = v; }

  // ── Getters ───────────────────────────────────────────────
  function getModValue(destId) { return modValues[destId] || 0; }
  function getCell(srcId, dstId) { return matrix[srcId][dstId]; }

  function setCell(srcId, dstId, amount, enabled) {
    if (matrix[srcId] && matrix[srcId][dstId]) {
      matrix[srcId][dstId].amount  = amount;
      matrix[srcId][dstId].enabled = enabled;
    }
  }

  function setCellAmount(srcId, dstId, v) {
    if (matrix[srcId] && matrix[srcId][dstId]) {
      matrix[srcId][dstId].amount = parseFloat(v);
    }
  }

  function setCellEnabled(srcId, dstId, v) {
    if (matrix[srcId] && matrix[srcId][dstId]) {
      matrix[srcId][dstId].enabled = !!v;
    }
  }

  function setLFO2(param, value) {
    lfo2State[param] = value;
    if (param === 'rate') _randomTimer = 0;
  }

  function getState() {
    return { matrix: JSON.parse(JSON.stringify(matrix)), lfo2: { ...lfo2State } };
  }

  function loadState(s) {
    if (s.matrix) {
      SOURCES.forEach(src => {
        DESTINATIONS.forEach(dst => {
          if (s.matrix[src.id] && s.matrix[src.id][dst.id]) {
            Object.assign(matrix[src.id][dst.id], s.matrix[src.id][dst.id]);
          }
        });
      });
    }
    if (s.lfo2) Object.assign(lfo2State, s.lfo2);
  }

  return {
    SOURCES, DESTINATIONS,
    tick, getModValue, getCell,
    setCell, setCellAmount, setCellEnabled,
    setModWheel, setLFO2,
    getState, loadState,
    get sourceValues() { return sourceValues; },
    get modValues() { return modValues; },
  };

})();
