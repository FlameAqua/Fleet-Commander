# Security

Fleet Commander holds SSH credentials for production systems and runs commands
on them as root. This document describes what it defends against, what it
deliberately doesn't, and the rules for changing security-relevant code.

## Reporting a vulnerability

Report privately to the repository owner rather than opening a public issue.
Include what you did, what happened, and what you expected.

## Threat model

**The trust boundary is the operator's machine.** Both servers bind
`127.0.0.1` only, and the app is single-user. Anyone with an interactive
session on that machine already has the operator's files and can run their SSH
client directly — the app does not attempt to defend against them.

What it *does* defend against:

| Threat | Defence |
|---|---|
| Another local app POSTing to the API from a browser | Origin/Referer CSRF guard on every mutating request (`_csrf_guard`) |
| A malicious page loaded in the app window | Navigation lockdown: only the app origin loads; external links go to the OS browser; `<webview>` refused |
| Injected markup executing | `contextIsolation`, no `nodeIntegration`, and a CSP on the packaged app (`script-src 'self'`) |
| A compromised renderer reaching the OS | A fixed, named preload API — no generic IPC passthrough. `openPath` refuses non-directories; `openExternal` refuses non-http(s) |
| Path traversal via API filenames | Basenamed and allowlist-validated (`_sanitize_script_name`, `_sanitize_category`, `_sanitize_for_save`) |
| Command injection into remote shells | Host variables POSIX-quoted; escalated scripts base64-encoded before hitting `su -c` |
| MITM on first SSH connect | Trust-on-first-use with a persisted `known_hosts`, written atomically so concurrent runs can't corrupt it |
| Credentials on disk | Passwords are in-memory only. CSVs can be stored encrypted (PBKDF2-HMAC-SHA256, 480k iterations → Fernet), and the plaintext original is deleted after an encrypt-on-import |

## Known residual risks

These are accepted trade-offs. Don't "fix" them without understanding why they
are the way they are.

- **The auto-update token ships inside the app.** For a private repo, the
  updater needs a credential to read releases, so CI writes
  `electron/update-token.txt` into the packaged app. Anyone with an installed
  copy can extract it. Keep it a **fine-grained, read-only** token scoped to
  that one repository, and rotate it when someone leaves.
  *If the repository is public, delete the token mechanism entirely* — public
  releases need no authentication.
- **`/api/delete-csv-file` can delete any `.csv` on the machine.** It refuses
  directories, non-`.csv` files and `.enc` files, and only the renderer calls
  it (after an encrypt-on-import). Given the local-only trust boundary this is
  contained, but don't widen it.
- **`$Password` is exposed to custom scripts.** The SSH credential is
  deliberately available as a shell variable; the 3CX action needs it. Anything
  in `host_vars` is visible to `env` and to every child process of the script.
  The per-host *root* password column is popped before this point and never
  reaches a script.
- **SVG uploads are allowed for ship artwork.** They're rendered via `<img>`,
  where scripts don't execute. Don't start inlining them into the DOM.
- **`npm audit` reports advisories in build tooling** (electron-builder's
  dependency tree, `concurrently`). None are in shipped renderer code. Worth
  clearing periodically; not a runtime exposure.

## Never commit

The repository must stay free of anything site-specific:

- **Real hostnames, IPs or SSH host keys.** `backend/known_hosts` ships empty on
  purpose — it seeds a per-user copy on first run and fills up locally via
  trust-on-first-use. A populated copy is an inventory of customer systems.
- **Credentials of any kind**, including in test fixtures. Use obviously-fake
  values (`sandbox.example`, `hunter2`).
- **Site defaults.** `TEST_HOST`, `DEFAULT_HEP_SERVER` and `DEFAULT_INTERFACE`
  read from the environment:

  ```
  BSM_TEST_HOST=ssh://root@lab-pbx.internal
  BSM_HEP_SERVER=10.0.0.10:9060
  BSM_CAPTURE_IFACE=ens18
  ```

  The sandbox target is also settable in-app under Settings → Sandbox target.

`electron/update-token.txt` is gitignored and written only by CI.

## Rules for security-relevant changes

1. **The preload bridge is an allowlist.** Add a named function with a specific
   purpose and validate its input in the `ipcMain` handler. Never expose a
   generic `send(channel, data)` — that hands the page the whole IPC surface.
2. **Any endpoint taking a path** must basename it and validate against an
   allowlist pattern, then resolve it under a known directory. Don't trust an
   extension check alone.
3. **Anything reaching a remote shell** must be `shlex.quote`d or base64-encoded.
   The existing paths do this; match them.
4. **Don't log credentials.** Not in Flask logs, not in NDJSON events, not in
   exported result logs.
5. **Keep both servers on loopback.** Binding `0.0.0.0` would put an
   unauthenticated fleet-command API on the network.
