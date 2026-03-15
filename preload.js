/* ============================================================
   QOIX Synthesizer — Electron Preload (Context Bridge)
   ============================================================
   Exposes a safe, minimal API from main process to renderer.
   contextIsolation: true ensures renderer cannot access Node.
   ============================================================ */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qoixApp', {

  // ── Platform info ────────────────────────────────────────
  platform: process.platform,    // 'darwin' | 'win32' | 'linux'
  isDesktop: true,

  // ── Preset file I/O ──────────────────────────────────────
  savePresetFile: (name, data) =>
    ipcRenderer.invoke('save-preset-file', { name, data }),

  readPresetFile: (filePath) =>
    ipcRenderer.invoke('read-preset-file', filePath),

  // ── Menu event listeners ─────────────────────────────────
  onMenuEvent: (channel, callback) => {
    const allowed = [
      'menu:panic',
      'menu:octave-up',
      'menu:octave-down',
      'menu:rand-start',
      'menu:rand-stop',
      'menu:export-preset',
      'menu:import-preset',
      'menu:show-shortcuts',
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },

  // ── Remove listener ──────────────────────────────────────
  removeMenuEvent: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
