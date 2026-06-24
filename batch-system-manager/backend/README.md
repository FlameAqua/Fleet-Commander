# Batch Device System Manager — User Manual

A local web tool for running batch SSH operations against a fleet of live
POSIX phone systems (Debian-based 3CX PBX appliances + OpenBSD edge boxes).

It does **five things**:

1. **Deploy heplify** — install or upgrade the SIP/HEP capture agent fleet-wide.
2. **Apt upgrade** — patch Debian / OpenBSD systems without rebooting.
3. **Quick diagnostic** — read-only fleet health snapshot.
4. **Custom script** — run any bash/sh script you write, optionally as root.
5. **3CX manager** — probe, audit, apply, export, and clone 3CX xAPI configuration.

Every action runs over SSH in parallel, with isolated per-host failures,
live streaming output, and one-click retry of failed hosts.

---

## Getting started

### Run the app

- **Windows**: double-click `run.bat`
- **Linux / macOS**: `./run.sh`

The app opens on http://127.0.0.1:8765. Python 3.9+ is required.

### Build a single Windows executable

On a build machine with Python installed, double-click `build_windows.bat`.
It creates/updates `.venv`, installs the runtime and PyInstaller build
dependencies, and writes:

```
dist\BatchSystemManager.exe
```

That `.exe` is self-contained for operators: they do not need Python,
Flask, Paramiko, or any other prerequisite installed. Double-clicking it
starts the local app and opens http://127.0.0.1:8765.

Runtime data is stored under `%APPDATA%\Batch System Manager` by default:
the saved-script library and SSH `known_hosts` are seeded there on first
run, then kept editable/persistent outside the executable. Set
`BSM_DATA_DIR` before launching if you need a portable data folder.

### Provide your fleet (Step 1)

Four ways to supply targets, switchable via the **Source** tabs:

| Mode | When to use |
|------|-------------|
| **KeePass CSV** | Recommended. One file exported straight from KeePass. |
| **Compound CSV** | When you need extra per-host columns (e.g. `$RootPassword`, `$SiteCode`). |
| **Two CSVs** | Legacy. Separate SSH-URL list + password list. |
| **Test Host** | Hardcoded single host. Type the password in the modal. |
| **Manual** | Type or paste SSH URLs and a password directly into the UI. |

### Pick an action (Step 2)

Each action tab has its own controls. Click the action's "Run" / "Apply" /
"Export" button to launch against every host in Step 1.

### Watch the live output

Each host gets a card. Click a card to expand its log. Cards update in
real time as the script runs — you do **not** wait for the whole fleet to
finish.

### Retry failed hosts

If anything fails, the **Fallback** button at the bottom of the results
panel re-runs just the failed hosts.

---

## Action 1 — Deploy heplify

