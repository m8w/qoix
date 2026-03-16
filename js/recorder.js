/* ============================================================
   QOIX Synthesizer — Session Recorder
   ============================================================
   Records live note events + synth state snapshot.
   Plays back the session with the original patch settings.
   Save/load sessions as JSON files.
   ============================================================ */

'use strict';

const Recorder = (() => {

  let _recording  = false;
  let _playing     = false;
  let _startTime   = 0;
  let _events      = [];
  let _patchState  = null;
  let _playTimers  = [];
  let _sessionName = 'Session';
  let _onUpdate    = null;   // callback for UI refresh

  function setUpdateCallback(fn) { _onUpdate = fn; }
  function _notify() { if (_onUpdate) _onUpdate(); }

  // ── Record ────────────────────────────────────────────────
  function startRecording() {
    if (_recording) return;
    _recording  = true;
    _events     = [];
    _startTime  = performance.now() / 1000;
    // Snapshot current synth settings at the moment recording starts
    _patchState = JSON.parse(JSON.stringify(Synth.getState()));
    _notify();
    console.log('[Recorder] Recording started');
  }

  function stopRecording() {
    if (!_recording) return;
    _recording = false;
    _notify();
    console.log(`[Recorder] Stopped — ${_events.length} events, ${getDuration().toFixed(2)}s`);
  }

  // Called by UI's playNote / releaseNote wrappers
  function recordNoteOn(midiNote, velocity) {
    if (!_recording) return;
    _events.push({ type: 'noteOn', note: midiNote, velocity, time: _elapsed() });
  }

  function recordNoteOff(midiNote) {
    if (!_recording) return;
    _events.push({ type: 'noteOff', note: midiNote, time: _elapsed() });
  }

  function _elapsed() {
    return performance.now() / 1000 - _startTime;
  }

  // ── Playback ──────────────────────────────────────────────
  function startPlayback() {
    if (_playing || _events.length === 0) return;
    _playing = true;
    _playTimers = [];

    // Restore the patch from when recording started
    if (_patchState) Synth.loadPreset(_patchState);

    const pbStart = performance.now() / 1000;

    _events.forEach(ev => {
      const delay = Math.max(0, ev.time * 1000);
      const t = setTimeout(() => {
        if (!_playing) return;
        if (ev.type === 'noteOn') {
          Synth.noteOn(ev.note, ev.velocity);
          if (typeof UI !== 'undefined' && UI._setPianoKeyExternal) UI._setPianoKeyExternal(ev.note, true);
        } else {
          Synth.noteOff(ev.note);
          if (typeof UI !== 'undefined' && UI._setPianoKeyExternal) UI._setPianoKeyExternal(ev.note, false);
        }
      }, delay);
      _playTimers.push(t);
    });

    // Auto-stop after last event + release tail
    const totalDur = getDuration();
    const stopTimer = setTimeout(() => {
      stopPlayback();
    }, (totalDur + 1.5) * 1000);
    _playTimers.push(stopTimer);

    _notify();
    console.log('[Recorder] Playback started');
  }

  function stopPlayback() {
    if (!_playing) return;
    _playing = false;
    _playTimers.forEach(t => clearTimeout(t));
    _playTimers = [];
    Synth.panic();
    _notify();
    console.log('[Recorder] Playback stopped');
  }

  // ── Session info ──────────────────────────────────────────
  function getDuration() {
    if (_events.length === 0) return 0;
    return _events[_events.length - 1].time;
  }

  function getNoteCount() {
    return _events.filter(e => e.type === 'noteOn').length;
  }

  function isRecording() { return _recording; }
  function isPlaying()   { return _playing; }
  function hasSession()  { return _events.length > 0; }

  // ── Save / Load ───────────────────────────────────────────
  function saveSession(name) {
    const session = {
      version: 1,
      name: name || _sessionName,
      created: new Date().toISOString(),
      duration: getDuration(),
      noteCount: getNoteCount(),
      synthState: _patchState,
      events: _events,
    };
    const json = JSON.stringify(session, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = (name || 'qoix-session').replace(/\s+/g, '-') + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function loadSession(json) {
    const session = typeof json === 'string' ? JSON.parse(json) : json;
    if (!session.events || !session.synthState) throw new Error('Invalid session file');
    _events     = session.events;
    _patchState = session.synthState;
    _sessionName = session.name || 'Session';
    _recording  = false;
    _playing    = false;
    _notify();
    console.log(`[Recorder] Session loaded: "${_sessionName}", ${_events.length} events, ${getDuration().toFixed(2)}s`);
    return session;
  }

  return {
    startRecording, stopRecording,
    recordNoteOn, recordNoteOff,
    startPlayback, stopPlayback,
    isRecording, isPlaying, hasSession,
    getDuration, getNoteCount,
    saveSession, loadSession,
    setUpdateCallback,
  };

})();
