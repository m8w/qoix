/* ============================================================
   QOIX Synthesizer — Electron Main Process
   ============================================================ */

'use strict';

const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require('electron');
const path  = require('path');
const isDev = process.argv.includes('--dev');

// ── Single instance lock ───────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

let mainWindow = null;

// ── Create window ──────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1440,
    height:          900,
    minWidth:        800,
    minHeight:       600,
    title:           'QOIX Synthesizer',
    backgroundColor: '#0c0d11',
    titleBarStyle:   process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    show:            false,   // show after ready-to-show
    icon:            path.join(__dirname, 'assets', getIconName()),
    webPreferences: {
      preload:              path.join(__dirname, 'preload.js'),
      contextIsolation:     true,
      nodeIntegration:      false,
      // Web Audio: allow audio autoplay without user gesture in desktop
      autoplayPolicy:       'no-user-gesture-required',
      // MIDI access
      experimentalFeatures: true,
    },
  });

  // Allow mic access for the Granular engine's live-input sampling
  // (macOS mic entitlement is declared in assets/entitlements.mac.plist)
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });

  // Load the synth
  mainWindow.loadFile('index.html');

  // Show once fully rendered (no white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function getIconName() {
  if (process.platform === 'darwin')  return 'icon.icns';
  if (process.platform === 'win32')   return 'icon.ico';
  return 'icon.png';
}

// ── Second instance → focus existing window ───────────────
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── App menu ───────────────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),

    // File
    {
      label: 'File',
      submenu: [
        {
          label: 'Export Preset…',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:export-preset'),
        },
        {
          label: 'Import Preset…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
              title:      'Import QOIX Preset',
              filters:    [{ name: 'QOIX Preset', extensions: ['qoix', 'json'] }],
              properties: ['openFile'],
            });
            if (!canceled && filePaths[0]) {
              mainWindow?.webContents.send('menu:import-preset', filePaths[0]);
            }
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },

    // Edit
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },

    // Synth
    {
      label: 'Synth',
      submenu: [
        {
          label: 'Panic (All Notes Off)',
          accelerator: 'CmdOrCtrl+.',
          click: () => mainWindow?.webContents.send('menu:panic'),
        },
        { type: 'separator' },
        {
          label: 'Octave Up',
          accelerator: 'CmdOrCtrl+Up',
          click: () => mainWindow?.webContents.send('menu:octave-up'),
        },
        {
          label: 'Octave Down',
          accelerator: 'CmdOrCtrl+Down',
          click: () => mainWindow?.webContents.send('menu:octave-down'),
        },
        { type: 'separator' },
        {
          label:        'Start Random Generator',
          accelerator:  'CmdOrCtrl+R',
          click:        () => mainWindow?.webContents.send('menu:rand-start'),
        },
        {
          label:        'Stop Random Generator',
          accelerator:  'CmdOrCtrl+Shift+R',
          click:        () => mainWindow?.webContents.send('menu:rand-stop'),
        },
      ],
    },

    // View
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },

    // Help
    {
      role: 'help',
      submenu: [
        {
          label: 'QOIX Website',
          click: () => shell.openExternal('https://qoix.app'),
        },
        {
          label: 'Keyboard Shortcuts',
          click: () => mainWindow?.webContents.send('menu:show-shortcuts'),
        },
        { type: 'separator' },
        {
          label: 'About QOIX',
          click: () => dialog.showMessageBox(mainWindow, {
            type:    'info',
            title:   'QOIX Synthesizer',
            message: 'QOIX Synthesizer',
            detail:  `Version ${app.getVersion()}\n\nFM Synthesis · Wavetable · Oxford Harmonic\nMod Matrix · Random Generator\n\nBuilt with Web Audio API + Electron`,
            icon:    path.join(__dirname, 'assets', getIconName()),
          }),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC handlers ───────────────────────────────────────────

// Renderer → Main: save preset file
ipcMain.handle('save-preset-file', async (event, { name, data }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title:       'Save QOIX Preset',
    defaultPath: `${name.replace(/[^a-z0-9]/gi, '_')}.qoix`,
    filters:     [{ name: 'QOIX Preset', extensions: ['qoix'] }],
  });
  if (canceled || !filePath) return { ok: false };
  const fs = require('fs');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true, filePath };
});

// Renderer → Main: read preset file
ipcMain.handle('read-preset-file', async (event, filePath) => {
  const fs = require('fs');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Lifecycle ──────────────────────────────────────────────
app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