Installs or upgrades the [heplify](https://github.com/sipcapture/heplify)
SIP/HEP capture agent on every host in Step 1 and starts the systemd
service.

### What it does on each host

1. Downloads `heplify_linux_amd64` for the selected release (3 retries,
   30s timeout). If the download fails, falls back to the known-good
   `2.0.21` build.
2. Verifies the binary is non-empty and actually executes.
3. Writes `/usr/local/bin/heplify-start.sh` with the configured interface,
   HEP server, capture mode, and discarded methods.
4. Writes `/etc/systemd/system/heplify.service`, reloads systemd, enables,
   restarts.
5. Confirms the unit is active and reports `systemctl status`.

### Default settings

```
-i ens18 -hs 10.0.0.10:9060 -m SIPRTCP -dd
-dim OPTIONS,NOTIFY,REGISTER -hn "$(hostname)"
```

Every value is editable in **Advanced options** with `shlex`-quoted
validation so nothing reaches the remote shell unescaped.

### Recommended workflow

1. Pick a heplify version (defaults to the latest GitHub release).
2. Click **Test** to deploy to the single test host first.
3. Verify with `heplify --version` on the test host, and check calls
   show up on your HOMER server.
4. Click **Universal Deploy** to fan out across the fleet.
5. If hosts fail, click **Fallback** to retry just them.

---

## Action 2 — Apt upgrade

Non-interactive patching that **never reboots and never restarts phone
services**, even if the OS flags them as required.

### Debian

```bash
NEEDRESTART_SUSPEND=1 apt-get update
NEEDRESTART_SUSPEND=1 apt-get -y upgrade
```

No `dist-upgrade`, no reboot, no service restarts. Pending-reboot or
service-restart flags are surfaced in the log but never acted on — those
require a maintenance window.

### OpenBSD

```sh
syspatch       # base-system errata, no reboot, no service restart
fw_update -a   # firmware patches
# sysupgrade is DELIBERATELY SKIPPED — it reboots into installer
```

### Recommended workflow

1. Click **Test apt upgrade** first to dry-run against the test host.
2. Click **Apt upgrade all hosts** once verified.

---

## Action 3 — Quick diagnostic

Read-only POSIX `sh` snapshot of fleet health. Nothing is modified, the
script always exits 0, and the entire run completes in seconds.

What it reports per host:

- `uptime`, kernel, OS family
- Load average (Linux `/proc/loadavg`, OpenBSD `sysctl`)
- Memory free (Linux `free(1)`, OpenBSD `vmstat`)
- Disk free on `/`
- `heplify.service` status (if present)
- Reboot-required flag (Debian/Ubuntu only)

Use it when you want to check "what's the state of the fleet right now"
without touching anything.

---

## Action 4 — Custom script

Run **any bash / sh / ksh / zsh script** you write or paste, on every host.

### Three ways to supply the script

| Tab | What it does |
|-----|--------------|
| **Paste** | Type or paste the script body directly. |
| **File** | Upload a `.sh` from disk. |
| **Library** | Save common scripts to `./scripts/` and pick from a dropdown. |

The library is a small CRUD-managed directory next to `app.py`. Filenames
must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$` and are force-suffixed `.sh`.

### Interpreter detection

The shebang on line 1 picks the interpreter:

| Shebang | Interpreter |
|---------|-------------|
| `#!/bin/bash` or `#!/usr/bin/env bash` | `bash -s` |
| `#!/bin/ksh` or `#!/usr/bin/env ksh` | `ksh -s` |
| `#!/bin/zsh` or `#!/usr/bin/env zsh` | `zsh -s` |
| `#!/bin/sh` or anything else / no shebang | `sh -s` (POSIX) |

The script is piped via stdin so it never appears in `ps` or `/proc/cmdline`.

### Root escalation

The script can run either as the SSH login user **or as root via `su`**.
Two ways to supply the root password:

#### Same password for all hosts (default)

Type one root password in the field. Used unchanged for every host. Leave
blank to run as the SSH user.

#### Per-host from Compound CSV column

When each system has a different root password, switch to **"Per-host
from Compound CSV column"** and type the column name (e.g. `RootPassword`).

Your Compound CSV would look like:

```csv
SSH URL,Password,RootPassword,SiteCode
ssh://admin@host1.example:22,sshpw1,rootpw1,ALPHA
ssh://admin@host2.example:22,sshpw2,rootpw2,BETA
```

Each host's script runs as root using **its own** credential from that
column. The column is **removed** from the script environment before
execution — a malicious script cannot read it via `$RootPassword`.

### Compound CSV columns become `$variables`

Any column in the Compound CSV (besides the SSH URL and the secret
`RootPassword` column you pointed at) is exported as a shell variable to
your script:

```bash
#!/bin/bash
# Given a Compound CSV with columns: SSH URL, Password, SiteCode
echo "Provisioning $(hostname) in site $SiteCode"
```

Column names are sanitized: `Web Site` becomes `$Web_Site`, `1pass` becomes
`$_1pass`.

### Example: backup `/etc/3cxpbx` on every host

```bash
#!/bin/bash
set -e
TS=$(date +%Y%m%d-%H%M%S)
tar czf /root/3cxpbx-$TS.tgz /etc/3cxpbx
echo "DEPLOY_RESULT=success"
```

Save this in the Library, pick it from the dropdown, and run with the root
password.

---

## Action 5 — 3CX manager

Drive the 3CX **xAPI** (OData v4 at `https://localhost/xapi/v1/`) across a
fleet of PBXes. Five modes, all using the same panel layout.

### How auth works

The script authenticates per-host using the PBX webclient API:

```
POST https://localhost/webclient/api/Login/GetAccessToken
{"Username":"0000","Password":"<pbx_pw>","SecurityCode":""}
```

The PBX password source depends on Step 1:

- **CSV / KeePass mode** — read from a Compound CSV column (default `Password`).
- **Test Host / Manual mode** — re-uses the **SSH password** you already typed.
  You enter your password once and it covers both SSH and the PBX.

### Entity panels

The 3CX tab starts with **Trunks** and **Users** panels. Click **+ Add
panel** to search and add any of the other 100+ entities. Remove a panel
with **✕ Remove**.

Each panel has:

- A **catalog** of common fields with checkboxes — tick the ones you want
  to enforce, type a value.
- An **Apply to items** filter — restrict actions to specific items by
  Name / Number. Syntax:

| Filter | Matches |
|--------|---------|
| `200-299` | Numeric range |
| `Local*` | Glob (case-insensitive) |
| `NTES` | Exact match (case-insensitive) |
| `200-299, NTES*` | Any combination (OR) |

- A **Custom fields** section to add fields not in the catalog.

### Mode 1: Probe

Discovers every available xAPI endpoint and dumps the fields and values
on the first item of each. Use this to **find field names** before adding
them to a custom row.

### Mode 2: Audit fields

Read-only PASS/FAIL check. For every item matching your filters, compares
each ticked field's current value against your target value. Per-host
card flips red if anything fails, with a per-field breakdown.

Useful for compliance checks: "Are all my trunks set to `DeliverAudio=true`?"

### Mode 3: Apply fields

PATCH-es every ticked field whose value differs from your target. Items
that already match are not touched. Per-field changes are logged with
`[before → after]`.

### Mode 4: Export as JSON

Dumps every active entity's full payload into a single JSON file that
downloads from the host card. The file is the "Golden Standard"
snapshot — a portable baseline you can re-import on other PBXes.

Sensitive fields (`*Password`, `*Secret`, `*Pin`) and per-PBX identity
fields (`Id`, `@odata.context`, etc.) are stripped before export.

### Mode 5: Import JSON

Apply a previously-exported Golden Standard JSON to every host in Step 1.
Pick a file → choose a strategy → confirm.

**Strategies:**

| Strategy | Creates | Patches | Deletes |
|----------|---------|---------|---------|
| **Merge** *(default)* | source-only items | matching items | — |
| **Additive only** | source-only items | — | — |
| **Patch only** | — | matching items | — |
| **Mirror** *(destructive)* | source-only items | matching items | target-only items |

**Merge** is recommended for Golden Standard cloning — a fresh PBX gets
the full baseline created, and an existing PBX gets stale defaults
overridden. **Mirror** requires you to type `MIRROR` in the modal to
confirm.

#### TrunkId remapping (automatic)

Outbound rule routes reference trunks by ID (e.g. `Routes[0].TrunkId: 33`).
That ID is per-source-PBX and won't exist on a fresh target. At import
start, the script fetches the **target's** trunks, builds a `TrunkName →
TrunkId` map, and rewrites every route to use the target's IDs.

If a trunk doesn't exist on the target yet (e.g. NTES not provisioned),
that route is dropped with a warning, but the rest of the rule still gets
created — so emergency routes (112, 999) work even before the trunk is
set up.

### ★ Golden Standard preset

One-click button that **wipes all current panels** and loads exactly the
four entities that never change between fresh phone systems:

- **Outbound Rules** — emergency / national / international dial plan
- **Notifications & Alerts** — alert recipients and thresholds (singleton)
- **IP Blocklist / Whitelist** — security baseline
- **Parameters** — filtered to `NOTALLOWED_COUNTRYCODES, MS_LOCAL_CODEC_LIST,
  MS_EXTERNAL_CODEC_LIST` (country-code policy and codec lists)

Trunks and Users are deliberately **not** in the preset — those are
per-system and stay manual.

### Typical Golden Standard workflow

1. On your **reference PBX**, configure the four entities exactly how you
   want them.
2. In Step 1, switch to **Test Host** and point it at the reference PBX.
3. In Step 2, open the **3CX manager** tab.
4. Click **★ Load Golden Standard preset**.
5. Click **Export as JSON** — the file downloads from the host card.
6. In Step 1, switch back to your fleet CSV.
7. Click **Import JSON**, pick the file, leave **Merge** selected, confirm.
8. The fleet now has the baseline.

---

## CSV file formats

### KeePass CSV (recommended)

Export the relevant entries straight out of KeePass with the default
columns:

```csv
"Account","Login Name","Password","Web Site","Comments"
"Site A","0000","s3cret","ssh://root@pbx01.example.internal","..."
"Site B web admin","admin","unused","https://pbx01.example.internal","ignored"
"Site C","0000","hunter2","ssh://root@pbx02.example.internal:2222","..."
```

- Parser keys off `Web Site` (URL) and `Password`.
- Only rows whose `Web Site` starts with `ssh://` are treated as deploy
  targets. Web-admin HTTPS rows are silently ignored.
- See `sample_keepass.csv` for a minimal example.

### Compound CSV (extra columns become `$variables`)

Like the KeePass CSV but with additional columns that get exposed to your
custom script as exported shell variables:

```csv
SSH URL,Password,RootPassword,SiteCode,Region
ssh://admin@host1.example:22,sshpw1,rootpw1,ALPHA,EU
ssh://admin@host2.example:22,sshpw2,rootpw2,BETA,US
```

In a custom script: `echo "Site $SiteCode in $Region"`.

### Two CSVs (legacy)

**SSH URLs CSV** — one URL per line, header optional:

```csv
url
ssh://root@pbx01.example.internal:22
ssh://admin@10.0.0.21:2222
```

Bare `host` or `user@host:port` also parse (defaults: user `root`,
port `22`).

**Passwords CSV** — most robust is two columns keyed by host:

```csv
host,password
pbx01.example.internal,•••••
10.0.0.21,•••••
```

Also accepted: a single password (applied to all hosts), or one password
per host in the same order as the URL file.

---

## Tips & troubleshooting

### "queued..." takes a while before output appears

Output streams as soon as each line is printed by the remote script. If
nothing appears, the script is probably still in its `urllib` or `apt
update` phase. For long operations the per-host card stays in `queued`
until the first line arrives.

### "Stream error" / "Upload rejected: payload exceeds ... MB"

The import payload exceeded one of two limits. The error message names
which one. Both default to 128 MB. Restart the Flask process after
changing them — `debug=False` means no auto-reload.

### Per-host card flips red with no exit code

Connect failure (DNS, refused, timeout) — see the `host-msg` field for the
specific error. Most common: wrong port, host unreachable, SSH password
mismatch.

### "DEPLOY_RESULT=success not seen"

The built-in scripts (Deploy / Apt) emit a sentinel `DEPLOY_RESULT=success`
on success. If the script ran to exit 0 but the sentinel didn't appear,
the per-host card shows this message. Custom scripts don't need the
sentinel — the absence of "require_marker" for custom is intentional.

### "Argument list too long" (import)

Shouldn't happen anymore — the import payload is delivered via a temp
file written by a bash heredoc, bypassing the Linux 128 KB env-var
limit. If you see this on a custom-script run, the script itself is
exceeding `MAX_ARG_STRLEN`.

### Output looks garbled with random characters during export

Should also no longer happen — the export base64 payload is suppressed in
the live log and the visible card shows a single `[export payload
streaming...]` placeholder. If you see raw base64, refresh the page —
your browser is running a stale `index.html`.

### My custom script changes some state but doesn't seem to apply

Check the script's exit code in the host card. A non-zero exit is shown
explicitly. If the script `set -e` aborted, the failing command is the
last line of output.

### Per-host root password mode doesn't escalate

Make sure:

1. The Compound CSV actually has the column you typed.
2. The column header matches **exactly** (case-sensitive).
3. The radio is set to **"Per-host from Compound CSV column"** not
   "Same password for all hosts".

The script preview's `PRIVILEGE:` line tells you which mode is active
and which column it's using.

---

## Security model

This tool does exactly what you ask it to, but credentials in CSV form
are the weakest link. Be deliberate.

### What's protected

- **All credentials live in memory only.** Never written to disk, never
  logged, never included in the per-host output.
- **The remote script is piped to bash over stdin.** Passwords and the
  script body never appear in `ps` or `/proc/cmdline`.
- **Server binds to `127.0.0.1` only.** Do **not** expose it on a network
  without authentication in front of it — it accepts credential uploads.
- **Host-key TOFU.** First connection learns the host key into a local
  `known_hosts`. Tick **Strict host-key checking** after the first deploy
  so subsequent runs reject changed keys.
- **Injection-safe script building.** Every operator-supplied value
  (version tag, interface, HEP server, etc.) is validated against a
  strict pattern and `shlex`-quoted before reaching the shell.
- **3CX exports strip secrets.** Any field whose name contains
  `Password`, `Secret`, or `Pin` is removed recursively before the JSON
  is written. Per-PBX identity fields (`Id`, `@odata.context`, etc.) are
  also stripped so a re-import can't collide.
- **Per-host root password columns are stripped from the script env.**
  When you pick "Per-host from CSV column" for the root password, that
  column is removed from `host_vars` before being exposed to your script.

### Recommended hardening for production

- Prefer **SSH keys over passwords**. If you must use passwords, store
  the CSV in a secrets manager or encrypted volume, delete it after the
  run, and rotate any password that has been on disk in plaintext.
- Deploy from a **dedicated jump host** on the management network rather
  than a laptop.
- Consider creating a **least-privilege deploy account** with a narrow
  `sudoers` rule for install commands instead of using `root` directly.
- Pin a specific **heplify version** for fleet-wide rollouts (use
  *latest* only after testing).

### Live-system safeguards (hardcoded)

- OpenBSD `sysupgrade` is **always skipped** — it would reboot the host
  into the installer.
- Debian apt upgrades always set `NEEDRESTART_SUSPEND=1`. **No
  dist-upgrade. No reboot, ever**, even if pending-reboot is flagged.
- The 3CX export never includes `Id`, `IsRegistered`, `IsOnline`,
  `Created`, `Used`, `Revoked`, `@odata.*` fields, or anything matching
  the password / secret / pin keyword strip list.

---

## Files

| File | Purpose |
|------|---------|
| `app.py` | Flask server, streaming `/api/deploy` endpoint, form parsing |
| `deployer.py` | CSV parsers, SSH execution, script generators, 3CX logic |
| `templates/index.html` | Single-page UI (controls + live results) |
| `static/` | Logo/favicon assets |
| `scripts/` | Operator-saved custom scripts |
| `run.bat`, `run.sh` | One-click launchers (Windows / macOS / Linux) |
| `sample_keepass.csv` | Example combined KeePass export |
| `sample_ssh_urls.csv`, `sample_passwords.csv` | Example two-file inputs |
| `README.md` | This file — user manual |
| `CLAUDE.md` | Developer / maintenance guide |

## Environment variables

- `DEPLOYER_HOST` / `DEPLOYER_PORT` — bind address (default `127.0.0.1:8765`)
- `GITHUB_TOKEN` — optional; raises GitHub API rate limit for release lookups
