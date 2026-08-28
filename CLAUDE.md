# Fleet Commander — working notes for contributors and AI assistants

Read this before changing anything. It is the cold-start brief: what the app
is, how it is put together, and the things that are easy to get wrong here and
expensive to discover later.

## The one thing to internalise first

**Fleet Commander runs privileged commands on live production systems.** A bug
here doesn't render a wrong pixel; it can take down a customer's phone system,
or several hundred of them at once, in parallel, as root.

That shapes every decision in this codebase:

- Prefer the cautious change. When in doubt, make it ask.
- Every action is classified `read-only` / `modifies` / `destructive`
  (`src/features/run/riskAssessment.ts`), and anything past read-only goes
  through a confirmation modal before it runs.
- Built-in scripts never reboot or restart phone services unless the operator
  explicitly asked. OpenBSD `sysupgrade` is deliberately skipped (it reboots
  into the installer). Debian sets `NEEDRESTART_SUSPEND=1`, no dist-upgrade.
- Credentials are memory-only, everywhere, always.

Before you finish a change, re-read anything you touched that reaches a remote
host as *"this will run as root on 200 machines at once."*

## Documentation map

| File | What it is for |
|---|---|
| `CLAUDE.md` (this file) | Repo-wide architecture, invariants, workflows |
| `AGENTS.md` | A pointer to this file for tools that look for that name |
| `SECURITY.md` | Threat model, residual risks, rules for security-relevant changes |
| `BUILDING.md` | Packaging and the release pipeline |
| `README.md` | Contributor-facing overview and setup |
| `backend/README.md` | The **operator's** manual; also shown in-app under Help |
| `backend/CLAUDE.md` | The Flask backend and the 3CX engine in depth |

`backend/CLAUDE.md` is the deep reference for `deployer.py` — especially the
3CX xAPI work (entities, filters, import strategies, trunk-id remapping) which
this file only summarises. Its **frontend** sections predate the React rewrite;
where it describes `templates/index.html`, `scheduleLogFlush` or
`maybeOfferThreecxExport`, the live equivalents are in `src/`.

## Shape

Three processes, started together by `npm run dev`:

```
Electron main  (electron/main.js)   window, auto-update, spawns the backend
     │
     ├── renderer  (src/, React 19 + Vite)      the UI
     └── Flask sidecar  (backend/app.py)        SSH work, file/crypto handling
```

- The renderer **never does SSH**. It POSTs to the Flask API and reads an
  NDJSON stream of per-host events.
- In dev, Vite serves the renderer on `127.0.0.1:5173` and proxies `/api` to
  Flask on `8765`. In a packaged build, Flask serves the built SPA itself
  (`BSM_SPA_DIR`), so the renderer and API are same-origin and no proxy exists.
  Keeping them same-origin is what makes NDJSON streaming work without CORS.
- Both bind **loopback only**. That is a load-bearing part of the threat model
  (see `SECURITY.md`).

Electron owns the backend's lifecycle in production: it kills any stale sidecar
on port 8765, spawns its own, waits for it to answer, then loads the window. In
dev it defers to the sidecar `npm run dev` already started.

## Layout

