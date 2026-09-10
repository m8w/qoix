/* ============================================================
   QOIX — Patch format
   ============================================================
   One snapshot covering every engine, so Save / Export capture
   the whole instrument rather than just the subtractive tab.

   Layout:

     {
       name: 'My Patch',
       qoixPatchVersion: 2,
       ...subtractive fields at the top level...
       engines: { fm, wt, matrix, spectral, micro, op1 }
     }

   The subtractive state stays at the top level on purpose. That
   is exactly the version 1 layout, so patches saved before this
   existed still load (they simply carry no `engines` block), and
   patches saved now still load their subtractive half in an older
   build. Adding an engine means adding one entry to ENGINES.
   ============================================================ */

'use strict';

const Patch = (() => {

  const VERSION = 2;

  const clone = v => JSON.parse(JSON.stringify(v));

  // Keys that live alongside the subtractive fields but are not part
  // of them. Synth.loadPreset deep-merges whatever it is handed, so
  // these are stripped off before it sees a patch — otherwise they
  // take up residence inside the synth's own state.
  const META_KEYS = ['engines', 'qoixPatchVersion'];

  function withoutMeta(obj) {
    const out = clone(obj);
    META_KEYS.forEach(k => delete out[k]);
    return out;
  }

  // Each engine says how to snapshot itself, how to restore itself,
  // and — for engines that build their audio graph lazily — how to
  // wake up when a patch arrives with them already switched on.
  const ENGINES = [
    {
      key: 'fm',
      get:   () => FMEngine.getState(),
      set:   s  => FMEngine.loadState(s),
      wake:  () => FMEngine.setContext(Synth._getContext(), Synth._voiceDestination),
      panic: () => FMEngine.panic(),
    },
    {
      key: 'wt',
      get:   () => WTEngine.getState(),
      set:   s  => WTEngine.loadState(s),
      wake:  () => WTEngine.setContext(Synth._getContext(), Synth._voiceDestination),
      panic: () => WTEngine.panic(),
    },
    {
      key: 'matrix',
      get:   () => ModMatrix.getState(),
      set:   s  => ModMatrix.loadState(s),
    },
    {
      key: 'spectral',
      get:   () => SpectralFFT.getState(),
      set:   s  => SpectralFFT.loadState(s),
      wake:  () => SpectralFFT.init(),
      panic: () => SpectralFFT.panic(),
    },
    {
      key: 'micro',
      get:   () => Microtonal.getState(),
      set:   s  => Microtonal.loadState(s),
    },
    {
      key: 'op1',
      get:   () => OP1Phase.getPatch(),
      set:   s  => OP1Phase.setPatch(s),
      wake:  () => OP1Phase.init(),
      panic: () => OP1Phase.panic(),
    },
  ];

  // The mod matrix and tuning have no enabled flag — they are always
  // live — so they simply never report as needing a wake.
  function engineEnabled(snapshot) {
    return !!(snapshot && snapshot.enabled);
  }

  // ── Snapshot everything ───────────────────────────────────
  function collect(name) {
    const patch = withoutMeta(Synth.getState());
    patch.name = (name || patch.name || 'Untitled').trim();
    patch.qoixPatchVersion = VERSION;

    patch.engines = {};
    ENGINES.forEach(e => {
      try { patch.engines[e.key] = clone(e.get()); }
      catch (err) { console.warn('[QOIX] patch: could not snapshot ' + e.key, err); }
    });

    return patch;
  }

  // ── Restore everything ────────────────────────────────────
  function apply(patch) {
    if (!patch || typeof patch !== 'object') return;

    // A patch change now swaps the whole instrument, so every engine
    // starts from silence rather than leaving voices sustaining under
    // settings that no longer exist.
    try { Synth.panic(); } catch (err) {}
    ENGINES.forEach(e => { if (e.panic) { try { e.panic(); } catch (err) {} } });

    Synth.loadPreset(withoutMeta(patch));

    // A version 1 patch carries the subtractive half only. Leave the
    // other engines exactly as they are rather than resetting them.
    const engines = patch.engines;
    if (!engines) return;

    ENGINES.forEach(e => {
      const snapshot = engines[e.key];
      if (!snapshot) return;
      try {
        e.set(snapshot);
        // An engine that arrives switched on needs its audio graph,
        // which it would otherwise only build on first manual enable.
        if (e.wake && engineEnabled(snapshot)) {
          Synth.ensureContext();
          e.wake();
        }
      } catch (err) {
        console.warn('[QOIX] patch: could not restore ' + e.key, err);
      }
    });
  }

  // ── Which engines a patch carries (for the UI summary) ────
  function enginesIn(patch) {
    if (!patch || !patch.engines) return [];
    return ENGINES.map(e => e.key).filter(k => patch.engines[k]);
  }

  function version(patch) {
    return (patch && patch.qoixPatchVersion) || 1;
  }

  // ── Factory presets ───────────────────────────────────────
  // The built-in presets describe a whole instrument ("Lead — Screaming
  // Saw"), but they were written before patches covered more than the
  // subtractive engine, so they carry no `engines` block. Loading one
  // as-is would leave whatever else is switched on playing over the
  // top, and the preset would not sound like its name. Give them an
  // engines block that switches the rest off.
  //
  // Legacy *user* patches are deliberately left alone by apply() — the
  // user's own intent there predates the feature and is ambiguous, so
  // their other engines survive the load.
  function asFactory(preset) {
    if (!preset) return preset;
    const out = clone(preset);
    if (out.engines) return out;          // already a full patch
    out.qoixPatchVersion = VERSION;
    out.engines = {
      fm:       Object.assign(clone(FMEngine.getState()),    { enabled: false }),
      wt:       Object.assign(clone(WTEngine.getState()),    { enabled: false }),
      spectral: Object.assign(clone(SpectralFFT.getState()), { enabled: false }),
      op1:      Object.assign(OP1Phase.getPatch(),           { enabled: false }),
      // The mod matrix and tuning are performance-wide rather than part
      // of a sound, so a factory preset leaves them untouched.
    };
    return out;
  }

  return { VERSION, collect, apply, enginesIn, version, asFactory };

})();
