# Batch Device System Manager — Developer / Maintenance Guide

This file is the cold-start brief for Codex (and any human picking up the
codebase). It captures **what the app does, why it's structured this way,
where to find things, and the non-obvious gotchas** that took real time to
work out.

The user-facing manual lives in `README.md`. **Do not duplicate it here** —
this file is for implementers.

---

## 1. What this app is

A local Flask web UI (binds 127.0.0.1:8765) that runs SSH-driven batch
operations against fleets of live POSIX phone systems — primarily **3CX
PBX appliances** (Debian-based) plus a handful of OpenBSD edge boxes.

It does five things:

| Action          | What it runs                                                   |
| --------------- | -------------------------------------------------------------- |
| `deploy`        | Install/upgrade **heplify** (SIP/HEP capture agent) per host   |
| `apt_upgrade`   | Apt update + upgrade on Debian; syspatch+fw_update on OpenBSD  |
| `quick_diag`    | Read-only POSIX `sh` snapshot (uptime, load, mem, disk, etc.)  |
| `custom_script` | An operator-supplied script — pasted, uploaded, or from disk   |
| `threecx`       | Probe / Audit / Apply / Export / Import on the 3CX xAPI        |

Every action runs over SSH via **paramiko**, with optional **`su` root
escalation** (the SSH user can be unprivileged; escalation is by knowing the
root password, NOT by sudoers membership — this is deliberate).

These are **live production phone systems**. The rules:

- Never reboot. Never restart phone services.
- OpenBSD `sysupgrade` is **deliberately skipped** (would reboot into installer).
- Debian: `NEEDRESTART_SUSPEND=1`, no dist-upgrade, no reboots even if flagged.
- Passwords are **memory-only**. Never logged. Never written to disk.
- The 3CX `$Password` CSV column is **not exported** as an env var by default.

---

## 2. File map — where to find what

```
app.py                    Flask routes, /api/deploy streaming endpoint,
                          form parsing, ThreadPoolExecutor + queue pipeline,
                          413 error handler, per-host root-password resolution.

deployer.py               Everything that actually runs against a remote host:
                            • DeployConfig, Target, HostResult dataclasses
                            • parse_ssh_url, load_targets, load_credentials,
                              load_keepass_csv (CSV parsers)
                            • build_apt_upgrade_script, build_quick_diag_script,
                              build_threecx_script (script generators)
                            • _build_host_vars_prelude (CSV → env var injection)
                            • _exec_with_su (PTY-based su escalation)
                            • deploy_host (the SSH orchestrator)
                            • All 3CX logic — entities, filters, export,
                              import, trunk-id remapping — lives inside the
                              raw-string bash template in build_threecx_script.

templates/index.html      The entire UI. Single file, vanilla JS. ~3800 lines.
                          Hosts: HTML, CSS, all JS (no bundler).
                          Tab structure: Source (CSV/KeePass/Test/Manual)
                            + Action (Deploy / Custom / 3CX / Apt / Diag).

static/                   Just the favicon/logo.
scripts/                  Operator-saved custom scripts (managed via
                          /api/scripts CRUD endpoints).

README.md                 User-facing manual. Don't put dev notes here.
AGENTS.md                 This file.
run.bat / run.sh          Launchers.
```

---

## 3. Architecture & data flow

### High level

