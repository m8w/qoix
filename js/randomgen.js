/* ============================================================
   QOIX Synthesizer — Random Note Generator
   ============================================================
   Generates random notes within a key/scale at a given tempo.
   Can produce single notes, chords, or walking-bass patterns.
   ============================================================ */

'use strict';

const RandomGen = (() => {

  // Scale definitions (intervals from root in semitones)
  const SCALES = {
    'Chromatic':      [0,1,2,3,4,5,6,7,8,9,10,11],
    'Major':          [0,2,4,5,7,9,11],
    'Natural Minor':  [0,2,3,5,7,8,10],
    'Harmonic Minor': [0,2,3,5,7,8,11],
    'Dorian':         [0,2,3,5,7,9,10],
    'Phrygian':       [0,1,3,5,7,8,10],
    'Lydian':         [0,2,4,6,7,9,11],
    'Mixolydian':     [0,2,4,5,7,9,10],
    'Pentatonic Maj': [0,2,4,7,9],
    'Pentatonic Min': [0,3,5,7,10],
    'Blues':          [0,3,5,6,7,10],
    'Whole Tone':     [0,2,4,6,8,10],
    'Diminished':     [0,2,3,5,6,8,9,11],
    'Augmented':      [0,3,4,7,8,11],
    'Japanese':       [0,1,5,7,8],
  };

  const ROOT_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  const state = {
    enabled: false,
    bpm: 120,
    rootNote: 0,           // 0=C, 1=C#, etc.
    scale: 'Major',
    octaveLow: 3,
    octaveHigh: 5,
    noteLength: 0.5,       // fraction of step (0.1 = staccato, 1 = legato)
    density: 0.8,          // probability a step triggers (0..1)
    mode: 'single',        // 'single' | 'chord' | 'arp' | 'walk'
    chordSize: 3,          // notes in chord
    swing: 0,              // swing amount 0..1
    stepDiv: 8,            // steps per bar (8 = 8th notes, 16 = 16th notes)
  };

  let _timer = null;
  let _stepIndex = 0;
  let _arpNotes = [];
  let _arpIdx = 0;
  let _onNoteOn = null;
  let _onNoteOff = null;
  let _lastNote = null;
  let _walkDir = 1;

  function getScaleNotes() {
    const intervals = SCALES[state.scale] || SCALES['Major'];
    const notes = [];
    for (let oct = state.octaveLow; oct <= state.octaveHigh; oct++) {
      intervals.forEach(interval => {
        const midi = (oct + 1) * 12 + state.rootNote + interval;
        if (midi >= 21 && midi <= 108) notes.push(midi);
      });
    }
    return [...new Set(notes)].sort((a,b) => a - b);
  }

  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function step() {
    if (!state.enabled) return;

    const stepMs = (60000 / state.bpm) / (state.stepDiv / 4);
    const swingOffset = (_stepIndex % 2 === 1) ? stepMs * state.swing * 0.3 : 0;

    // Probability gate
    if (Math.random() > state.density) {
      scheduleNext(stepMs + swingOffset);
      _stepIndex++;
      return;
    }

    const noteLen = stepMs * state.noteLength;
    const notes = getScaleNotes();
    if (!notes.length) { scheduleNext(stepMs); _stepIndex++; return; }

    let toPlay = [];

    switch (state.mode) {
      case 'single':
        toPlay = [pickRandom(notes)];
        break;

      case 'chord': {
        // Random chord: root + stacked thirds within scale
        const root = pickRandom(notes);
        toPlay = [root];
        const scaleSet = new Set(getScaleNotes());
        let cursor = root;
        for (let i = 1; i < state.chordSize; i++) {
          // Find next scale note ~3-5 semitones up
          const candidates = notes.filter(n => n > cursor && n - cursor >= 3 && n - cursor <= 7);
          if (!candidates.length) break;
          cursor = candidates[Math.floor(Math.random() * Math.min(candidates.length, 2))];
          toPlay.push(cursor);
        }
        break;
      }

      case 'arp': {
        // Arp through a fixed chord
        if (_arpNotes.length === 0 || _stepIndex % (state.chordSize * 2) === 0) {
          const root = pickRandom(notes.filter(n => n % 12 === state.rootNote));
          _arpNotes = [];
          let cursor = root || notes[0];
          for (let i = 0; i < state.chordSize; i++) {
            _arpNotes.push(cursor);
            const next = notes.filter(n => n > cursor && n - cursor >= 3 && n - cursor <= 7);
            if (next.length) cursor = next[0]; else break;
          }
          _arpIdx = 0;
        }
        if (_arpNotes.length) {
          toPlay = [_arpNotes[_arpIdx % _arpNotes.length]];
          _arpIdx++;
        }
        break;
      }

      case 'walk': {
        // Walking bass: step-wise motion with occasional leaps
        if (_lastNote === null) _lastNote = notes[Math.floor(notes.length / 2)];
        const neighbors = notes.filter(n => Math.abs(n - _lastNote) <= 4 && n !== _lastNote);
        const leapTargets = notes.filter(n => Math.abs(n - _lastNote) > 4 && Math.abs(n - _lastNote) <= 10);
        const leap = Math.random() < 0.15 && leapTargets.length;
        const pool = leap ? leapTargets : (neighbors.length ? neighbors : notes);
        const next = pickRandom(pool);
        _lastNote = next;
        toPlay = [next];
        break;
      }
    }

    // Play
    toPlay.forEach(n => _onNoteOn && _onNoteOn(n, 0.7 + Math.random() * 0.25));

    // Schedule note off
    setTimeout(() => {
      toPlay.forEach(n => _onNoteOff && _onNoteOff(n));
    }, noteLen);

    _stepIndex++;
    scheduleNext(stepMs + swingOffset);
  }

  function scheduleNext(ms) {
    _timer = setTimeout(step, Math.max(10, ms));
  }

  function start() {
    if (_timer) stop();
    state.enabled = true;
    _stepIndex = 0;
    _arpNotes = [];
    _arpIdx = 0;
    _lastNote = null;
    const stepMs = (60000 / state.bpm) / (state.stepDiv / 4);
    scheduleNext(stepMs);
  }

  function stop() {
    state.enabled = false;
    clearTimeout(_timer);
    _timer = null;
  }

  function setCallbacks(onOn, onOff) {
    _onNoteOn = onOn;
    _onNoteOff = onOff;
  }

  function set(param, value) {
    state[param] = value;
    if (param === 'bpm' && state.enabled) {
      // Will take effect on next step automatically
    }
  }

  function getScaleNames() { return Object.keys(SCALES); }
  function getRootNames() { return ROOT_NAMES; }
  function getState() { return state; }

  return {
    start, stop, set, setCallbacks,
    getScaleNames, getRootNames, getState,
  };

})();
