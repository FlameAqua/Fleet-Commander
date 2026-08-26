# Fleet Commander — working notes for AI assistants

Read this before changing anything. It records the things that are easy to get
wrong here and expensive to discover later.

## What this app is

A desktop tool for running commands across a fleet of SSH-reachable systems
(3CX phone systems, Debian/OpenBSD hosts, MikroTik RouterOS devices). An
operator picks a fleet, picks an action, and watches per-host results stream in.

**It runs privileged commands on live production systems.** A bug here doesn't
render a wrong pixel; it can take down a customer's phone system, or several
hundred of them at once. Prefer the cautious change. When an action is
destructive, the UI is expected to say so before it runs.

## Shape

Three processes, started together by `npm run dev`:

```
Electron main  (electron/main.js)   window, auto-update, spawns the backend
     │
     ├── renderer  (src/, React + Vite)         the UI
     └── Flask sidecar  (backend/app.py)        SSH work, file/crypto handling
```

- The renderer never does SSH. It POSTs to the Flask API and reads an NDJSON
  stream of per-host events.
- In dev, Vite serves the renderer on `127.0.0.1:5173` and proxies `/api` to
  Flask on `8765`. In a packaged build, Flask serves the built SPA itself, so
  the renderer and API are same-origin and no proxy exists.
- Both bind **loopback only**. That is a load-bearing part of the threat model
  (see `SECURITY.md`).

## Layout

| Path | What lives there |
|---|---|
| `electron/main.js` | Window, single-instance lock, backend lifecycle, auto-update, IPC handlers |
| `electron/preload.cjs` | The **entire** renderer↔main bridge. Adding to it is a security decision |
| `src/App.tsx` | Top-level state: the three-step flow, run orchestration |
| `src/features/source/` | Step 1 — where hosts come from (CSV, manual, paste, KeePass) |
| `src/features/run/` | Step 2/3 — actions, the deploy form, results |
| `src/lib/csv.ts` | Pure parsing/normalising helpers. **Mirrors `deployer.py`** — see below |
| `backend/app.py` | Flask API, request validation, file/crypto endpoints |
| `backend/deployer.py` | SSH execution, per-action scripts, host-key handling |
| `tools/` | Dev launchers and the build/test wrappers behind the npm scripts |

## Rules that aren't obvious

**`src/lib/csv.ts` mirrors `backend/deployer.py`.** The frontend computes the
same canonical host label (`ssh://user@host:port`) the backend will produce, so
the checklist, the "retry failed hosts" replay and the backend's dedupe all
agree. If you change label/URL handling on one side, change the other.

**Host variables reach a root shell.** CSV column values are exported into the
remote script (`_build_host_vars_prelude`). They are POSIX-quoted there. Don't
build shell strings from user input anywhere else without `shlex.quote`, or
base64 the payload as the `su` path does.

**Passwords are in-memory only.** They come from a CSV, a typed field, or a
KeePass vault, and are never written to disk by the app. Don't add logging that
could capture them, and don't persist them "for convenience".

**Everything site-specific ships blank.** `deployer.TEST_HOST`,
`DEFAULT_HEP_SERVER` and `backend/known_hosts` are deliberately empty in the
repo and come from the environment or per-user settings. Never commit a real
hostname, IP or host key — see `SECURITY.md`.

**The renderer's scroll container is `.app__scroll`, not the window.** The
custom title bar sits above it. `window.scrollTo` won't do what you expect.

**Background effects respect `prefers-reduced-motion`,** which Windows turns on
for RDP sessions. Every animated layer needs a sensible *static* state — a
frozen animation that leaves everything in one spot is a bug. Settings has an
"Animate anyway" override that keys off `data-motion="full"` on `<html>`.

## Working on it

```bash
npm run dev
```

Starts Flask, Vite and Electron together. Notes:

- First run after a dependency or `vite.config.ts` change re-bundles deps and
  takes ~10–15s longer. The window shows a boot screen meanwhile — that's
  `electron/boot.html`, not a hang.
- Closing the app window ends the whole stack (`concurrently -k`). That's normal
  shutdown, not a crash.
- `FC_DEVTOOLS=0 npm run dev` skips auto-opening DevTools (~3s faster).
- Electron 42 logs `sandboxed_renderer.bundle.js script failed to run` at
  startup. It is benign — the preload bridge loads fine. Don't chase it.

Verify changes with all four; they're fast and they catch different things:

```bash
npx tsc -b && npx eslint . && npm test && npm run build
```

`npm test` runs the backend suite (`backend/tests/test_api.py`) — plain asserts,
no pytest. ESLint currently reports ~31 warnings and **0 errors**; keep errors
at zero rather than chasing the warnings, which are mostly deliberate
`Math.random` use in the decorative scenery.

The renderer can be driven in a normal browser at `http://127.0.0.1:5173` while
`npm run dev` runs, which is far easier to inspect than the Electron window.

## Packaging

```bash
npm run build          # renderer → dist/
npm run build:backend  # PyInstaller sidecar → backend/dist/ (slow, minutes)
npm run package        # electron-builder → release-builds/
```

If you add a **Python** dependency that's imported lazily, add it to
`hiddenimports` in `backend/fleet-commander-backend.spec` or it will be missing
from the packaged sidecar while working perfectly in dev. Test the packaged
binary, not just the venv.

If you add a **runtime npm** dependency, nothing special is needed — but check
`optimizeDeps.include` in `vite.config.ts`, which exists to keep the cold start
to one pass.

## Before you finish

- Did you touch anything that runs on a remote host? Re-read it as "this will
  run as root on 200 machines at once".
- Did you add a preload method, an IPC channel, or an endpoint that takes a
  path? That's a security-relevant change — check it against `SECURITY.md`.
- Did you add a site-specific value? It belongs in the environment or settings,
  not in the source.
