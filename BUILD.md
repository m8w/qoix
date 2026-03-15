# QOIX Synthesizer — Build Guide

## Prerequisites

- Node.js 18+ (https://nodejs.org)
- npm 9+

## Setup

```bash
npm install
```

## Run in development

```bash
npm start
# or with DevTools open:
npm run dev
```

## Build installers

```bash
# Current platform only
npm run build

# macOS — universal binary (Intel + Apple Silicon M2)
npm run build:mac

# Windows
npm run build:win

# Linux
npm run build:linux

# All platforms (requires cross-compile tooling)
npm run build:all
```

Output goes to `dist/`.

## macOS outputs
| File | Purpose |
|------|---------|
| `QOIX Synthesizer-1.0.0-universal.dmg` | Drag-to-install for Mac users |
| `QOIX Synthesizer-1.0.0-universal-mac.zip` | For auto-updater |

## Windows outputs
| File | Purpose |
|------|---------|
| `QOIX Synthesizer Setup 1.0.0.exe` | NSIS installer |
| `QOIX Synthesizer 1.0.0.exe` | Portable (no install) |

## Linux outputs
- `.AppImage` — universal, runs anywhere
- `.deb` — Debian/Ubuntu
- `.rpm` — Fedora/RHEL

## Icons needed in `assets/`

| File | Size | Platform |
|------|------|----------|
| `icon.icns` | macOS icon bundle | macOS |
| `icon.ico` | Multi-res ICO | Windows |
| `icon.png` | 512×512 PNG | Linux |
| `dmg-background.png` | 540×380 | macOS DMG background |

Use a tool like https://www.electron.build/icons to generate from a single 1024×1024 PNG.

## Signing & Notarization (macOS)

Set these environment variables before building:
```bash
export APPLE_ID="your@email.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
```

Then build — electron-builder handles notarization automatically.

## Auto-updates

Update `package.json` → `build.publish` with your GitHub repo.
Releases pushed via `npm run dist` will trigger auto-update in installed copies.