| Path | What lives there |
|---|---|
| `electron/main.js` | Window, single-instance lock, backend lifecycle, navigation lockdown, auto-update, IPC handlers |
| `electron/preload.cjs` | The **entire** renderer↔main bridge. Adding to it is a security decision |
| `electron/boot.html` | Local boot screen shown while Vite warms up in dev |
| `src/App.tsx` | Top-level state: the three-step flow, run orchestration, approval + batching |
| `src/api.ts` | Every call to the Flask API, plus `ApiError` / `errMsg` |
| `src/lib/csv.ts` | Pure parsing/normalising helpers. **Mirrors `deployer.py`** — see below |
| `src/lib/stream.ts` | The NDJSON client for `/api/deploy` and its event types |
| `src/features/source/` | Step 1 — where hosts come from (CSV, manual, paste, KeePass) |
| `src/features/run/` | Step 2/3 — actions, deploy form, risk assessment, script lint, results |
| `src/features/threecx/` | The 3CX Manager panel, entity catalogs, export chip |
| `src/features/scripts/` | The saved-script library UI |
| `src/components/` | Shared UI + the decorative scenery (stars, aurora, clouds, waves) |
| `backend/app.py` | Flask API, request validation, file/crypto endpoints, the streaming run loop |
| `backend/deployer.py` | SSH execution, per-action scripts, host-key handling, the 3CX engine |
| `backend/bsm_paths.py` | Data-dir resolution, settings.json, first-run seeding |
| `backend/scripts/` | Sample operator scripts, seeded into the data dir on first run |
| `backend/templates/index.html` | **Legacy** vanilla-JS UI. Only reachable if the backend runs standalone without `BSM_SPA_DIR`. Not the app |
| `tools/` | Dev launchers and the build/test wrappers behind the npm scripts |

## The run lifecycle — trace this once and the app makes sense

```
src/App.tsx  startRun()
  │  assessRisk() → approval modal for anything past read-only
  │  buildDeployForm()          src/features/run/deployForm.ts
  │  appendSourceToForm()       src/features/source/sourceModel.ts
  ▼  multipart POST
backend/app.py  deploy()
  │  _resolve_targets_creds()   CSVs → List[Target] + {label: password}
  │  per-action script build    deployer.build_*_script() / uploaded script
  │  host_vars + root_passwords resolution  (see "Host variables" below)
  ▼
ThreadPoolExecutor(max_workers)  → deployer.deploy_host() per target
  │  paramiko connect (TOFU host key) → exec interpreter, script over stdin
  │  each output line → log_callback → queue.Queue
  ▼
Flask generator drains the queue → NDJSON, one JSON object per line
  ▼
src/lib/stream.ts runDeploy() → src/features/run/useDeployRun.ts
  │  meta | start | log | result | summary | fatal
  ▼  log lines batched into one setState per animation frame
src/features/run/ResultsPanel.tsx
```

Events on the wire, in order: `meta` (counts + resolved settings), one `start`
per host, interleaved `log` lines from every host, one `result` per host, then
`summary`. A pre-run failure arrives as a single `fatal` line with HTTP 200 —
**not** a non-200 status. Handle it as an event, not an error.

## The domain model

**Three steps.** Choose your Fleet → Choose Action → Voyage Results. The
stepper in `App.tsx` gates forward movement; advancing from step 1 nudges the
operator to run a connect-only SSH validation (`/api/auth-check`) first.

**Source modes** (`src/features/source/sourceModel.ts`):

| Mode | Shape | Becomes |
|---|---|---|
| `compound` | One imported CSV, column-mapped, per-host checklist | `keepass_csv` + `host_vars` |
| `manual` | Typed rows (url / user / password) | virtual `ssh_csv` + `pass_csv` |
| `paste` | A pasted block, one host per line, with defaults | same as manual |

A CSV can arrive plaintext, decrypted from a `.enc` (`/api/decrypt-csv`), or
extracted from a KeePass `.kdbx` vault (`/api/kdbx-csv`, which returns only
entries whose URL parses as an SSH target).

**Run modes** sent as `mode`: `universal` (everything selected) and `fallback`
(replay only the labels that failed). The backend also implements `test` (the
single sandbox host), but **the React renderer no longer sends it** — the
sandbox target now appears as a one-click row in Manual mode instead. Treat
the backend's `test` branch as legacy until someone deletes or rewires it.

**Actions** (`action` form field, validated in `app.py`):

| Action | Interpreter | Marker required | Notes |
|---|---|---|---|
| `custom_script` | from the shebang, or `routeros` | no | The flexible one. Root escalation lives here |
| `threecx` | `bash -s` | no | Probe / Audit / Apply / Export / Import against the 3CX xAPI |
| `apt_upgrade` | `auto_system_upgrade` → `sh -s` or RouterOS | yes | Debian + OpenBSD + MikroTik. Optional final reboot |
| `quick_diag` | `sh -s` | no | Read-only snapshot; POSIX `sh` so OpenBSD works |
| `deploy` | `bash -s` | yes | Installs/upgrades heplify, the SIP/HEP capture agent |