```
Browser (index.html)
  │ POST multipart/form-data → /api/deploy
  │   • mode      (universal | test | fallback)
  │   • action    (deploy | apt_upgrade | custom_script | quick_diag | threecx)
  │   • CSVs      (keepass_csv  OR  ssh_csv + pass_csv)
  │   • host_vars (per-host Compound CSV columns as JSON {label: {col: val}})
  │   • action-specific blobs (threecx_config, custom_script file, etc.)
  ▼
Flask /api/deploy (app.py)
  │ • _build_config(request.form)                — DeployConfig
  │ • parses targets + creds from CSVs           — List[Target], creds dict
  │ • builds `script` text per action            — bash / sh / python heredoc
  │ • resolves per-host root_passwords dict      — inline or CSV-column source
  │ • injects per-host host_vars (env vars)      — except secret columns
  ▼
ThreadPoolExecutor (workers = min(max_workers, len(targets)); test mode = 1)
  │ Each worker calls deployer.deploy_host(target, password, script, cfg, ...)
  ▼
deploy_host (deployer.py)
  │ • paramiko SSHClient.connect (host key TOFU)
  │ • Either:
  │     normal path  → exec_command(interpreter) + stdin.write(script)
  │     su   path    → _exec_with_su (PTY + 'su -c "..." root')
  │ • Reads stdout line-by-line, calls log_callback(line) per line
  │ • Returns HostResult(target, ok, stage, message, exit_status, output, duration_s)
  ▼
Per-host log_callback (in app.py _run closure)
  │ Pushes {"type": "log", "host": label, "line": ...} into a queue.Queue
  │ On host finish, pushes {"type": "result", ...HostResult fields...}
  ▼
Flask generator drains the queue → NDJSON over stream_with_context
  ▼
Browser handleEvent
  │ • "meta"   → header count
  │ • "start"  → create host card (dot=run, msg="queued…")
  │ • "log"    → scheduleLogFlush(pre, line) — batched via rAF
  │ • "result" → set dot ok/fail, overwrite pre.textContent with ev.output,
  │              call maybeOfferThreecxExport (strips base64, offers download)
  │ • "summary"→ Fallback button enables for failed hosts
```

### Key invariant: Compound CSV columns become `$variables`

If the Compound CSV has columns beyond `SSH URL` and `Password`, those
columns are sent to the backend as `host_vars_by_label[label][col_name]`.

`_build_host_vars_prelude` in `deployer.py` turns them into a POSIX-`sh`
prelude like:

```sh
export SiteCode='ALPHA'
export RootPassword='hunter2'
```

…which is prepended to the user's script. **Secret columns must be stripped
in `app.py` BEFORE handing to deploy_host** — see the root-password block
around line 555.

---

## 4. Action: Custom Script (deep dive)

The most flexible action. The operator supplies a script and the app runs it
on every host.

### 4.1 Source of the script (Sub-tab)

