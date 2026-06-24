# Building Fleet Commander

Fleet Commander is an **Electron** desktop app whose renderer (React/Vite) talks
to a **Flask backend** that runs as a bundled sidecar process. In a packaged
build the Flask sidecar also *serves* the built SPA, so the renderer and the API
stay same-origin (no CORS, NDJSON streaming works unchanged).

```
Fleet Commander.exe            ← Electron shell (electron/main.js)
└─ resources/
   ├─ backend/
   │   └─ fleet-commander-backend(.exe)   ← Flask sidecar (PyInstaller)
   └─ spa/                                 ← Vite build; Flask serves this
       ├─ index.html  assets/  *.ico/.jpg/.png
```

At launch, Electron spawns the backend with `BSM_SPA_DIR=<resources>/spa`,
waits for it to answer on `127.0.0.1:8765`, then loads that URL.

## Prerequisites

- **Node.js** 20+ (`npm`)
- **Python** 3.11+ with `venv`
- Build the app **on each target OS** — PyInstaller does not cross-compile, so
  build the Windows binary on Windows and the Linux binary on Linux.

## One-time setup

```bash
# 1. Frontend deps
npm install

# 2. Backend venv + runtime + build deps
cd backend
python -m venv .venv
#   Windows:
.venv\Scripts\python.exe -m pip install -r requirements.txt -r requirements-build.txt
#   Linux/macOS:
.venv/bin/python -m pip install -r requirements.txt -r requirements-build.txt
cd ..
```

## Build a release

```bash
npm run package        # renderer + backend binary + installer (NSIS / AppImage / dmg)
# or, faster, an unpacked app folder without an installer:
npm run package:dir
```

Outputs land in `release-builds/`:

- Windows: `release-builds/Fleet Commander Setup <version>.exe` (NSIS installer)
  and `release-builds/win-unpacked/Fleet Commander.exe` (run directly to test).
- Linux: `release-builds/Fleet Commander-<version>.AppImage`.

The individual steps (run automatically by `npm run package`):

```bash
npm run build          # tsc + vite → dist/  (the SPA)
npm run build:backend  # PyInstaller → backend/dist/fleet-commander-backend(.exe)
npx electron-builder   # bundle everything → release-builds/
```

## Development

```bash
npm run dev            # Flask + Vite (HMR) + Electron, all together
```

In dev the Vite dev server serves the renderer and proxies `/api` to Flask;
`BSM_SPA_DIR` is unset so Flask does **not** serve the SPA.

## Notes / gotchas

- **Unsigned binaries.** The beta is not code-signed, so Windows SmartScreen may
  warn ("More info → Run anyway"). Add a code-signing cert for production.
- **Windows icon** is `public/fleet.ico` (must be a square ≥256×256 .ico for the
  NSIS installer). Linux/macOS reuse it; for a polished Linux build supply a
  512×512 PNG.
- **Backend data** (saved scripts, `known_hosts`) lives under
  `%APPDATA%\Batch System Manager` (Windows) / `~/.local/share/batch-system-manager`
  (Linux), seeded on first run — never written inside the app bundle.
- **Antivirus / UPX.** UPX compression is disabled in the spec to avoid
  false-positive AV flags on the PyInstaller binary.