"Marker required" means the run only counts as successful if the script exits 0
**and** printed `DEPLOY_RESULT=success`. Built-in scripts emit it; operator
scripts don't, so they're judged on exit status alone.

**Canonical host label.** Every host is identified everywhere by
`ssh://user@host:port` — the value of `Target.label`. Results, retries,
`host_vars` keys and the checklist all key off it.

**Exit codes.** 0 = success, 1 = error, 2 = "Failure" (a planned, meaningful
non-zero, always present). Codes 3–9 can be given custom labels in Settings and
become their own filter chips in the results
(`src/features/run/exitCategories.ts`).

## Rules that aren't obvious

**`src/lib/csv.ts` mirrors `backend/deployer.py`.** The frontend computes the
same canonical host label the backend will produce, so the checklist, the
"retry failed hosts" replay and the backend's dedupe all agree. It also mirrors
`_sanitise_var_name` so the `$Column` autocomplete in the script editor offers
the names the backend will actually export. If you change label or variable-name
handling on one side, change the other, and update `tools/test-csv.ts`.

**Host variables reach a root shell.** Compound-CSV column values are exported
into the remote script by `_build_host_vars_prelude`. They are POSIX-quoted
there. Don't build shell strings from user input anywhere else without
`shlex.quote`, or base64 the payload as the `su` path does.

**`$Password` is deliberately exposed; the root-password column deliberately is
not.** The SSH credential is mirrored into `host_vars[label]["Password"]` for
every source mode so `$Password` means the same thing everywhere (the 3CX
action needs it). The per-host *root* password column is **popped** out of
`host_vars` in `app.py` before anything reaches a script. Tests cover both —
see `test_password_var_*` and `test_root_password_column_still_stripped`.

**Escalation is `su`, never `sudo`.** The SSH user is intentionally *not* in
sudoers; the security model is "escalate by knowing the root password".
`_exec_with_su` allocates a PTY, base64s the script into a self-contained
pipeline so quoting can't break it, answers the `Password:` prompt, and filters
that prompt back out of the captured output. Don't add a sudo wrapper.

**RouterOS is not POSIX.** MikroTik devices land you in the RouterOS console
over SSH — no `sh`, no `su`, no env vars. The `host_vars` prelude is skipped for
them, risk assessment uses a separate pattern list, and `apt_upgrade` sniffs the
SSH banner (`rosssh` / `mikrotik`) before choosing its path. `/system package
update install` reboots on its own, independently of the UI's reboot toggle.

**Passwords are in-memory only.** They come from a CSV, a typed field, or a
KeePass vault, and are never written to disk by the app. Don't add logging that
could capture them, don't put them in NDJSON events or exported result logs, and
don't persist them "for convenience".

**Everything site-specific ships blank.** `deployer.TEST_HOST`,
`DEFAULT_HEP_SERVER` and `backend/known_hosts` are deliberately empty in the
repo and come from the environment (`BSM_TEST_HOST`, `BSM_HEP_SERVER`,
`BSM_CAPTURE_IFACE`) or per-user settings. Never commit a real hostname, IP or
host key — see `SECURITY.md`.