- **Paste**  — `<textarea>`. Line endings normalized to `\n` (CRLF/CR break
  shell `\`-newline continuations).
- **File**   — uploaded `.sh`. Same normalization.
- **Library**— operator-saved scripts in `./scripts/`. Managed via
  `/api/scripts` (CRUD). Filenames validated against
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$` and force-suffixed `.sh`.

### 4.2 Interpreter detection

`deployer._get_interpreter(script)` reads the shebang:

| Shebang                       | Interpreter |
| ----------------------------- | ----------- |
| `#!/bin/bash` / env bash      | `bash -s`   |
| `#!/bin/ksh`  / env ksh       | `ksh -s`    |
| `#!/bin/zsh`  / env zsh       | `zsh -s`    |
| `#!/bin/sh`   / anything else | `sh -s`     |

The script is piped via stdin so it never appears in `ps`/`/proc/cmdline`
(argv-list-too-long is not an issue here — the script is bytes-on-stdin).

### 4.3 Root escalation (two modes)

**Inline (default)** — operator types one root password used for every
host. `app.py` populates `root_passwords[label] = inline_root_pw` for every
target.

**Per-host CSV column** — operator picks the radio "Per-host from Compound
CSV column" and types a column name (e.g. `RootPassword`). For each host,
`app.py`:

1. Pops the column out of `host_vars_by_label[label]` (so it does **not**
   leak into the script as `$RootPassword`).
2. Stores it in `root_passwords[label]`.

Both modes pass the per-host value to `deploy_host(root_password=...)`,
which routes to `_exec_with_su`.

### 4.4 `_exec_with_su` — how escalation actually works

`su -c '<interp>' root` requires a **PTY** and reads its password from
`/dev/tty`. The function:

1. `chan.get_pty(term="dumb", width=200, height=50)` — modest size, no
   echo race.
2. `exec_command("su -c 'printf %s <b64> | base64 -d | bash -s' root")` —
   the script is base64-d into a self-contained pipeline so it survives
   all shell quoting and never reads from the PTY itself.
3. Waits up to 15s for `Password:` (case-insensitive, several variants).
4. `chan.sendall(root_password + "\n")`.
5. Drains stdout chunk-by-chunk, emitting whole lines to `log_callback`.
6. Filters the visible `Password:` prompt out of the captured output.

We deliberately avoid `sudo` — `sudo` checks sudoers, our SSH user is
intentionally **not** in sudoers. That's the whole point of this model.

### 4.5 Compound CSV columns → `$variables`

Any column present in the Compound CSV becomes an exported shell variable.
Column names are sanitized by `_sanitise_var_name` (non-`[A-Za-z0-9_]` →
`_`, leading digit gets `_` prefix).

`Password` is the SSH password — already used for the SSH connection. It is
**still exported as `$Password`** today (used by the 3CX action). This is
an unfortunate footgun for custom scripts; if a future task needs to harden
this, filter `Password` out of `host_vars` for the `custom_script` action
specifically.

---

## 5. Action: 3CX (deep dive)

This is the big one. Drives the 3CX **xAPI** (OData v4 at
`https://localhost/xapi/v1/`).

### 5.1 Auth flow

```python
POST https://localhost/webclient/api/Login/GetAccessToken
Content-Type: application/json
{"Username": "0000", "Password": "<pbx_pw>", "SecurityCode": ""}
→ {"Token": {"access_token": "..."}}
```

Self-signed cert → `ssl.CERT_NONE` (we're on localhost). Subsequent
requests carry `Authorization: Bearer <access_token>`.

The PBX password is sourced via `password_source`:
- `"csv"`    — read from a Compound CSV column (default name: `Password`)
- `"inline"` — one password for every host, supplied in Advanced section
- `"ssh"`    — **frontend sentinel only**. The backend in `app.py` rewrites
               this to `"csv"` + column `"Password"` and mirrors each host's
               SSH credential into `host_vars_by_label[label]["Password"]`.
               This is what makes **Test Host / Manual** modes work with a
               single password prompt — same SSH and PBX credential.

### 5.2 Entity model

`ENTITIES` dict in `deployer.py` (inside the bash template raw string).
Each entry:

```python
{
    "label":       "Trunks",                              # human label
    "path":        "/xapi/v1/Trunks",                     # API path
    "singleton":   False,                                 # see 5.5
    "name_of":     lambda t: "<display string>",          # for log lines
    "identity_of": lambda t: "<matchable string>",        # for filters/imports
    "skip":        lambda t: <bool — exclude this item>,  # bridge trunks, etc.
}
```

Hardcoded entities: `trunks`, `users`.

**All other entities** are added dynamically by the operator via the
"+ Add panel" combobox or the **★ Load Golden Standard preset** button.
They land in `tcxState.extras[]` in the frontend, get sent in the
`extras: [{key, label, path, singleton, fields, ...}]` array, and are
registered into `ENTITIES` at runtime by the loop near `_generic_name_of`.

`_build_identity_of(key)` provides per-entity match logic. Special cases:
- `outboundrules`, `holidays` — `Name`
- `parameters`, `peers`       — `Number` then `Name`
- everything else             — try `Name` then `Number` then `Id`

### 5.3 Per-entity item filters

`_parse_item_filter(spec)` accepts comma-separated specs:

| Syntax          | Meaning                                                |
| --------------- | ------------------------------------------------------ |
| `200-299`       | Numeric range (when identity parses as int)            |
| `Local*`        | Case-insensitive glob                                  |
| `NTES`          | Case-insensitive exact match                           |
| `200-299, NTES*`| Any combination (OR'd)                                 |

Stored in `CONFIG["filters"]` keyed by entity key. Applied in **three
places**:
- Audit / Apply  — only matching items are touched
- Export        — only matching items go into the JSON
- Import        — only matching items in the JSON are PATCHed/created
  (recent addition — see 5.6)

### 5.4 Modes

`CONFIG["mode"]` drives the per-host script:

| Mode      | Behavior                                                      |
| --------- | ------------------------------------------------------------- |
| `probe`   | GET `/xapi/v1/` + each entity, print discovered fields/values |
| `audit`   | GET each item, compare to operator's targets, PASS/FAIL       |
| `apply`   | PATCH items whose fields differ from targets                  |
| `export`  | GET each entity in full, base64-emit between sentinel markers |
| `import`  | Apply a previously-exported JSON to the target PBX            |

`audit` exit codes: 0 (all pass) / 2 (one or more mismatches) / 1 (script
error). The UI uses the exit code to flip the per-host card red.

### 5.5 Singletons

Some 3CX endpoints return a **plain object** with no `"value"` array —
they're system-wide settings, one per PBX:

`VoicemailSettings`, `MailSettings`, `NotificationSettings`,
`AntiHackingSettings`, `CountryCodes`, `CodecsSettings`,
`RemoteArchivingSettings`, `OfficeHours`, `GeneralSettingsForPbx`,
`SecureSipSettings`, `CDRSettings`, `MusicOnHoldSettings`,
`ConferenceSettings`, `PhonesSettings`, `FaxServerSettings`.

**Export auto-detects** singletons (no `"value"` key in the response →
wrap the whole object as a single-item list, tag `"singleton": true`).
**Import** PATCH-es the singleton path directly with the source body —
no create, no delete, no identity matching. All four strategies
(additive / patch / merge / mirror) collapse to the same PATCH for
singletons.

### 5.6 Import strategies

Four mutually-exclusive options in the import modal:

| Strategy    | Source-only items | Matching items   | Target-only items |
| ----------- | ----------------- | ---------------- | ----------------- |
| `merge`     | **POST** (create) | **PATCH**        | leave             |
| `additive`  | **POST** (create) | leave            | leave             |
| `patch`     | skip              | **PATCH**        | leave             |
| `mirror`    | **POST** (create) | **PATCH**        | **DELETE**        |

`merge` is the default — it's what Golden Standard cloning needs (create
missing items on fresh PBXes AND override stale defaults on existing ones).
Mirror requires typing `MIRROR` in the modal to confirm.

### 5.7 Cross-reference remapping (the OutboundRules-TrunkId gotcha)

`OutboundRules[].Routes[].TrunkId` is the source PBX's auto-increment
Trunk Id — `33` on one box, `1` on another, missing on a fresh one.
A literal POST/PATCH fails with `WARNINGS.XAPI.NOT_FOUND`.

`_remap_trunk_refs(item, name_to_id)` rewrites each Route by looking up
its sibling `TrunkName` against the **target's** trunks (fetched once via
`_build_trunk_name_to_id_map()` at import start). If a trunk doesn't exist
on the target (e.g. NTES not yet provisioned), that individual route is
dropped with a `[warn] dropping routes for trunk(s) not on target:` line
so the rest of the rule still gets created (emergency rules don't fail
because one trunk is missing).

This is the only entity that needs cross-reference remapping today. If
similar issues surface (e.g. GroupIds, DidNumbers.TrunkId), extend
`_remap_trunk_refs` — `Routes` is the existing template.

### 5.8 Export protocol

After fetching every active entity, the script:

```python
payload_b64 = base64.b64encode(json.dumps(export_payload, indent=2).encode("utf-8")).decode("ascii")
print("###BSM_3CX_EXPORT_BEGIN###")
for i in range(0, len(payload_b64), 4000):
    print(payload_b64[i:i+4000])
print("###BSM_3CX_EXPORT_END###")
```

The frontend's `maybeOfferThreecxExport()` detects the sentinels, decodes
the base64, validates JSON, strips the markers from the visible log, and
offers a download chip inside the host card.

**Important**: the live-streaming log handler in `handleEvent` **suppresses
everything between the BEGIN/END markers** to avoid flooding the DOM with
hundreds of KB of base64. The full payload is still captured server-side
and arrives in `ev.output` at result time, where `maybeOfferThreecxExport`
processes it.

### 5.9 Golden Standard preset

`GOLDEN_STANDARD_PRESET` (in `src/features/threecx/catalogs.ts`) — the
entities that are **system-wide policy** and never change between fresh
phone systems:

- `outboundrules` — emergency / national / international dial plan
- `notificationsettings` — alert recipients & thresholds (singleton)
- `parameters` — narrowed by filter to just `NOTALLOWED_COUNTRYCODES,
  MS_LOCAL_CODEC_LIST, MS_EXTERNAL_CODEC_LIST` (defined in
  `GOLDEN_PARAMETERS_FILTER`)

`blocklist` was **deliberately removed** from this set and this section used
to wrongly list it as a fourth entry. Per-PBX blocklists drift fast — each
system accumulates its own attacker IPs — so cloning a baseline over them on
every migration threw away site-specific learning. Add it by hand via
Advanced if a particular run needs it. (Rationale preserved in the comment
above the legacy `GOLDEN_STANDARD_PRESET` in `templates/index.html`.)

Clicking the **★ Load Golden Standard preset** button **wipes all current
panels** (including Trunks and Users) and adds only these. Trunks and
Users are deliberately NOT in the preset — they're per-system.

---

## 6. Real-time log streaming

### 6.1 The pipeline

`deploy_host` accepts `log_callback`. Each output line from the SSH channel
is passed to it. Two code paths:

- **Normal path** — `for raw in stdout:` iteration. Paramiko's
  `ChannelFile` returns one item per `\n`. We handle both `bytes` (older
  paramiko) and `str` (newer wrappers).
- **su path** — chunk-based PTY reading. A `_line_buf` accumulator splits
  chunks on `\n` and emits whole lines.

`stdout.channel.set_combine_stderr(True)` is called on the normal path so
both streams interleave in arrival order.

### 6.2 Why `PYTHONUNBUFFERED=1`

The 3CX template runs Python via heredoc. Python defaults to **block-
buffering when stdout is a pipe** — so every `print()` accumulates until
4-8 KB is filled or the script exits. That defeats real-time streaming
completely. The template now sets `export PYTHONUNBUFFERED=1` before the
`python3 <<PYEOF` block so each print flushes immediately.

### 6.3 Queue-based fan-in

`app.py` no longer uses `as_completed`. Instead:

```python
event_q = queue.Queue()
def _run(t):
    def _cb(line): event_q.put({"type": "log", "host": t.label, "line": line})
    res = deployer.deploy_host(..., log_callback=_cb)
    event_q.put({"type": "result", **asdict(res)})

with ThreadPoolExecutor(...) as pool:
    for t in targets: pool.submit(_run, t)
    done = 0
    while done < len(targets):
        try: ev = event_q.get(timeout=1.0)
        except queue.Empty: continue
        if ev["type"] == "result": done += 1
        yield _event(ev)
```

`log` events from N hosts interleave naturally with `result` events as
they happen.

### 6.4 DOM perf — `scheduleLogFlush`

Naive `pre.textContent += line` causes one layout reflow per line. With
500+ lines arriving fast (e.g. a Parameters import) the UI freezes.

`scheduleLogFlush(pre, line)` buffers pending lines on the `<pre>` element
and flushes them in a **single textContent write per animation frame**
(~16ms). Cap is 2000 lines visible — older lines truncate with a banner.
The full untruncated output is still preserved server-side and overwrites
the `<pre>` on `result`.

---

## 7. Security model — what's protected vs. what leaks

### Protected (never logged, never stored)

- SSH passwords — passed to `paramiko.connect`, then held only in memory
- PBX (3CX webclient) passwords — same
- Root passwords for `su` escalation — same
- The `_exec_with_su` PTY filters the `Password:` prompt out of captured
  output before the result is returned

### Stripped on export

`_EXPORT_STRIP_KEYS` removes obvious identity / transient state:
`Id`, `IsRegistered`, `IsOnline`, `Created`, `Used`, `Revoked`,
`@odata.context`, `@odata.etag`, etc.

`_EXPORT_STRIP_KEYWORDS = ("Password", "Secret", "Pin")` — any key
containing one of these substrings is stripped recursively at every
nesting level. So `Trunk.AuthPassword`, `User.AuthPassword`,
`User.VMPIN`, `Provisioning.Password` are all dropped.

### Things to be careful about

- The Compound CSV `Password` column **is** exposed as `$Password` to
  custom scripts. This is required for the 3CX action's CSV-password
  mode. If hardening this is ever a task, filter it out in `app.py`'s
  custom_script branch specifically (the 3CX branch needs it).
- The new per-host `RootPassword` column is **explicitly popped** from
  `host_vars_by_label` in `app.py` before handing off — it never reaches
  the script env.

### Live-system safeguards

- OpenBSD: `sysupgrade` is skipped (reboots into installer)
- Debian: `NEEDRESTART_SUSPEND=1`, no dist-upgrade, no auto-reboot
- Custom scripts: operator-supplied — no built-in guards. The escalation
  model (`su` + root password) is the security boundary.

---

## 8. Major fixes / gotchas (history & rationale)

These are the non-obvious issues that took real debugging. Re-read this
section before changing anything in the named area.

### 8.1 HTTP 413 on import — two separate limits

Werkzeug 2.3+ added `MAX_FORM_MEMORY_SIZE` (default **500 KB**),
**independent** of `MAX_CONTENT_LENGTH`. Importing the Parameters entity
(~900 KB inside the `threecx_config` form field) tripped this even
though the overall request was well under the 128 MB MAX_CONTENT_LENGTH.

Fix (in `app.py`):

```python
_MAX_UPLOAD_BYTES = 128 * 1024 * 1024
app.config["MAX_CONTENT_LENGTH"]   = _MAX_UPLOAD_BYTES
app.config["MAX_FORM_MEMORY_SIZE"] = _MAX_UPLOAD_BYTES
try:
    app.request_class.max_form_memory_size = _MAX_UPLOAD_BYTES
except AttributeError:
    pass   # Werkzeug < 2.3
```

The 413 handler now reports **which** limit fired with sizes in MB.

### 8.2 "Argument list too long" — Linux MAX_ARG_STRLEN

The import payload was originally passed via `THREECX_CONFIG_B64` env var.
Linux caps any single env-var string at **128 KB** (`MAX_ARG_STRLEN`), so
when bash calls `execve("/usr/bin/python3", ...)` with a 1 MB env var, the
kernel returns `E2BIG`.

Fix: the bash template now writes the import payload to a temp file via
a heredoc (data is on stdin, not in argv/env):

```sh
_BSM_IMPORT_TMP=$(mktemp /tmp/.bsm_import_XXXXXX)
base64 -d > "$_BSM_IMPORT_TMP" << 'BSMIMPORTEOF'
<wrapped base64 payload>
BSMIMPORTEOF
export BSM_IMPORT_TMP="$_BSM_IMPORT_TMP"
```

Python reads from `os.environ["BSM_IMPORT_TMP"]`, unlinks the file, and
the env var itself is just a path (tiny). The shell cleanup unsets the
var and removes the file.

### 8.3 Python `SyntaxError` from `"""` in raw-string bash template

`build_threecx_script` uses `template = r"""...long bash..."""`. The
template contains a `python3 << 'PYEOF' ... PYEOF` heredoc. All the
Python code (including helpers like `_remap_trunk_refs`) lives inside
that outer Python raw string.

**Triple-quoted docstrings in those embedded helpers will prematurely
close the outer raw string** and cascade into bewildering "unterminated
string literal" errors with wrong line numbers (Python's tokenizer
reports the first unclosed string on the next line that started one).

