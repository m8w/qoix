'use strict';

var Microtonal = (function () {

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    enabled: false,
    rootNote: 60,            // Middle C
    scaleName: '12-EDO (Standard)',
    scale: null,             // null → standard 12-TET
  };

  // ---------------------------------------------------------------------------
  // Built-in scale library (SCL text strings)
  // ---------------------------------------------------------------------------

  const SCALE_LIBRARY = {

    '12-EDO (Standard)': `! 12-EDO.scl
!
12 equal divisions of the octave
 12
!
 100.000
 200.000
 300.000
 400.000
 500.000
 600.000
 700.000
 800.000
 900.000
 1000.000
 1100.000
 2/1
`,

    '19-EDO': `! 19-EDO.scl
!
19 equal divisions of the octave
 19
!
 63.158
 126.316
 189.474
 252.632
 315.789
 378.947
 442.105
 505.263
 568.421
 631.579
 694.737
 757.895
 821.053
 884.211
 947.368
 1010.526
 1073.684
 1136.842
 2/1
`,

    '24-EDO (Quarter-tone)': `! 24-EDO.scl
!
24 equal divisions of the octave (Arabic/Turkish music)
 24
!
 50.000
 100.000
 150.000
 200.000
 250.000
 300.000
 350.000
 400.000
 450.000
 500.000
 550.000
 600.000
 650.000
 700.000
 750.000
 800.000
 850.000
 900.000
 950.000
 1000.000
 1050.000
 1100.000
 1150.000
 2/1
`,

    '31-EDO': `! 31-EDO.scl
!
31 equal divisions of the octave (extended meantone)
 31
!
 38.710
 77.419
 116.129
 154.839
 193.548
 232.258
 270.968
 309.677
 348.387
 387.097
 425.806
 464.516
 503.226
 541.935
 580.645
 619.355
 658.065
 696.774
 735.484
 774.194
 812.903
 851.613
 890.323
 929.032
 967.742
 1006.452
 1045.161
 1083.871
 1122.581
 1161.290
 2/1
`,

    'Pythagorean': `! pythagorean.scl
!
Pythagorean 12-note scale (stacked pure 3/2 fifths)
 12
!
 90.225
 203.910
 294.135
 407.820
 498.045
 588.270
 701.955
 792.180
 905.865
 996.090
 1109.775
 2/1
`,

    'Just Intonation (5-limit)': `! just_5limit.scl
!
Just intonation 5-limit 12-note scale
 12
!
 16/15
 9/8
 6/5
 5/4
 4/3
 45/32
 3/2
 8/5
 5/3
 16/9
 15/8
 2/1
`,

    'Meantone 1/4-comma': `! meantone_1_4comma.scl
!
Quarter-comma meantone 12-note scale
 12
!
 76.049
 193.157
 269.205
 386.314
 503.422
 579.471
 696.578
 772.627
 889.735
 996.843
 1082.892
 2/1
`,

    'Werckmeister III': `! werckmeister3.scl
!
Werckmeister III well-tempered tuning (Bach)
 12
!
 90.225
 192.180
 294.135
 390.225
 498.045
 588.270
 696.090
 792.180
 888.270
 996.090
 1092.180
 2/1
`,

    'Kirnberger III': `! kirnberger3.scl
!
Kirnberger III well-tempered tuning
 12
!
 90.225
 193.157
 294.135
 386.314
 498.045
 590.224
 696.578
 792.180
 889.735
 996.090
 1088.269
 2/1
`,

    '7-EDO': `! 7-EDO.scl
!
7 equal divisions of the octave (African/neutral)
 7
!
 171.429
 342.857
 514.286
 685.714
 857.143
 1028.571
 2/1
`,

    '5-EDO (Pentatonic)': `! 5-EDO.scl
!
5 equal divisions of the octave (pentatonic)
 5
!
 240.000
 480.000
 720.000
 960.000
 2/1
`,

    'Bohlen-Pierce': `! bohlen_pierce.scl
!
Bohlen-Pierce scale, 13 steps in tritave (3/1 period)
 13
!
 27/25
 25/21
 9/7
 7/5
 75/49
 5/3
 9/5
 49/25
 15/7
 7/3
 63/25
 25/9
 3/1
`,

    'Pure Harmonics (8-16)': `! pure_harmonics.scl
!
Pure harmonic series partials 8 through 16
 8
!
 9/8
 5/4
 11/8
 3/2
 13/8
 7/4
 15/8
 2/1
`,

  };

  // ---------------------------------------------------------------------------
  // SCL parser
  // ---------------------------------------------------------------------------

  /**
   * Parse a Scala .scl format string.
   * Returns { description, count, pitches, period } where pitches includes
   * the implicit root 0.0 at index 0 followed by the N parsed pitch values.
   * Throws an Error on invalid input.
   */
  function parseScl(text) {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error('parseScl: empty or non-string input');
    }

    // Split into lines and strip comment lines (lines starting with '!')
    const lines = text.split('\n').map(l => l.trim()).filter(l => l !== '' && l[0] !== '!');

    if (lines.length < 2) {
      throw new Error('parseScl: too few non-comment lines (need at least description + count)');
    }

    // Line 0: description
    const description = lines[0];

    // Line 1: note count (positive integer)
    const countStr = lines[1].split(/\s+/)[0];
    const count = parseInt(countStr, 10);
    if (isNaN(count) || count < 1) {
      throw new Error('parseScl: invalid note count "' + countStr + '"');
    }

    // Lines 2 .. 2+count-1: pitch values
    const pitchLines = lines.slice(2);
    if (pitchLines.length < count) {
      throw new Error(
        'parseScl: expected ' + count + ' pitch values but found ' + pitchLines.length
      );
    }

    // Implicit root is 0.0¢
    const pitches = [0.0];

    for (let i = 0; i < count; i++) {
      const token = pitchLines[i].split(/\s+/)[0]; // ignore inline comments
      const cents = parsePitchToken(token, i + 1);
      pitches.push(cents);
    }

    const period = pitches[pitches.length - 1];

    return { description, count, pitches, period };
  }

  /**
   * Convert a single SCL pitch token to cents.
   * Token is either:
   *   - a decimal number (contains '.')  → cents directly
   *   - a ratio "num/den"                → 1200 * log2(num/den)
   *   - a plain integer                  → 1200 * log2(n/1)
   */
  function parsePitchToken(token, lineIndex) {
    if (token.indexOf('.') !== -1) {
      // Cents value
      const v = parseFloat(token);
      if (isNaN(v)) {
        throw new Error('parseScl: invalid cents value "' + token + '" at pitch ' + lineIndex);
      }
      return v;
    } else if (token.indexOf('/') !== -1) {
      // Ratio num/den
      const parts = token.split('/');
      if (parts.length !== 2) {
        throw new Error('parseScl: invalid ratio "' + token + '" at pitch ' + lineIndex);
      }
      const num = parseFloat(parts[0]);
      const den = parseFloat(parts[1]);
      if (isNaN(num) || isNaN(den) || den === 0) {
        throw new Error('parseScl: invalid ratio "' + token + '" at pitch ' + lineIndex);
      }
      return 1200 * Math.log2(num / den);
    } else {
      // Integer → n/1
      const n = parseFloat(token);
      if (isNaN(n) || n <= 0) {
        throw new Error('parseScl: invalid integer ratio "' + token + '" at pitch ' + lineIndex);
      }
      return 1200 * Math.log2(n);
    }
  }

  // ---------------------------------------------------------------------------
  // Frequency conversion
  // ---------------------------------------------------------------------------

  function noteToFreq(midiNote) {
    if (!state.enabled || !state.scale) {
      // Standard 12-TET fallback
      return 440 * Math.pow(2, (midiNote - 69) / 12);
    }

    const { pitches, count, period } = state.scale;

    // Map midiNote offset from root into scale degree + octave count
    const offset = midiNote - state.rootNote;
    const degree = ((offset % count) + count) % count;   // 0 .. count-1
    const octaves = Math.floor(offset / count);
    const centsFromRoot = pitches[degree] + octaves * period;
    const rootFreq = 440 * Math.pow(2, (state.rootNote - 69) / 12);
    return rootFreq * Math.pow(2, centsFromRoot / 1200);
  }

  // ---------------------------------------------------------------------------
  // Public mutators
  // ---------------------------------------------------------------------------

  function setEnabled(v) {
    state.enabled = !!v;
  }

  function setRoot(midiNote) {
    const n = Math.round(midiNote);
    if (n < 0 || n > 127) {
      throw new Error('setRoot: MIDI note must be 0-127, got ' + midiNote);
    }
    state.rootNote = n;
  }

  function setScaleByName(name) {
    if (!Object.prototype.hasOwnProperty.call(SCALE_LIBRARY, name)) {
      throw new Error('setScaleByName: unknown scale "' + name + '"');
    }
    const parsed = parseScl(SCALE_LIBRARY[name]);
    state.scale = parsed;
    state.scaleName = name;
  }

  function loadScl(text) {
    const parsed = parseScl(text);
    state.scale = parsed;
    state.scaleName = parsed.description;
  }

  // ---------------------------------------------------------------------------
  // Public accessors
  // ---------------------------------------------------------------------------

  function getScaleNames() {
    return Object.keys(SCALE_LIBRARY);
  }

  /**
   * Return an array of { degree, cents, label } for every step in the current
   * scale (including the implicit root at degree 0).
   * If no scale is loaded, returns 12-TET degrees.
   */
  function getCentsTable() {
    const table = [];

    if (!state.scale) {
      // 12-TET fallback display
      for (let d = 0; d < 12; d++) {
        table.push({ degree: d, cents: d * 100, label: String(d) });
      }
      return table;
    }

    const { pitches, count } = state.scale;

    // pitches[0] is the implicit root (0.0¢), pitches[1..count] are the scale steps
    for (let d = 0; d < count; d++) {
      table.push({
        degree: d,
        cents: pitches[d],
        label: String(d),
      });
    }

    return table;
  }

  function getState() {
    return state;
  }

  // ---------------------------------------------------------------------------
  // Initialise with the default scale so state.scale is populated
  // ---------------------------------------------------------------------------

  setScaleByName('12-EDO (Standard)');
  // But keep enabled = false so it acts as 12-TET until explicitly turned on
  state.enabled = false;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    noteToFreq,
    setEnabled,
    setRoot,
    setScaleByName,
    loadScl,
    getScaleNames,
    getCentsTable,
    getState,
    parseScl,
  };

}());