**Concurrent host-key writes were a real outage.** `known_hosts` is read with a
hand-rolled scrubber (paramiko's loader dies on a mangled blob), merged under a
lock, and written atomically via temp-file + rename. Don't replace this with
`AutoAddPolicy`.

**The renderer's scroll container is `.app__scroll`, not the window.** The
custom title bar sits above it. `window.scrollTo` won't do what you expect.

**Background effects respect `prefers-reduced-motion`,** which Windows turns on
for RDP sessions. Every animated layer needs a sensible *static* state — a
frozen animation that leaves everything in one spot is a bug. Settings has an
"Animate anyway" override that keys off `data-motion="full"` on `<html>`.

**Flask runs with `debug=False`** (the auto-reloader interferes with the
streaming endpoint), so **every backend change needs a process restart.** The
renderer hot-reloads; the backend does not.

## Where state lives

**Backend data dir** — `%APPDATA%\Batch System Manager` (Windows) or
`~/.local/share/batch-system-manager` (Linux), overridable with `BSM_DATA_DIR`.
Resolved by `bsm_paths.py`, seeded on first run, **never** written inside the
app bundle. It holds `scripts/`, `csv/`, `ships/`, `known_hosts` and
`settings.json` (folder overrides + the sandbox target).

**Renderer** — `localStorage` only, for preferences: `fc.theme`, `fc.anim`,
`fc.fx`, `fc.shipFreq`, `fc.exitCategories`, `bsm.scriptsDir`. Nothing sensitive
goes here.

## The API surface

All routes are same-origin, loopback, and guarded by `_csrf_guard` on every
mutating request (`GET`s are exempt).

| Route | Purpose |
|---|---|
| `POST /api/deploy` | The run. Multipart in, NDJSON stream out |
| `POST /api/auth-check` | Connect-only SSH validation, also NDJSON |
| `GET /api/config` | Sandbox target + heplify defaults for startup |
| `GET/POST/DELETE /api/scripts…` | The saved-script library (+ categories, move) |
| `GET /api/csv-files`, `/api/csv-file/<name>` | The CSV library folder |
| `POST /api/decrypt-csv`, `/api/encrypt-csv`, `/api/delete-csv-file` | `.enc` handling (PBKDF2-HMAC-SHA256, 480k iters → Fernet) |
| `POST /api/kdbx-csv` | KeePass vault → canonical CSV |
| `GET/POST /api/settings` | Folder overrides, sandbox target |
| `POST /api/pick-folder`, `/api/pick-scripts-dir` | Native Tk folder picker |
| `GET /api/ships`, `POST /api/ship-upload`, `/api/ship-delete` | Decorative clip-art |
| `GET /api/releases` | heplify versions from GitHub |
| `GET /`, `GET /<path>` | The built SPA, when `BSM_SPA_DIR` is set |

Two upload limits both matter: `MAX_CONTENT_LENGTH` **and** Werkzeug's separate
`MAX_FORM_MEMORY_SIZE` (default 500 KB), which a large 3CX import trips even
though the request is well under the total cap. Both are raised to 128 MB and
the 413 handler reports which one fired.

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
- `predev` runs `tools/free-ports.mjs`, which frees 5173/8765 if a previous run
  left them held. It only kills our own process images.
- `FC_DEVTOOLS=0 npm run dev` skips auto-opening DevTools (~3s faster).
- Electron 42 logs `sandboxed_renderer.bundle.js script failed to run` at
  startup. It is benign — the preload bridge loads fine. Don't chase it.
- The renderer can be driven in a normal browser at `http://127.0.0.1:5173`
  while `npm run dev` runs, which is far easier to inspect than the Electron
  window. The Electron-only bits (window controls, auto-update, native file
  paths) degrade gracefully there.

Verify changes with all four; they're fast and they catch different things:

```bash
npx tsc -b && npx eslint . && npm test && npm run build
```

Expected today: `tsc` clean, ESLint **31 warnings, 0 errors**, `npm test`
`44/44 checks passed`. Keep errors at zero rather than chasing the warnings,
which are deliberate (`Math.random` in the decorative scenery, latest-ref
assignment, setState in data-fetch effects).

`npm test` runs `backend/tests/test_api.py` — plain asserts, no pytest, and it
needs `backend/.venv`. The frontend CSV helpers have their own suite that is
**not** wired into `npm test`; run it by hand when you touch `src/lib/csv.ts`:

```bash
node --experimental-strip-types tools/test-csv.ts
```

## Packaging and release

```bash
npm run build          # renderer → dist/
npm run build:backend  # PyInstaller onedir → backend/dist/ (slow, minutes)
npm run package        # electron-builder → release-builds/
```

- The sidecar is a PyInstaller **onedir** bundle on purpose: onefile re-unpacks
  the whole runtime into a temp dir on every launch.
- If you add a **Python** dependency that's imported lazily, add it to
  `hiddenimports` in `backend/fleet-commander-backend.spec` or it will be
  missing from the packaged sidecar while working perfectly in dev. Test the
  packaged binary, not just the venv.
- If you add a **runtime npm** dependency, nothing special is needed — but check
  `optimizeDeps.include` in `vite.config.ts`, which exists to keep the cold
  start to one pass.
- Releases are tag-driven: pushing `v*` runs `.github/workflows/release.yml`,
  which syncs the package version to the tag, builds, pre-creates the GitHub
  Release (so concurrent asset uploads can't race into duplicates) and
  publishes. A tag with a hyphen (`v1.0.0-beta.1`) publishes as a pre-release.
- The updater is tokenless — the repo is public and `allowPrerelease=false`, so
  clients resolve through `/releases/latest`. Validate a release's feed with
  `node tools/check-update.mjs`; a release missing `latest.yml` looks fine on
  GitHub and silently breaks every client.
- **Working in a git worktree:** each worktree needs its own `backend/.venv`
  before `npm test` or `npm run build:backend` will work, and
  `npm run package:dir` fails with `EPERM` when its output lands inside
  `.claude/worktrees/`. Point the output elsewhere:
  `npx electron-builder --dir -c.directories.output=<dir outside the worktree>`.

## Recipes

**Add an action.** Add the id to `ActionId` (`deployForm.ts`), to the `TABS`
list in `ActionPanel.tsx`, and to `assessRisk()`. Backend: add it to the
allowlist set in `app.deploy()`, build its script in `deployer.py`, and pick an
`interpreter` / `require_marker` / `success_text`. Decide explicitly whether it
receives `host_vars` — today only `custom_script` and `threecx` do.

**Add a 3CX entity.** Register it in `TCX_ENDPOINTS`
(`src/features/threecx/catalogs.ts`), optionally with a field catalog in
`TCX_EXTRA_CATALOGS`. Singletons are auto-detected server-side (no `value` key
in the response). Never hand-write a field list — derive it from the OData
schema with `backend/scripts/probe-xapi-metadata.sh`. See `backend/CLAUDE.md` §5.

**Add a preload method.** That is a security decision. Add a *named,
fixed-purpose* function plus a matching `ipcMain` handler that validates its
input. Never a generic `send(channel, data)`. See `SECURITY.md` rule 1.

**Add an endpoint that takes a path.** Basename it, validate against an
allowlist pattern, then resolve it under a known directory. An extension check
alone is not enough. Match `_sanitize_script_name` / `_sanitize_category`.

## Known limitations and accepted debt

- **No retry for transient network errors.** One TCP hiccup fails that host;
  "Retry failed hosts" is the workaround.
- **No rollback on a 3CX import.** A partial import leaves the target mixed.
  Audit first.
- **`backend/CLAUDE.md`'s frontend sections are pre-React** — see the doc map.
- **The backend `mode=test` path is unreachable from the current UI.**
- **`templates/index.html` is a 6k-line legacy UI** kept only as a standalone
  fallback. Don't develop against it.
- **`/api/delete-csv-file` can delete any `.csv` on the machine** (it refuses
  directories, non-`.csv` and `.enc`). Contained by the local-only trust
  boundary; don't widen it.

## Before you finish

- Did you touch anything that runs on a remote host? Re-read it as "this will
  run as root on 200 machines at once".
- Did you add a preload method, an IPC channel, or an endpoint that takes a
  path? That's a security-relevant change — check it against `SECURITY.md`.
- Did you change host labels or CSV variable names? Change both sides.
- Did you add a site-specific value? It belongs in the environment or settings,
  not in the source.
- Did all four checks pass?