**Rule: never use `"""..."""` docstrings inside the bash template.**
Use `#` comments instead, or `'''...'''` triple-single-quoted.

### 8.4 Curly quotes (`U+2019`) outside the template are fine

A separate red herring during the 8.3 incident: I assumed curly
apostrophes were causing the parse error. They're not. Python 3 reads
UTF-8 source by default; `'` (U+2019) inside a normal docstring or
comment is harmless. The actual bug was the `"""` in 8.3.

### 8.5 Export base64 flooding the UI

After adding live log streaming (§6), exports started spamming the host
card with ~250 lines of random-looking base64 characters — each line a
4000-char chunk. The DOM choked.

Fix: the `log` event handler detects `BSM_EXPORT_BEGIN` and sets a
per-card `dataset.suppressLog = "1"` flag. Every subsequent log line is
dropped until `BSM_EXPORT_END`. A single placeholder shows in the visible
log. The full output is still in `ev.output` at result time, where
`maybeOfferThreecxExport` processes it (post-result, the `<pre>` is
overwritten with `ev.output`, then `maybeOfferThreecxExport` strips the
marker block from it).

### 8.6 `'str' object has no attribute 'decode'`

Paramiko's `ChannelFile.__iter__` returns `bytes` on some installs and
`str` on others. Handle both:

