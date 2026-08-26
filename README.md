# Fleet Commander

A desktop tool for running commands across a fleet of SSH-reachable systems —
3CX phone systems, Debian/OpenBSD hosts and MikroTik RouterOS devices — with
per-host results streaming back live.

Pick a fleet → pick an action → watch it run.

> Fleet Commander connects to production systems and runs commands as root.
> Actions are labelled read-only, modifying or destructive, and anything beyond
> read-only asks for confirmation first. Treat changes to this codebase with
> that in mind.

## What it does

- **Fleets from wherever you keep them** — a KeePass `.kdbx` vault, a CSV
  (plain or encrypted), a pasted list, or typed in by hand.
- **Actions** — run a custom script, manage 3CX (audit/apply/import/export),
  deploy the heplify capture agent, upgrade systems (Debian, OpenBSD, RouterOS,
  optionally rebooting), or take a read-only diagnostic snapshot.
- **A real script editor** — shell syntax highlighting, `$Column` autocomplete
  from your CSV's headers, and pre-flight warnings for the mistakes that are
  cheap to make and expensive to discover on 200 machines.
- **Results you can work with** — search, filter by outcome, retry just the
  failures, export logs.
- **Credentials stay in memory.** CSVs can be stored encrypted; the plaintext
  original is removed after import.

## Requirements

- Node.js 20+
- Python 3.11+ with `venv`
- Windows or Linux (build on the OS you're targeting — PyInstaller doesn't
  cross-compile)

## Setup

```bash
npm install
```

```bash
cd backend && python -m venv .venv && .venv/Scripts/python.exe -m pip install -r requirements.txt -r requirements-build.txt
```

On Linux use `.venv/bin/python` instead.

## Running it

```bash
npm run dev
```

This starts the Flask backend, the Vite dev server and Electron together. The
first run after a dependency change spends an extra 10–15s pre-bundling; the
window shows a boot screen while it does.

Site-specific values are read from the environment so nothing internal lives in
the repo:

```
BSM_TEST_HOST=ssh://root@lab-pbx.internal   # sandbox target (also settable in Settings)
BSM_HEP_SERVER=10.0.0.10:9060               # HEP collector for the heplify action
BSM_CAPTURE_IFACE=ens18                     # default capture interface
```

## Checks

```bash
npx tsc -b && npx eslint . && npm test && npm run build
```

`npm test` runs the backend suite. ESLint reports warnings but should report
**zero errors**.

## Building a release

```bash
npm run package
```

Runs the renderer build, the PyInstaller sidecar build and electron-builder,
producing an installer in `release-builds/`. See [BUILDING.md](BUILDING.md) for
the details and the CI release flow.

## Documentation

| Document | For |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Contributors and AI assistants — architecture, invariants, the things that are easy to get wrong |
| [SECURITY.md](SECURITY.md) | Threat model, residual risks, rules for security-relevant changes |
| [BUILDING.md](BUILDING.md) | Packaging and release |
| [backend/README.md](backend/README.md) | The operator's manual, also shown in-app under Help |

## Contributing

Read [CLAUDE.md](CLAUDE.md) first — it exists so you don't have to rediscover
the non-obvious constraints. In particular:

- Never commit real hostnames, IPs, host keys or credentials. See the
  "Never commit" section of [SECURITY.md](SECURITY.md).
- `src/lib/csv.ts` and `backend/deployer.py` mirror each other's host-label
  logic; change both together.
- Run all four checks above before opening a PR.