```python
for raw in stdout:
    line = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
    line = line.rstrip("\r\n")
```

### 8.7 `debug=False` means no auto-reload

Flask runs with `debug=False` (we don't want the auto-reloader interfering
with the streaming endpoint). **Every code change requires a full process
restart.** The startup banner now prints both limits so you can verify the
restart took effect:

```
* Batch Device System Manager on http://127.0.0.1:8765
  Upload limit     : 128 MB  (MAX_CONTENT_LENGTH)
  Form field limit : 128 MB  (MAX_FORM_MEMORY_SIZE)
```

### 8.8 ✕ Remove button overlapping the per-panel filter

The ✕ Remove button is `position: absolute; top: 14px; right: 0;` and was
sliding under the filter input. Fixed via:

```css
.tcx-extra-panel > .tcx-section-head { padding-right: 90px; }
```

Reserves the right edge so the filter input stops short of the button.

---

## 9. Convenient implementation pointers

| Looking for…                        | File / function                               |
| ----------------------------------- | --------------------------------------------- |
| SSH connect + exec                  | `deployer.deploy_host`                        |
| Root escalation                     | `deployer._exec_with_su`                      |
| Per-host env var injection          | `deployer._build_host_vars_prelude`           |
| CSV parsers                         | `deployer.load_targets`, `load_credentials`,  |
|                                     | `load_keepass_csv`                            |
| 3CX script generation               | `deployer.build_threecx_script`               |
| 3CX entity registry                 | `ENTITIES` dict inside that template          |
| 3CX export                          | search `mode == "export"` in template         |
| 3CX import                          | search `mode == "import"` in template         |
| Strategy logic                      | `strategy in ("additive", "merge", "mirror")` |
| Trunk-id remapping                  | `_remap_trunk_refs`                           |
| Singleton detection                 | `if "value" in resp` in export loop           |
| Streaming endpoint                  | `app.deploy()` → `generate()`                 |
| 413 diagnostics                     | `app.request_entity_too_large`                |
| Frontend tab state                  | `tcxState` object near `const tcxState =`     |
| Per-entity catalogs                 | `TCX_EXTRA_CATALOGS`                          |
| Endpoint registry                   | `TCX_ENDPOINTS`                               |
| Golden Standard preset              | `GOLDEN_STANDARD_PRESET`, `GOLDEN_PARAMETERS_FILTER` |
| Real-time log batcher               | `scheduleLogFlush` in `index.html`            |
| Export download chip                | `maybeOfferThreecxExport`                     |
| Import modal & strategy             | `#tcx-import-modal`, `askThreecxImportStrategy` |

---

## 10. Conventions / style

- **No bundler.** `templates/index.html` is one file with inline `<style>`
  and `<script>`. Don't introduce a build step unless the file becomes
  truly unmanageable.
- **Vanilla JS only.** No React, no jQuery, no frameworks.
- **No external HTTP clients in scripts.** The 3CX template uses
  `urllib` (stdlib) because curl/wget availability varies across the
  fleet.
- **Test mode = 1 worker.** `mode == "test"` forces sequential execution
  so the operator sees output in order.
- **Always `bash -s` for built-in scripts.** Custom scripts get their
  interpreter from their shebang.
- **Never `--no-verify` or `--no-edit` on git.** Hooks exist for a
  reason. Investigate failures, don't skip them.

---

## 11. Known limitations / future work

- **CSV `Password` column leaks as `$Password`.** Required by 3CX, but
  custom scripts can read it. If this needs fixing, filter it out for
  the `custom_script` action specifically.
- **No retry logic for transient network errors.** A single TCP hiccup
  fails that host. The Fallback button is the workaround.
- **3CX import doesn't remap GroupIds.** OutboundRule.GroupIds /
  GroupNames will reference the source PBX's group IDs. If groups also
  vary per-PBX, extend `_remap_trunk_refs` (the pattern is identical).
- **No transaction / rollback on import.** A partial import leaves the
  target in a mixed state. Use Audit first to see what would change.
- **Singleton field catalogs were guesses; most are now empty.** Probed
  2026-07-17 against a live V20 PBX via `GET /xapi/v1/$metadata` (the OData
  schema — authoritative, unlike sampling live data). Every guessed singleton
  field turned out not to exist, so `voicemailsettings`, `mailsettings`,
  `notificationsettings`, `remotearchivingsettings`, `generalsettingsforpbx`
  and `secureSipsettings` are now `[]` — operators add fields by hand, same as
  `parameters` / `officehours` already did. `antihackingsettings` is the one
  populated singleton, verified field-by-field. Re-derive any of them with
  `backend/scripts/probe-xapi-metadata.sh`; never hand-write a field list.
- **Enum options live in `TCX_ENUMS`, not inline.** They were previously
  written out per entity and had drifted into five subtly different wrong
  copies of `TranscriptionMode`. Members are transcribed from `$metadata`.
  Collection-entity *field names* were always correct — only the singletons
  and the enums were fabricated.
- **The Golden Standard preset is hardcoded.** If teams want different
  presets, generalize `GOLDEN_STANDARD_PRESET` into a dropdown.

---

## 12. Quick checklist when picking this up cold

1. Read `README.md` for the user perspective. Five minutes.
2. Run the app: `run.bat` (Windows) / `./run.sh` (Linux). Open
   http://127.0.0.1:8765.
3. Use the Test Host mode against a non-production PBX to see the flow
   end-to-end without touching the fleet.
4. To trace a request: form submit → `app.deploy()` → `generate()` →
   `deploy_host` → SSH. Single file each step.
5. To trace a 3CX entity: find it in `TCX_ENDPOINTS` (frontend) and in
   `ENTITIES` (backend, inside the bash template). Identity logic in
   `_build_identity_of`.
6. To add a new singleton: register in `TCX_ENDPOINTS` with
   `singleton: true`, optionally add a catalog in `TCX_EXTRA_CATALOGS`.
   The backend auto-detects via "no `value` key in response".
7. **Restart Flask after every code change** — `debug=False`.
