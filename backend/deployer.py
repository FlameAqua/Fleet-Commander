"""
deployer.py — core logic for the heplify fleet deployer.

Responsibilities:
  * Parse SSH-URL and credential CSVs robustly.
  * Resolve heplify release versions from GitHub.
  * Build the remote provisioning script (with a built-in version fallback).
  * Execute the script over SSH against a single host and return a structured
    result.

Security notes:
  * Passwords are held in memory only and are NEVER written to disk or included
    in any log line / event emitted to the UI.
  * Host-key handling is configurable: trust-on-first-use (TOFU, persisted to a
    local known_hosts file) by default, or strict verification.
  * The version string injected into the remote script is validated against a
    strict allow-list pattern to prevent command injection.
"""

from __future__ import annotations

import csv
import io
import os
import re
import shlex
import socket
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse

import paramiko
import requests
import bsm_paths

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

GITHUB_API_RELEASES = "https://api.github.com/repos/sipcapture/heplify/releases"
KNOWN_GOOD_FALLBACK = "2.0.21"          # last-resort version baked into remote script
TEST_HOST = "ssh://root@lab-pbx.example"  # the single safe test target

DEFAULT_INTERFACE = "ens18"
DEFAULT_HEP_SERVER = "10.0.0.10:9060"
DEFAULT_CAPTURE_MODE = "SIPRTCP"
DEFAULT_DISCARD_METHODS = "OPTIONS,NOTIFY,REGISTER"

# Validation patterns
_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$")
_IFACE_RE = re.compile(r"^[A-Za-z0-9._\-]{1,32}$")
_HEPSERVER_RE = re.compile(r"^[A-Za-z0-9._\-]+:\d{1,5}$")
_MODE_RE = re.compile(r"^[A-Za-z]{1,16}$")
_METHODS_RE = re.compile(r"^[A-Za-z0-9,]{0,128}$")

# Local file used for trust-on-first-use host key persistence.
KNOWN_HOSTS_PATH = bsm_paths.seed_file_once("known_hosts")


# --------------------------------------------------------------------------- #
# Data structures
# --------------------------------------------------------------------------- #

@dataclass
class Target:
    raw: str
    user: str
    host: str
    port: int

    @property
    def label(self) -> str:
        return f"ssh://{self.user}@{self.host}:{self.port}"


@dataclass
class HostResult:
    target: str
    ok: bool
    stage: str            # connect | auth | exec | done | error
    message: str
    exit_status: Optional[int] = None
    output: str = ""      # combined stdout/stderr from the remote script (never contains creds)
    duration_s: float = 0.0


@dataclass
class DeployConfig:
    version: str = "latest"
    interface: str = DEFAULT_INTERFACE
    hep_server: str = DEFAULT_HEP_SERVER
    capture_mode: str = DEFAULT_CAPTURE_MODE
    discard_methods: str = DEFAULT_DISCARD_METHODS
    connect_timeout: int = 12
    exec_timeout: int = 240
    strict_host_keys: bool = False
    max_workers: int = 10
    resolved_version: str = field(default="", init=False)


# --------------------------------------------------------------------------- #
# Parsing helpers
# --------------------------------------------------------------------------- #

def parse_ssh_url(value: str) -> Target:
    """Parse an ssh URL or a bare host into a Target. Defaults: user=root, port=22."""
    value = (value or "").strip()
    if not value:
        raise ValueError("empty target")

    if "://" not in value:
        # Allow bare 'user@host:port' or 'host'
        candidate = "ssh://" + value
    else:
        candidate = value

    parsed = urlparse(candidate)
    if parsed.scheme != "ssh":
        raise ValueError(f"unsupported scheme '{parsed.scheme}' (expected ssh://)")

    host = parsed.hostname
    if not host:
        raise ValueError(f"could not parse host from '{value}'")

    user = parsed.username or "root"
    port = parsed.port or 22
    if not (0 < port < 65536):
        raise ValueError(f"invalid port {port}")

    return Target(raw=value, user=user, host=host, port=port)


def load_targets(file_bytes: bytes) -> Tuple[List[Target], List[str]]:
    """
    Parse a CSV of SSH URLs. Accepts:
      * a single column of urls (with or without a header), OR
      * a column named one of: url / ssh / address / host / target
    Returns (targets, errors).
    """
    targets: List[Target] = []
    errors: List[str] = []
    text = _decode(file_bytes)

    rows = list(csv.reader(io.StringIO(text)))
    rows = [r for r in rows if any(c.strip() for c in r)]  # drop blank lines
    if not rows:
        return targets, ["SSH URL file is empty"]

    header = [c.strip().lower() for c in rows[0]]
    url_keys = {"url", "ssh", "address", "host", "target", "ssh_url"}
    col_idx = next((i for i, h in enumerate(header) if h in url_keys), None)

    if col_idx is not None:
        data_rows = rows[1:]
    else:
        # No recognizable header — treat the first cell of every row as the URL.
        col_idx = 0
        data_rows = rows
        # If the very first row looks like a header word but unmatched, skip it.
        if header and header[0] in {"urls", "ssh_urls", "hosts"}:
            data_rows = rows[1:]

    seen = set()
    for n, row in enumerate(data_rows, start=1):
        if col_idx >= len(row):
            continue
        cell = row[col_idx].strip()
        if not cell:
            continue
        try:
            t = parse_ssh_url(cell)
        except ValueError as e:
            errors.append(f"row {n}: {e}")
            continue
        if t.label in seen:
            continue
        seen.add(t.label)
        targets.append(t)

    if not targets and not errors:
        errors.append("No valid SSH URLs found")
    return targets, errors


def load_keepass_csv(file_bytes: bytes) -> Tuple[List[Target], Dict[str, str], List[str]]:
    """
    Parse a KeePass-exported CSV containing both SSH URL and password.

    Expected columns (header row, case-insensitive, order-independent):
      Account, Login Name, Password, Web Site, Comments

    Only rows whose 'Web Site' value starts with 'ssh://' are treated as
    deploy targets. Web entries (https://, etc.) are silently ignored.

    Returns (targets, creds_by_label, errors).
    """
    targets: List[Target] = []
    creds: Dict[str, str] = {}
    errors: List[str] = []
    text = _decode(file_bytes)

    reader = csv.reader(io.StringIO(text))
    rows = [r for r in reader if any(c.strip() for c in r)]
    if not rows:
        return targets, creds, ["KeePass CSV is empty"]

    header = [c.strip().lower() for c in rows[0]]
    idx_of: Dict[str, int] = {}
    for i, h in enumerate(header):
        if h and h not in idx_of:
            idx_of[h] = i

    def col(*names: str) -> Optional[int]:
        for n in names:
            if n in idx_of:
                return idx_of[n]
        return None

    url_idx = col("web site", "website", "url", "ssh", "ssh_url")
    pw_idx  = col("password", "pass", "pwd")
    acct_idx = col("account", "name", "title")

    if url_idx is None or pw_idx is None:
        return targets, creds, [
            "KeePass CSV header must include 'Web Site' and 'Password' columns "
            f"(got: {', '.join(rows[0])})"
        ]

    seen_labels: set = set()
    skipped_non_ssh = 0
    for n, row in enumerate(rows[1:], start=2):
        if url_idx >= len(row) or pw_idx >= len(row):
            continue
        web = row[url_idx].strip()
        if not web:
            continue
        if not web.lower().startswith("ssh://"):
            skipped_non_ssh += 1
            continue
        try:
            t = parse_ssh_url(web)
        except ValueError as e:
            acct = row[acct_idx].strip() if acct_idx is not None and acct_idx < len(row) else f"row {n}"
            errors.append(f"{acct}: {e}")
            continue
        if t.label in seen_labels:
            continue
        seen_labels.add(t.label)
        targets.append(t)
        creds[t.label] = row[pw_idx]

    if not targets:
        msg = "No ssh:// entries found in KeePass CSV"
        if skipped_non_ssh:
            msg += f" ({skipped_non_ssh} non-ssh rows ignored)"
        errors.append(msg)
    return targets, creds, errors


def load_credentials(file_bytes: bytes, targets: List[Target]) -> Tuple[Dict[str, str], List[str]]:
    """
    Parse a CSV of passwords and produce a mapping {target.label: password}.

    Supported formats (auto-detected):
      1. Two columns with headers, one of {host,url,address,target} + 'password':
         mapped by hostname (most robust).
      2. Two columns without headers: treated as host,password pairs.
      3. Single column: positional match to targets by row order
         (count must equal number of targets), OR a single value applied to all.

    Passwords are returned in-memory only.
    """
    errors: List[str] = []
    mapping: Dict[str, str] = {}
    text = _decode(file_bytes)
    rows = list(csv.reader(io.StringIO(text)))
    rows = [r for r in rows if any(c.strip() for c in r)]
    if not rows:
        return mapping, ["Password file is empty"]

    header = [c.strip().lower() for c in rows[0]]
    host_keys = {"host", "url", "address", "target", "ssh", "ssh_url"}
    has_pw_header = "password" in header or "pass" in header or "pwd" in header

    # Build a quick lookup from hostname -> target.label for mapping by host.
    host_to_label: Dict[str, str] = {}
    for t in targets:
        host_to_label.setdefault(t.host.lower(), t.label)
        host_to_label.setdefault(t.label.lower(), t.label)

    ncols = max(len(r) for r in rows)

    # --- Format 1 & 2: keyed by host -------------------------------------- #
    if ncols >= 2 and (has_pw_header or _looks_like_host(rows[0][0])):
        if has_pw_header:
            host_idx = next((i for i, h in enumerate(header) if h in host_keys), 0)
            pw_idx = next(i for i, h in enumerate(header) if h in {"password", "pass", "pwd"})
            data_rows = rows[1:]
        else:
            host_idx, pw_idx = 0, 1
            data_rows = rows

        for n, row in enumerate(data_rows, start=1):
            if max(host_idx, pw_idx) >= len(row):
                continue
            host_field = row[host_idx].strip()
            pw = row[pw_idx]
            if not host_field:
                continue
            # Normalize the host field (may be a full url or bare host).
            try:
                key_host = parse_ssh_url(host_field).host.lower()
            except ValueError:
                key_host = host_field.lower()
            label = host_to_label.get(key_host) or host_to_label.get(host_field.lower())
            if label:
                mapping[label] = pw
            else:
                errors.append(f"credential row {n}: host '{host_field}' not in target list (ignored)")
        return mapping, errors

    # --- Format 3: single column ----------------------------------------- #
    values = [r[0] for r in rows if r and r[0] != ""]
    # If a header-like first cell exists, drop it.
    if values and values[0].strip().lower() in {"password", "pass", "pwd"}:
        values = values[1:]

    if len(values) == 1:
        # One password applied to every target.
        for t in targets:
            mapping[t.label] = values[0]
        return mapping, errors

    if len(values) == len(targets):
        for t, pw in zip(targets, values):
            mapping[t.label] = pw
        return mapping, errors

    errors.append(
        f"Could not map credentials: got {len(values)} passwords for {len(targets)} hosts. "
        "Use a 2-column CSV (host,password) for unambiguous mapping, a single password "
        "for all hosts, or exactly one password per host in URL order."
    )
    return mapping, errors


def _looks_like_host(cell: str) -> bool:
    c = (cell or "").strip().lower()
    return "@" in c or "://" in c or "." in c


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


# --------------------------------------------------------------------------- #
# GitHub release resolution
# --------------------------------------------------------------------------- #

def fetch_releases(timeout: int = 10) -> List[Dict[str, str]]:
    """Return a list of {tag, name, prerelease, published} for heplify releases."""
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "heplify-deployer"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    resp = requests.get(GITHUB_API_RELEASES, headers=headers, timeout=timeout,
                        params={"per_page": 30})
    resp.raise_for_status()
    out = []
    for rel in resp.json():
        tag = rel.get("tag_name")
        if not tag:
            continue
        out.append({
            "tag": tag,
            "name": rel.get("name") or tag,
            "prerelease": bool(rel.get("prerelease")),
            "published": rel.get("published_at", ""),
        })
    return out


def resolve_version(version: str, timeout: int = 10) -> str:
    """Resolve 'latest' to a concrete tag; validate any explicit tag."""
    version = (version or "latest").strip()
    if version.lower() == "latest":
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "heplify-deployer"}
        token = os.environ.get("GITHUB_TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        resp = requests.get(GITHUB_API_RELEASES + "/latest", headers=headers, timeout=timeout)
        resp.raise_for_status()
        tag = resp.json().get("tag_name")
        if not tag:
            raise RuntimeError("GitHub did not return a latest tag")
        version = tag
    if not _VERSION_RE.match(version):
        raise ValueError(f"invalid version tag '{version}'")
    return version


# --------------------------------------------------------------------------- #
# Remote script construction
# --------------------------------------------------------------------------- #

_START_SCRIPT_TEMPLATE = """#!/bin/bash
exec /usr/local/bin/heplify -i __IFACE__ -hs __HEPSERVER__ -m __MODE__ -dd -dim __METHODS__ -hn "$(hostname)"
"""

_SERVICE_TEMPLATE = """[Unit]
Description=heplify SIP capture agent
After=network.target

[Service]
ExecStart=/usr/local/bin/heplify-start.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
"""


def build_remote_script(cfg: DeployConfig) -> str:
    """
    Build the bash script that runs on each remote host.

    The script is idempotent, fails fast on real errors, downloads the requested
    release with retries, and falls back to the known-good version if the
    requested download fails. All values interpolated here are validated by the
    caller / config, so the resulting script is safe to run under `bash -s`.
    """
    version = cfg.resolved_version or KNOWN_GOOD_FALLBACK
    if not _VERSION_RE.match(version):
        raise ValueError("refusing to build script with invalid version")
    if not _IFACE_RE.match(cfg.interface):
        raise ValueError("invalid interface name")
    if not _HEPSERVER_RE.match(cfg.hep_server):
        raise ValueError("invalid HEP server (expected host:port)")
    if not _MODE_RE.match(cfg.capture_mode):
        raise ValueError("invalid capture mode")
    if not _METHODS_RE.match(cfg.discard_methods):
        raise ValueError("invalid discard methods")

    start_script = (
        _START_SCRIPT_TEMPLATE
        .replace("__IFACE__", cfg.interface)
        .replace("__HEPSERVER__", cfg.hep_server)
        .replace("__MODE__", cfg.capture_mode)
        .replace("__METHODS__", cfg.discard_methods)
    )

    # shlex.quote everything that becomes a shell variable value.
    q_version = shlex.quote(version)
    q_fallback = shlex.quote(KNOWN_GOOD_FALLBACK)
    q_start = shlex.quote(start_script)
    q_service = shlex.quote(_SERVICE_TEMPLATE)
    q_iface = shlex.quote(cfg.interface)

    script = f"""set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

log()  {{ echo "[*] $*"; }}
warn() {{ echo "[!] $*" >&2; }}

if [ "$(id -u)" -ne 0 ]; then
  warn "must run as root (current uid $(id -u))"; exit 90
fi

VERSION={q_version}
FALLBACK={q_fallback}
ARCH=heplify_linux_amd64
BASE=https://github.com/sipcapture/heplify/releases/download
TMP=/usr/local/bin/heplify.new

if ! command -v wget >/dev/null 2>&1; then
  warn "wget not found"; exit 91
fi

# Warn (do not fail) if the configured capture interface is missing on this host.
if ! ip link show {q_iface} >/dev/null 2>&1; then
  warn "capture interface {q_iface} not present on this host; service may not capture"
fi

download() {{
  local ver="$1"
  log "downloading heplify ${{ver}} ..."
  wget -q --tries=3 --timeout=30 "${{BASE}}/${{ver}}/${{ARCH}}" -O "$TMP"
}}

rm -f "$TMP"
if ! download "$VERSION"; then
  warn "download of ${{VERSION}} failed; falling back to ${{FALLBACK}}"
  rm -f "$TMP"
  download "$FALLBACK"
fi

if [ ! -s "$TMP" ]; then
  warn "downloaded binary is empty"; rm -f "$TMP"; exit 92
fi

chmod +x "$TMP"
# Sanity check the binary actually runs.
if ! "$TMP" -version >/dev/null 2>&1 && ! "$TMP" --version >/dev/null 2>&1; then
  warn "downloaded binary did not execute cleanly; aborting (existing install left intact)"
  rm -f "$TMP"; exit 93
fi
mv -f "$TMP" /usr/local/bin/heplify
chmod +x /usr/local/bin/heplify
log "installed: $(/usr/local/bin/heplify -version 2>/dev/null || /usr/local/bin/heplify --version 2>/dev/null || echo unknown)"

log "writing /usr/local/bin/heplify-start.sh"
printf '%s' {q_start} > /usr/local/bin/heplify-start.sh
chmod +x /usr/local/bin/heplify-start.sh

log "writing /etc/systemd/system/heplify.service"
printf '%s' {q_service} > /etc/systemd/system/heplify.service

log "reloading systemd"
systemctl daemon-reload
log "enabling heplify"
systemctl enable heplify >/dev/null 2>&1 || true
log "restarting heplify"
systemctl restart heplify

sleep 2
if systemctl is-active --quiet heplify; then
  log "heplify is ACTIVE"
  systemctl status heplify --no-pager -l | head -n 15 || true
  echo "DEPLOY_RESULT=success"
  exit 0
else
  warn "heplify failed to start"
  systemctl status heplify --no-pager -l | head -n 30 || true
  journalctl -u heplify --no-pager -n 30 || true
  echo "DEPLOY_RESULT=failed"
  exit 94
fi
"""
    return script


# --------------------------------------------------------------------------- #
# apt update + upgrade — patch the fleet without reboots / service restarts
# --------------------------------------------------------------------------- #

def build_apt_upgrade_script() -> str:
    """
    Build a cross-platform package-update script suitable for **live** systems.

    Detects Debian/Ubuntu vs OpenBSD at runtime and dispatches:

      * Debian / Ubuntu — apt-get update + apt-get upgrade
          - no interactive prompts (DEBIAN_FRONTEND=noninteractive, dpkg conf-old)
          - no service restarts (NEEDRESTART_SUSPEND=1 + NEEDRESTART_MODE=l)
          - no reboot, even if flagged as required (only reported)
          - plain upgrade (not dist-upgrade) so packages with new deps are held back

      * OpenBSD — holistic update without reboot:
          - pkg_add -Iuv     : update installed packages (non-interactive)
          - syspatch         : install pending base-system security errata
                               (never reboots; kernel patches take effect on
                               next operator-initiated reboot, userland on
                               next service restart — both deferred)
          - fw_update -a     : refresh non-free firmware blobs (safe; no reboot)
          - sysupgrade       : deliberately SKIPPED (it would reboot into the
                               installer to move to the next OS release)
          - rcctl / running services are never restarted

    Same DEPLOY_RESULT=success marker as the heplify script so the existing
    per-host result handling Just Works.

    Written for POSIX /bin/sh — caller should invoke with `sh -s` (works on
    Debian's dash and OpenBSD's pdksh-as-sh).
    """
    return r"""set -e

log()  { printf '[*] %s\n' "$*"; }
warn() { printf '[!] %s\n' "$*" >&2; }

if [ "$(id -u)" -ne 0 ]; then
  warn "must run as root (current uid $(id -u))"; exit 90
fi

# ---- Detect OS family ------------------------------------------------------
OS_KIND=unknown
UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case ":${ID:-}:${ID_LIKE:-}:" in
    *:debian:*|*:ubuntu:*|*debian*|*ubuntu*) OS_KIND=debian ;;
  esac
fi
if [ "$OS_KIND" = unknown ] && [ "$UNAME_S" = OpenBSD ]; then
  OS_KIND=openbsd
fi
log "OS family: $OS_KIND ($(uname -srm 2>/dev/null || echo '?'))"
log "uptime  : $(uptime 2>/dev/null | sed 's/^[[:space:]]*//' || echo n/a)"

# ---- Debian / Ubuntu -------------------------------------------------------
if [ "$OS_KIND" = debian ]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    warn "apt-get not found despite Debian-family detection"; exit 91
  fi
  export DEBIAN_FRONTEND=noninteractive
  export NEEDRESTART_SUSPEND=1
  export NEEDRESTART_MODE=l
  export APT_LISTCHANGES_FRONTEND=none

  # Positional args (POSIX sh has no real arrays).
  set -- \
    -y \
    -o Dpkg::Options::=--force-confdef \
    -o Dpkg::Options::=--force-confold \
    -o DPkg::Lock::Timeout=180 \
    -o APT::Get::Show-Upgraded=true

  log "apt-get update"
  apt-get "$@" update

  log "packages available to upgrade:"
  apt list --upgradable 2>/dev/null | tail -n +2 || true

  log "apt-get upgrade (no service restarts, no reboot)"
  apt-get "$@" upgrade

  log "apt-get autoclean"
  apt-get "$@" autoclean || true

  held="$(apt-mark showhold 2>/dev/null || true)"
  if [ -n "$held" ]; then
    log "held packages (not upgraded):"
    echo "$held"
  fi

  if [ -f /var/run/reboot-required ]; then
    warn "REBOOT REQUIRED (kernel/libc/etc was updated). NOT rebooting - live system policy."
    if [ -f /var/run/reboot-required.pkgs ]; then
      echo "packages requesting reboot:"
      cat /var/run/reboot-required.pkgs
    fi
  fi

  if command -v needrestart >/dev/null 2>&1; then
    log "needrestart (list-only, nothing restarted):"
    needrestart -r l -b 2>&1 | head -n 60 || true
  fi

# ---- OpenBSD ---------------------------------------------------------------
elif [ "$OS_KIND" = openbsd ]; then
  if ! command -v pkg_add >/dev/null 2>&1; then
    warn "pkg_add not found on OpenBSD host"; exit 91
  fi

  log "pkg_add -u (installed-package updates; non-interactive)"
  # -I  : interactive prompts disabled
  # -u  : update installed packages
  # -v  : verbose, so the per-host log shows what changed
  pkg_add -Iuv 2>&1 || {
    rc=$?
    warn "pkg_add exited $rc"; exit "$rc"
  }

  # ---- Base-system security errata (syspatch) ------------------------------
  # syspatch installs binary patches into the running system. It does NOT
  # reboot and does NOT restart services. Kernel patches take effect on the
  # next operator-initiated reboot; userland patches take effect on next
  # process / service restart. So it's safe on live systems — we just won't
  # see the full benefit of kernel patches until the next planned reboot.
  if command -v syspatch >/dev/null 2>&1; then
    pre_pending="$(syspatch -c 2>/dev/null | wc -l | tr -d ' ')"
    if [ -z "$pre_pending" ] || [ "$pre_pending" = "0" ]; then
      log "syspatch: no pending errata"
    else
      log "syspatch: $pre_pending pending errata — applying (no reboot, no service restart)"
      # syspatch with no args installs every missing patch. It prints what it
      # did to stdout; capture for the per-host log. Non-fatal on failure so
      # one bad errata doesn't mask a successful pkg_add.
      syspatch 2>&1 || warn "syspatch exited non-zero — review log above"
      # Re-check: anything still pending means a partial apply we should surface.
      post_pending="$(syspatch -c 2>/dev/null | wc -l | tr -d ' ')"
      if [ -n "$post_pending" ] && [ "$post_pending" != "0" ]; then
        warn "syspatch: $post_pending errata still pending after apply"
      fi
      warn "kernel/library patches require a reboot or service restart to take effect — NOT performing either (live system policy)"
    fi
  else
    log "syspatch not available on this host — skipping base-system errata"
  fi

  # ---- Firmware blobs (fw_update) ------------------------------------------
  # Safe: installs/updates non-free firmware files. Never reboots. New firmware
  # is loaded on next driver attach (typically next reboot) — running drivers
  # keep their currently-loaded blob until then.
  if command -v fw_update >/dev/null 2>&1; then
    log "fw_update -a (refresh firmware blobs; effective on next reboot)"
    fw_update -a 2>&1 || warn "fw_update exited non-zero — review log above"
  fi

  # ---- sysupgrade: explicitly NOT invoked ----------------------------------
  # sysupgrade downloads the next OS release and reboots into the installer.
  # That's a maintenance-window operation, not a fleet patch — never run it
  # from this tool.
  log "skipping sysupgrade (would reboot into installer — maintenance-window only)"

else
  warn "unsupported OS family '$OS_KIND' (uname -s='$UNAME_S') — refusing to run"
  exit 92
fi

# ---- Heplify health (cross-platform; non-fatal) ----------------------------
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files heplify.service >/dev/null 2>&1; then
  if systemctl is-active --quiet heplify; then
    log "heplify is still ACTIVE post-upgrade (systemd)"
  else
    warn "heplify is NOT active post-upgrade — check 'systemctl status heplify'"
  fi
elif command -v rcctl >/dev/null 2>&1; then
  if rcctl check heplify >/dev/null 2>&1; then
    log "heplify is still running post-upgrade (rcctl)"
  else
    log "heplify not running (rcctl) — not necessarily an error if not installed here"
  fi
fi

echo "DEPLOY_RESULT=success"
exit 0
"""


# --------------------------------------------------------------------------- #
# 3CX configuration manager
# --------------------------------------------------------------------------- #

def build_threecx_script(config: dict) -> str:
    """
    Generate a bash+Python script that authenticates to the local 3CX
    webclient API on a host and enforces a set of field=value targets on
    selected entity collections (Trunks, Users).

    config schema::

        {
          "username":         "0000",            # PBX login user
          "password_source":  "inline" | "csv",  # how to obtain the PBX pw
          "password_inline":  "secret",          # used when source == "inline"
          "password_column":  "Password",        # env-var name to read when
                                                 # source == "csv"; the operator
                                                 # is expected to have arranged
                                                 # for this column to be
                                                 # exposed via the existing
                                                 # host-vars mechanism
          "trunks": [ {"field": "Gateway.DeliverAudio", "value": true}, ... ],
          "users":  [ {"field": "PbxDeliversAudio",     "value": true}, ... ],
          "mode":         "apply" | "probe",
          "probe_first":  true | false,
        }

    Why all HTTP is done in Python instead of curl/wget: 3CX appliances are
    inconsistent about which HTTP client is installed (we already learned
    this — `curl` was missing on the operator's production boxes), but
    every host that runs 3CX has python3 available because 3CX itself
    depends on it. Doing GET/POST/PATCH via urllib means one less binary
    dependency and clean handling of JSON quoting / encoding / TLS-skip.

    The generated script:
      1. Resolves the PBX password from either an inline literal or an env
         var (defaulting to ``$Password``, set per-host by the host-vars
         feature when the operator picks "from CSV column").
      2. Logs in to ``/webclient/api/Login/GetAccessToken`` and captures
         the bearer token.
      3. For each entity collection ("trunks" / "users") iterates items,
         applies the operator's field=value targets (PATCH only fields
         that differ from the requested value), and prints a per-item
         line so the per-host log shows exactly what changed.
      4. In probe mode, dumps the keys on a sample item so the operator
         can verify field names against this 3CX version's API.
    """
    import base64
    import json as json_mod

    # The import payload can be several MB (Parameters alone is ~1 MB as JSON,
    # ~1.4 MB as base64). Linux's MAX_ARG_STRLEN caps any single env-var string
    # at 128 KB — so we cannot put it inside THREECX_CONFIG_B64 or bash will
    # crash with "Argument list too long" when it exec()'s python3.
    # Strip import_payload out of the env-var config and deliver it separately
    # via a bash heredoc that writes a temp file (stdin-delivered, not argv).
    config_for_env = dict(config)
    import_payload_raw = config_for_env.pop("import_payload", None)

    # Encode the config WITHOUT the import payload — must stay under 128 KB.
    config_b64 = base64.b64encode(
        json_mod.dumps(config_for_env).encode("utf-8")
    ).decode("ascii")

    # If there's an import payload, encode it for a heredoc block in the script.
    if import_payload_raw:
        import_payload_b64 = base64.b64encode(
            json_mod.dumps(import_payload_raw).encode("utf-8")
        ).decode("ascii")
        # Heredoc content must have newlines every 76 chars so base64 -d is happy
        # (some implementations reject bare un-newlined base64).
        wrapped = "\n".join(
            import_payload_b64[i:i+76]
            for i in range(0, len(import_payload_b64), 76)
        )
        import_tmp_setup = (
            "# Import payload is too large for an env var (Linux MAX_ARG_STRLEN = 128 KB).\n"
            "# Write it to a temp file via heredoc — data lives in stdin, not argv.\n"
            "_BSM_IMPORT_TMP=$(mktemp /tmp/.bsm_import_XXXXXX)\n"
            "base64 -d > \"$_BSM_IMPORT_TMP\" << 'BSMIMPORTEOF'\n"
            + wrapped + "\n"
            "BSMIMPORTEOF\n"
            "export BSM_IMPORT_TMP=\"$_BSM_IMPORT_TMP\"\n"
        )
    else:
        import_tmp_setup = ""

    # ---- Resolve where PBX_PASSWORD comes from ---------------------------
    pw_source = config.get("password_source", "csv")
    if pw_source == "inline":
        pw_value = config.get("password_inline", "") or ""
        # POSIX single-quote escape for safety
        quoted = "'" + pw_value.replace("'", "'\\''") + "'"
        pw_decl = (
            "# PBX password supplied inline by operator (same on every host).\n"
            f"PBX_PASSWORD={quoted}\n"
        )
    else:
        # `csv`: read from an env var the host-vars mechanism is expected to
        # have set. Default column name is "Password"; sanitise it the same
        # way deployer._sanitise_var_name does so the operator's CSV header
        # matches the env-var name we read here.
        col_raw = config.get("password_column", "Password") or "Password"
        col_var = _sanitise_var_name(col_raw) or "Password"
        pw_decl = (
            f'# PBX password sourced from CSV column "{col_raw}" '
            f'(exported as ${col_var}).\n'
            f'if [ -z "${{{col_var}}}" ]; then\n'
            f'  echo "ERROR: ${col_var} is empty on $(hostname). " \\\n'
            f'       "Either pick \'inline\' password source in the 3CX action, " \\\n'
            f'       "or upload a Compound CSV with a non-empty {col_raw} column." >&2\n'
            f"  exit 1\n"
            f"fi\n"
            f'PBX_PASSWORD="${{{col_var}}}"\n'
        )

    # Username: POSIX single-quote, defaulting to "0000"
    raw_user = config.get("username", "0000") or "0000"
    quoted_user = "'" + raw_user.replace("'", "'\\''") + "'"

    # The script template uses sentinel placeholders for the things we
    # interpolate (rather than an f-string) to avoid double-brace gymnastics
    # — the python-heredoc block uses real `{}` and `**kwargs`-style code
    # that would conflict with f-string escaping.
    template = r"""#!/bin/bash
# 3CX configuration manager — auto-generated by Batch Device System Manager.
# Authenticates to the local 3CX webclient API on this host and enforces
# a set of field=value targets on Trunks and/or Users via PATCH.

__PW_DECL__

USERNAME=__USERNAME__

# All HTTP + JSON work happens in Python (urllib) so we don't depend on
# curl/wget being installed — 3CX appliances ship python3 universally
# but are inconsistent about which HTTP client is present.
export THREECX_USERNAME="$USERNAME"
export THREECX_PASSWORD="$PBX_PASSWORD"
export THREECX_CONFIG_B64='__CONFIG_B64__'
unset PBX_PASSWORD   # local copy goes away; child python sees it via env only

__IMPORT_TMP_SETUP__
# PYTHONUNBUFFERED=1 disables Python's pipe-mode block-buffering so every
# print() call reaches the SSH channel immediately (real-time log streaming).
export PYTHONUNBUFFERED=1
python3 << 'PYEOF'
import os, sys, json, base64, ssl, socket
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

USERNAME = os.environ["THREECX_USERNAME"]
PASSWORD = os.environ["THREECX_PASSWORD"]
CONFIG   = json.loads(base64.b64decode(os.environ["THREECX_CONFIG_B64"]))
HOST     = "https://localhost"

# Self-signed cert on localhost — skip verification.
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode    = ssl.CERT_NONE


def _login():
    body = json.dumps({
        "Username": USERNAME, "Password": PASSWORD, "SecurityCode": ""
    }).encode("utf-8")
    req = Request(HOST + "/webclient/api/Login/GetAccessToken",
                  data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        resp = urlopen(req, context=ctx, timeout=15)
        body = resp.read()
    except HTTPError as e:
        return None, "HTTP " + str(e.code) + ": " + e.read().decode("utf-8", errors="replace")
    except URLError as e:
        return None, "URL error: " + str(e.reason)
    except Exception as e:
        return None, type(e).__name__ + ": " + str(e)
    try:
        d = json.loads(body)
    except Exception:
        return None, "non-JSON response: " + body[:200].decode("utf-8", errors="replace")
    tok = (d.get("Token") or {}) if isinstance(d.get("Token"), dict) else {}
    access = tok.get("access_token", "")
    if not access:
        return None, "no access_token in response: " + json.dumps(d)[:200]
    return access, ""


TOKEN, err = _login()
if not TOKEN:
    print("ERROR: PBX login failed -- " + err, file=sys.stderr)
    sys.exit(1)

print("Token retrieved successfully (" + os.uname().nodename + ")")
print()


def api_get(path):
    req = Request(HOST + path)
    req.add_header("Authorization", "Bearer " + TOKEN)
    return json.loads(urlopen(req, context=ctx, timeout=30).read())


def api_patch(path, body):
    data = json.dumps(body).encode("utf-8")
    req = Request(HOST + path, data=data, method="PATCH")
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("Content-Type", "application/json")
    try:
        resp = urlopen(req, context=ctx, timeout=30)
        return resp.status, ""
    except HTTPError as e:
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            err_body = ""
        return e.code, err_body
    except URLError as e:
        return -1, "URL error: " + str(e.reason)


def api_post(path, body):
    # POST to an OData collection endpoint to create a new item. Returns
    # (status_code, body_or_error_text). On 2xx the response body is the
    # created item (useful for echo / Id discovery); on failure we keep
    # the server's error JSON so the import log can show why.
    data = json.dumps(body).encode("utf-8")
    req = Request(HOST + path, data=data, method="POST")
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("Content-Type", "application/json")
    try:
        resp = urlopen(req, context=ctx, timeout=30)
        try:
            txt = resp.read().decode("utf-8", errors="replace")
        except Exception:
            txt = ""
        return resp.status, txt
    except HTTPError as e:
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            err_body = ""
        return e.code, err_body
    except URLError as e:
        return -1, "URL error: " + str(e.reason)


def api_delete(path):
    # DELETE an OData single-item path like /xapi/v1/Holidays(42). 3CX
    # returns 204 No Content on success.
    req = Request(HOST + path, method="DELETE")
    req.add_header("Authorization", "Bearer " + TOKEN)
    try:
        resp = urlopen(req, context=ctx, timeout=30)
        return resp.status, ""
    except HTTPError as e:
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            err_body = ""
        return e.code, err_body
    except URLError as e:
        return -1, "URL error: " + str(e.reason)


# ---- BLF ID resolution ------------------------------------------------------
# Every <BLF> element inside the Users.Blfs XML needs an ID attribute that
# 3CX uses internally to bind the BLF to its target entity:
#   • BLFType="BLF" or "SpeedDial" → ID = User.Id of the watched extension
#   • BLFType="SharedParking"      → ID = Parking entry's database Id
#
# Without those IDs 3CX silently accepts the PATCH (HTTP 204) but stores
# garbage — the BLF keys render empty on the phone. Operators have no
# practical way to know these IDs, so the BLF Builder UI sends XML
# WITHOUT them and we resolve them here, on the host, before the PATCH.
# The maps are cached per host invocation since /Users can be slow on
# large PBXes and we may patch many extensions per run.

_BLF_USER_MAP = None        # extension number -> User.Id
_BLF_PARK_MAP = None        # parking number ("*0" or "SP0") -> Parking.Id


def _build_blf_user_map():
    global _BLF_USER_MAP
    if _BLF_USER_MAP is not None:
        return _BLF_USER_MAP
    _BLF_USER_MAP = {}
    try:
        # $select keeps the response small even on PBXes with hundreds of
        # extensions. If 3CX doesn't honour $select, the full payload is
        # still fine — we just discard the extra fields.
        users = api_get("/xapi/v1/Users?$select=Id,Number").get("value", [])
        for u in users:
            num = u.get("Number")
            uid = u.get("Id")
            if num is not None and uid is not None:
                _BLF_USER_MAP[str(num)] = int(uid)
    except Exception:
        pass
    return _BLF_USER_MAP


def _build_blf_park_map():
    global _BLF_PARK_MAP
    if _BLF_PARK_MAP is not None:
        return _BLF_PARK_MAP
    _BLF_PARK_MAP = {}
    try:
        parkings = api_get("/xapi/v1/Parkings").get("value", []) or []
        # Sort by Id so the SPn shorthand maps deterministically to the
        # nth slot (SP0 = first parking, SP1 = second, ...). 3CX renders
        # them in this order in the web UI's BLF picker.
        parkings_sorted = sorted(parkings, key=lambda p: int(p.get("Id", 0) or 0))
        for i, p in enumerate(parkings_sorted):
            pid = p.get("Id")
            num = p.get("Number") or ""
            if pid is None:
                continue
            pid = int(pid)
            # Two lookup keys per slot: the actual Number ("*0") and the
            # SPn shorthand ("SP0") that the BLF Builder produces.
            if num:
                _BLF_PARK_MAP[str(num)] = pid
            _BLF_PARK_MAP["SP" + str(i)] = pid
    except Exception:
        pass
    return _BLF_PARK_MAP


def _resolve_blf_ids(xml):
    # Add ID="..." attributes to every <BLF> element that lacks one.
    # Looks up the right Id by BLFType + element text. Leaves elements
    # that already have an ID untouched (operator may have pre-resolved).
    if not isinstance(xml, str) or "<BLF " not in xml:
        return xml
    import re
    user_map = _build_blf_user_map()
    park_map = _build_blf_park_map()

    def fix_one(m):
        whole = m.group(0)
        attrs = m.group(1)
        target = m.group(2)
        if re.search(r'\bID="', attrs):
            return whole   # already has an ID — leave alone
        type_match = re.search(r'\bBLFType="([^"]+)"', attrs)
        if not type_match:
            return whole
        bt = type_match.group(1).strip()
        tt = target.strip()
        looked_up = None
        if bt in ("BLF", "SpeedDial"):
            looked_up = user_map.get(tt)
        elif bt == "SharedParking":
            looked_up = park_map.get(tt)
        if looked_up is None:
            return whole
        # Inject ID= as the first attribute. Build a new opening tag so
        # spacing stays sane regardless of how the input was formatted.
        return '<BLF ID="' + str(looked_up) + '"' + attrs + '>' + target + '</BLF>'

    return re.sub(r'<BLF\b([^>]*)>([^<]*)</BLF>', fix_one, xml, flags=re.IGNORECASE)


def _resolve_blfs_in_patch(body):
    # Recursively scan a PATCH body and rewrite any string value that
    # looks like BLF XML, adding the IDs 3CX needs.
    if isinstance(body, dict):
        for k, v in list(body.items()):
            if isinstance(v, str) and "<BLF " in v:
                body[k] = _resolve_blf_ids(v)
            elif isinstance(v, (dict, list)):
                _resolve_blfs_in_patch(v)
    elif isinstance(body, list):
        for el in body:
            if isinstance(el, (dict, list)):
                _resolve_blfs_in_patch(el)
            # str elements in arrays are uncommon for BLFs but cheap to handle
    return body


class _NotFound:
    pass
_NF = _NotFound()


# ---- Clone-from-source resolution ----------------------------------------
# Operator's workflow: configure a single "reference" item (e.g. ext 2901's
# Blfs via the 3CX web UI), then ask the tool to copy specific field values
# from that reference onto a target range (2902-2920). Cleaner than
# hand-building each value in the catalog, and lets 3CX handle ID resolution
# / validation entirely on its side.
#
# CONFIG["clone_sources"] is {entity_key: filter_string}. The filter spec
# follows the same syntax as the per-entity item filter ("2901" /
# "2901-2920" / "NTES*"), but should match exactly ONE item — the source.
# If it matches 0 or >1 items we log a clear warning and fall back to the
# operator's catalog values for that entity.

CLONE_SOURCES = dict(CONFIG.get("clone_sources") or {})

# Reprovision-after-apply: when the operator confirms the second prompt in
# the UI, the frontend sets this to True. The apply loop then collects the
# MAC of every phone on every successfully-patched User whose targets
# included a phone-resident field (Blfs or Phones.*) and POSTs them to
# /xapi/v1/Users/Pbx.ReprovisionPhone once the entity loop completes. The
# action is fire-and-forget on the PBX side (204 No Content); we just need
# to nudge it to push the new config out so the handsets don't keep
# displaying the previous state until their next scheduled check-in.
REPROVISION_AFTER_APPLY = bool(CONFIG.get("reprovision_after_apply"))
_MACS_TO_REPROVISION = set()


def _is_phone_affecting_field(field_path):
    # Decide whether a field on the Users entity, when changed, means the
    # phone needs a new provisioning file. Blfs is the obvious one (button
    # XML is rendered from the provisioning template) and anything under
    # Phones.* is by definition per-phone. Other User fields (EmailAddress,
    # OutboundCallerID, Mobile, AuthID, …) are PBX-side state that the
    # phone doesn't render, so don't trigger a reprovision for those.
    f = (field_path or "").strip()
    if not f:
        return False
    if f == "Blfs":
        return True
    if f.startswith("Phones."):
        return True
    return False


def _resolve_clone_source(key, ent, all_items):
    # Find the source item that the operator wants to copy from. Returns
    # the source dict or None.
    spec = CLONE_SOURCES.get(key, "")
    if not spec or not str(spec).strip():
        return None
    matcher = _parse_item_filter(str(spec).strip())
    if matcher is None:
        return None
    identity_of = ent.get("identity_of") or (lambda _i: "")
    matches = [it for it in all_items if matcher(identity_of(it))]
    if len(matches) == 0:
        print("  [warn] clone source '" + str(spec).strip()
              + "' matched no items — using catalog values instead")
        return None
    if len(matches) > 1:
        print("  [warn] clone source '" + str(spec).strip()
              + "' matched " + str(len(matches))
              + " items — using the first one")
    return matches[0]


def get_nested(obj, dotted):
    # Resolve a dotted path against a nested dict. Returns _NF if not found.
    cur = obj
    for p in dotted.split("."):
        if isinstance(cur, dict) and p in cur:
            cur = cur[p]
        else:
            return _NF
    return cur


def build_patch(dotted, value):
    # Build a minimal nested dict that, when PATCHed, sets only this path.
    parts = dotted.split(".")
    body = head = {}
    for p in parts[:-1]:
        head[p] = {}
        head = head[p]
    head[parts[-1]] = value
    return body


def merge_into(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            merge_into(dst[k], v)
        else:
            dst[k] = v


# ---- Array-path support (the `*` wildcard) -------------------------------
# Path syntax: "Phones.*.Codecs" means "the Codecs field on every element of
# the Phones array". Used for editing per-phone IP-Phone-tab settings on
# the User entity (Phones[] is a navigation property containing the actual
# device records — Codecs, DateFormat, TimeFormat etc. all live there).
#
# PATCHing one of these requires sending the WHOLE collection back to 3CX
# with the modification applied — partial updates inside an array don't
# work. So `build_array_patches` collects ALL field-level changes targeted
# at a single array, applies them in one pass, and returns a single body
# like `{"Phones": [<modified array>]}` regardless of how many fields the
# operator ticked.

def _has_wildcard(dotted):
    return "*" in dotted.split(".")


def get_nested_with_array(obj, dotted):
    # Like get_nested but returns a list of values when the path contains
    # `*` (one entry per array element). Returns _NF if any segment is
    # missing on EVERY array element.
    parts = dotted.split(".")
    cur = obj
    for i, p in enumerate(parts):
        if p == "*":
            if not isinstance(cur, list):
                return _NF
            rest = ".".join(parts[i + 1:])
            if not rest:
                return list(cur)
            vals = []
            any_found = False
            for el in cur:
                v = get_nested(el, rest)
                if v is _NF:
                    vals.append(_NF)
                else:
                    any_found = True
                    vals.append(v)
            return vals if any_found else _NF
        if isinstance(cur, dict) and p in cur:
            cur = cur[p]
        else:
            return _NF
    return cur


def build_array_patches(item, array_targets):
    # array_targets is a list of (path, value) where every path goes
    # through the SAME array (e.g. all "Phones.*.X" paths). Builds one
    # patch body that contains the full modified array — caller merges
    # the result into the per-item PATCH dict.
    #
    # Returns (patch_body, applied_count, missing_paths).
    if not array_targets:
        return {}, 0, []
    # Validate all paths share the same array prefix.
    first_parts = array_targets[0][0].split(".")
    star_idx = first_parts.index("*")
    array_prefix = first_parts[:star_idx]              # e.g. ["Phones"]

    # Walk to the array on the live item.
    cur = item
    for p in array_prefix:
        if isinstance(cur, dict) and p in cur:
            cur = cur[p]
        else:
            return {}, 0, [t[0] for t in array_targets]
    if not isinstance(cur, list):
        return {}, 0, [t[0] for t in array_targets]

    # Deep-copy each element so we can mutate without touching the source.
    import copy
    modified = [copy.deepcopy(el) if isinstance(el, dict) else el for el in cur]

    applied = 0
    missing = []
    for path, value in array_targets:
        parts = path.split(".")
        idx = parts.index("*")
        sub = parts[idx + 1:]
        for el in modified:
            if not isinstance(el, dict):
                continue
            # Walk to the parent of the leaf, creating intermediate dicts
            # as needed. (Safe because we're working on the deep copy.)
            tgt = el
            for p in sub[:-1]:
                if not isinstance(tgt.get(p), dict):
                    tgt[p] = {}
                tgt = tgt[p]
            tgt[sub[-1]] = value
        applied += 1

    # Wrap the modified array under its prefix so the result is a proper
    # PATCH body: {"Phones": [...]}.
    body = head = {}
    for p in array_prefix[:-1]:
        head[p] = {}
        head = head[p]
    head[array_prefix[-1]] = modified
    return body, applied, missing


# ---------- probe helpers (used both by the per-entity probe block and by
# the discovery pass that walks any entity sets the operator hasn't
# explicitly catalogued) ----------
# def _fmt_leaf(v):
    # Compact single-line repr for a log column. Long strings (license
    # blobs, SDP, etc.) are truncated so a single field can't drown the
    # whole report.
    # s = repr(v)
    # if len(s) > 80:
    #     s = s[:77] + "..."
    # return s
def _fmt_leaf(v):
    return repr(v)

def walk_sample(prefix, value, depth=0):
    # Recursively print every leaf of a sample item as `dotted.path (type): value`.
    # Hard depth cap so cyclic / pathologically nested structures can't blow
    # up the log. 3CX objects are 2-3 levels deep at most.
    if depth > 6:
        print("    " + prefix + " (...): max depth reached")
        return
    if isinstance(value, dict):
        if not value:
            print("    " + prefix + " (object): {}")
            return
        for k in sorted(value.keys()):
            sub = prefix + "." + k if prefix else k
            walk_sample(sub, value[k], depth + 1)
    elif isinstance(value, list):
        if not value:
            print("    " + prefix + " (list): []")
        elif all(not isinstance(x, (dict, list)) for x in value):
            print("    " + prefix + " (list[" + str(len(value))
                  + "]): " + _fmt_leaf(value))
        else:
            print("    " + prefix + " (list[" + str(len(value))
                  + "] of " + type(value[0]).__name__ + "):")
            walk_sample(prefix + "[0]", value[0], depth + 1)
    else:
        print("    " + prefix
              + " (" + type(value).__name__ + "): "
              + _fmt_leaf(value))


# Entities the operator can manage. The `skip` predicate filters items
# that aren't usefully patchable (internal bridges, disabled users, ...).
# `identity_of` returns the string the operator's per-entity filter spec
# is matched against (e.g. user Number, trunk Gateway.Name) — see
# _parse_item_filter and the per-entity filter dict below.
ENTITIES = {
    "trunks": {
        "label": "Trunks",
        "path":  "/xapi/v1/Trunks",
        "name_of": lambda t: (
            (t.get("Gateway") or {}).get("Name")
            or t.get("Number")
            or str(t.get("Id", "?"))
        ),
        "identity_of": lambda t: (t.get("Gateway") or {}).get("Name") or t.get("Number") or "",
        "skip": lambda t: bool(
            (t.get("Gateway") or {}).get("Internal", False)
            or (t.get("Gateway") or {}).get("Type", "") in ("BridgeMaster", "BridgeSlave")
        ),
    },
    "users": {
        "label": "Users",
        "path":  "/xapi/v1/Users",
        "name_of": lambda u: (
            (str(u.get("Number") or "?")
             + " "
             + (u.get("DisplayName") or u.get("FirstName") or "")).strip()
        ),
        "identity_of": lambda u: str(u.get("Number") or ""),
        "skip": lambda u: not u.get("Enabled", False),
    },
}

# Identity-field strategies for dynamic (operator-added) entities. Most
# 3CX entities sit on Name; the numeric-extension ones (Queues, Ring-
# Groups, Receptionists, Groups) sit on Number; Fxs has a MAC. We pick
# the strongest available identifier so the filter is most useful, then
# fall back through Name → Number → Id.
_IDENTITY_FIELD_BY_KEY = {
    "queues":         ["Number", "Name"],
    "ringgroups":     ["Number", "Name"],
    "receptionists":  ["Number", "Name"],
    "groups":         ["Number", "Name"],
    "parkings":       ["Number"],
    "fxs":            ["Name", "MacAddress"],
    "sipdevices":     ["Registrar.MAC", "Id"],
    "didnumbers":     ["Number"],
    "parameters":     ["Name"],
    "peers":          ["Number", "Name"],
    # everything else: try Name then Number then Id (see _build_identity_of)
}

def _build_identity_of(key):
    fields = _IDENTITY_FIELD_BY_KEY.get(key) or ["Name", "Number"]
    def identity_of(item):
        if not isinstance(item, dict):
            return ""
        for f in fields:
            # Support dotted lookup so things like "Registrar.MAC" work.
            cur = item
            ok = True
            for p in f.split("."):
                if isinstance(cur, dict) and p in cur:
                    cur = cur[p]
                else:
                    ok = False
                    break
            if ok and cur not in (None, ""):
                return str(cur)
        if "Id" in item:
            return str(item["Id"])
        return ""
    return identity_of


# ---------- Dynamic entities registered by the operator via the "Add
# endpoint" dropdown in the UI. Each extra has the same shape as the
# hardcoded ENTITIES entries above, but with a generic name-of and a
# no-op skip (the operator picked this endpoint explicitly, so we don't
# second-guess which items are "interesting").
def _generic_name_of(item):
    if not isinstance(item, dict):
        return str(item)
    # Most 3CX entities have at least one of these. Number+DisplayName is
    # nice for things like Users/Queues; Name covers OutboundRules,
    # Holidays, Templates; Id is the last resort so we always print
    # something the operator can match in the API.
    pieces = []
    num  = item.get("Number")
    nm   = item.get("Name") or item.get("DisplayName")
    if num: pieces.append(str(num))
    if nm:  pieces.append(str(nm))
    if pieces:
        return " ".join(pieces)
    if "Id" in item:
        return "#" + str(item["Id"])
    return "(unnamed)"


for extra in CONFIG.get("extras") or []:
    key  = (extra.get("key")  or "").strip()
    path = (extra.get("path") or "").strip()
    lbl  = (extra.get("label") or key or path or "Endpoint").strip()
    if not key or not path:
        continue
    # If the operator picked an endpoint we already catalogue (Trunks /
    # Users), don't double-register it — the hardcoded entry has nicer
    # name_of / skip predicates than the generic fallback.
    if key in ENTITIES:
        # Still fold the operator's extras-panel fields into the existing
        # entity's targets so a Trunks-via-extras panel and the hardcoded
        # Trunks panel behave identically.
        CONFIG.setdefault(key, [])
        CONFIG[key].extend(extra.get("fields") or [])
        continue
    ENTITIES[key] = {
        "label":       lbl,
        "path":        path,
        "singleton":   bool(extra.get("singleton", False)),
        "name_of":     _generic_name_of,
        "identity_of": _build_identity_of(key),
        "skip":        lambda _it: False,
    }
    # The main loop reads targets via `CONFIG.get(key) or []`. Copy the
    # extras-panel's field list into that slot so the existing apply /
    # audit / probe code paths work unchanged.
    CONFIG[key] = list(extra.get("fields") or [])


mode        = CONFIG.get("mode", "apply")     # "apply" | "probe" | "audit" | "export" | "import"
probe_first = bool(CONFIG.get("probe_first"))

# Active entity set — entities the operator currently has a panel for in
# the UI. Operator can ✕ Remove the hardcoded Trunks/Users panels, in
# which case those keys won't appear here and the script must skip them
# entirely (no GET, no probe, no export, no audit). The frontend always
# sends this list; if it's missing (older client), fall back to "every
# entity in ENTITIES", which matches the prior always-on behaviour.
_ak = CONFIG.get("active_keys")
if isinstance(_ak, list):
    ACTIVE_ENTITY_KEYS = {str(k).strip() for k in _ak if str(k).strip()}
else:
    ACTIVE_ENTITY_KEYS = set(ENTITIES.keys()) | {
        (e.get("key") or "").strip()
        for e in (CONFIG.get("extras") or [])
        if (e.get("key") or "").strip()
    }


def _parse_item_filter(spec):
    # Parse an operator-supplied item filter into a predicate
    # (identity_str -> bool). Empty / blank spec returns None, meaning
    # "no filter" (apply to every non-skipped item).
    #
    # Format — comma-separated, each piece is one of:
    #   • Numeric range "200-299" — matches if identity parses as int and
    #     lies inclusively between (lo, hi).
    #   • Glob with "*" — case-insensitive wildcard match against identity
    #     ("Local*" matches "LocalOnly" and "Local Rule"; "*TEST*" matches
    #     anything containing TEST).
    #   • Bare token — case-insensitive exact match against identity. Used
    #     for things like a specific extension ("0000") or a specific Name
    #     ("Christmas").
    #
    # Whitespace pieces are ignored. The predicate is called with whatever
    # the entity's `identity_of` returned (string).
    import fnmatch
    if not spec or not str(spec).strip():
        return None
    exact = set()    # lowercase strings
    globs = []       # fnmatch patterns (already lowercased)
    ranges = []
    for piece in str(spec).split(","):
        piece = piece.strip()
        if not piece:
            continue
        # Numeric range like "200-299" — try first because pieces could
        # also legitimately contain a single "-" inside a Name (rare).
        if "-" in piece and "*" not in piece:
            a, b = piece.split("-", 1)
            try:
                lo, hi = int(a.strip()), int(b.strip())
                if lo > hi:
                    lo, hi = hi, lo
                ranges.append((lo, hi))
                continue
            except ValueError:
                pass  # not a numeric range — fall through
        if "*" in piece or "?" in piece:
            globs.append(piece.lower())
        else:
            exact.add(piece.lower())

    def predicate(identity_value):
        s = str(identity_value or "").strip()
        if not s:
            return False
        sl = s.lower()
        if sl in exact:
            return True
        for g in globs:
            if fnmatch.fnmatchcase(sl, g):
                return True
        try:
            n = int(s)
        except (TypeError, ValueError):
            n = None
        if n is not None:
            for lo, hi in ranges:
                if lo <= n <= hi:
                    return True
        return False
    return predicate


# Build per-entity filter predicates from CONFIG["filters"] = {key: spec}.
# Backward-compatible alias: the old `user_filter` key (used by earlier
# UIs that only had a Users filter input) is folded into filters["users"]
# if both are present.
_raw_filters = dict(CONFIG.get("filters") or {})
_legacy_uf = (CONFIG.get("user_filter") or "").strip()
if _legacy_uf and not _raw_filters.get("users"):
    _raw_filters["users"] = _legacy_uf
ENTITY_FILTERS = {
    key: _parse_item_filter(spec) for key, spec in _raw_filters.items()
}

# Per-entity OData $expand strings. Empty by default. Operator sets these
# in the UI to pull in nested sub-objects that 3CX hides by default — most
# notably User.Phone, which carries the IP Phone tab settings (Codecs,
# DateFormat, TimeFormat, TimeZone, BacklightTimeout, etc.).
_raw_expands = dict(CONFIG.get("expands") or {})
ENTITY_EXPANDS = {
    str(k).strip(): str(v).strip()
    for k, v in _raw_expands.items()
    if str(k).strip() and str(v).strip()
}


# Audit accounting — aggregated across every entity so we can fail the host
# at the end if ANY tested field on ANY item didn't match. We treat both
# "got wrong value" and "field missing on this 3CX version" as failures
# because either one means the operator's intended state isn't enforced.
AUDIT_TOTAL_ITEMS    = 0   # how many items we actually audited (non-skipped)
AUDIT_FAILED_ITEMS   = 0   # how many had >= 1 mismatched OR missing field
AUDIT_FAILED_FIELDS  = 0   # total mismatch + missing across the fleet


# ---------- Export mode (Golden Standard PBX -> downloadable JSON) ----------
# Strip rules. Keys that are auto-assigned by the source PBX, contain
# secrets, or describe transient operational state get removed before the
# payload is emitted. The remaining body is what an import can sensibly
# patch / create on a target PBX.
_EXPORT_STRIP_KEYS = {
    "Id",                # auto-assigned per PBX; never portable
    "IsRegistered", "IsOnline",          # transient registration state
    "Created", "Used", "Revoked",
    "CreatedByIp", "UsedByIp", "RevokedByIp",
    "CreatedByUserAgent", "UsedByUserAgent",
    "ExpiresAt", "OverrideExpiresAt", "LastLoginTime",
    "Token", "AuthID", "SIPID",          # per-PBX identifiers / secrets
    "CertificateName", "CertificateExpirationDate",
    "Connection",                        # SBC connection status block
    "TrunkRegTimes",                     # transient registration timings
    "ProvLink", "ProvisionLink",         # per-system provisioning URLs
    "Blfs",                              # phone-hardware-specific XML
    "PublicIP", "LocalIPv4",             # per-host network state
    "FileLink", "DownloadLink",          # per-host download URLs
    "SampleTime",                        # services telemetry timestamps
    "CompilationLastSuccess", "CompilationResult", "CompilationSucceeded",
}

_EXPORT_STRIP_KEYWORDS = ("Password", "Secret", "Pin")


def _strip_for_export(value, depth=0):
    # Recursively remove keys we don't want in a portable export. Applies
    # at every nesting level so e.g. Gateway.Id is dropped just like
    # top-level Id, and Provisioning.Password is dropped just like a
    # top-level AuthPassword.
    if depth > 12:
        return value
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k in _EXPORT_STRIP_KEYS:
                continue
            if any(kw in k for kw in _EXPORT_STRIP_KEYWORDS):
                continue
            out[k] = _strip_for_export(v, depth + 1)
        return out
    if isinstance(value, list):
        return [_strip_for_export(x, depth + 1) for x in value]
    return value


if mode == "export":
    import datetime
    export_payload = {
        "metadata": {
            "format": "bsm-3cx-golden-export/v1",
            "exported_at": datetime.datetime.utcnow().strftime(
                "%Y-%m-%dT%H:%M:%SZ"),
            "source_hostname": os.uname().nodename,
            "entities": [],
        },
        "entities": {},
    }
    print("==============================")
    print(" Golden Standard export")
    print("==============================")
    for key, ent in ENTITIES.items():
        if key not in ACTIVE_ENTITY_KEYS:
            continue   # operator removed this panel — exclude from export
        print("  " + ent["label"] + " (" + ent["path"] + ") — fetching…")
        try:
            # Apply per-entity $expand if configured. Gracefully retry
            # without it if 3CX rejects the nav property (400 Bad Request).
            _exp = ENTITY_EXPANDS.get(key, "").strip()
            _qs  = ("?$expand=" + _exp) if _exp else ""
            try:
                resp = api_get(ent["path"] + _qs)
            except HTTPError as he:
                if _exp and he.code == 400:
                    print("    WARNING: $expand='" + _exp + "' rejected (400); retrying without it")
                    resp = api_get(ent["path"])
                else:
                    raise
            # Singleton endpoints return a plain object, not {"value":[...]}.
            # Auto-detect: if the response has no "value" key, treat the
            # whole object as a single item.
            if "value" in resp:
                items = resp.get("value") or []
                is_singleton = False
            else:
                # Strip OData metadata keys (@odata.*) before wrapping.
                flat = {k: v for k, v in resp.items()
                        if not k.startswith("@")}
                items = [flat] if flat else []
                is_singleton = True
        except Exception as e:
            print("    SKIPPED: " + str(e))
            continue
        # Honor the entity's `skip` predicate (e.g. drop bridge trunks)
        # so the operator's exported Golden config doesn't include items
        # that shouldn't be cloned across systems.
        if not is_singleton:
            items = [it for it in items if not ent["skip"](it)]
            # Per-entity item filter — operator can export "OutboundRules
            # matching Local*" etc. Filters don't apply to singletons.
            flt = ENTITY_FILTERS.get(key)
            if flt is not None:
                identity_of = ent.get("identity_of") or (lambda _i: "")
                items = [it for it in items if flt(identity_of(it))]
        clean = [_strip_for_export(it) for it in items]
        export_payload["entities"][key] = {
            "label":     ent["label"],
            "path":      ent["path"],
            "singleton": is_singleton or bool(ent.get("singleton")),
            "items":     clean,
        }
        export_payload["metadata"]["entities"].append(key)
        tag = " (singleton)" if is_singleton else ""
        print("    captured " + str(len(clean)) + " item"
              + ("" if len(clean) == 1 else "s") + tag)
    payload_b64 = base64.b64encode(
        json.dumps(export_payload, indent=2).encode("utf-8")
    ).decode("ascii")
    # The frontend looks for these sentinel lines, strips them out of the
    # per-host log, decodes the base64 between them, and offers the JSON
    # as a download. Sentinel must be unique enough to never collide with
    # ordinary log lines.
    print()
    print("###BSM_3CX_EXPORT_BEGIN###")
    # Chunk so very large exports don't make a single 1-MB+ line that
    # streams awkwardly through the per-line NDJSON event protocol.
    for i in range(0, len(payload_b64), 4000):
        print(payload_b64[i:i+4000])
    print("###BSM_3CX_EXPORT_END###")
    print()
    print("Done.")
    sys.exit(0)


# ---------- Import mode (apply a Golden Standard JSON to this host) ----------
# The operator picked a previously-exported JSON in the UI and a strategy:
#   • additive — POST source-only items, leave existing alone
#   • patch    — PATCH items that match by identity on the target
#   • mirror   — POST source-only + PATCH matching + DELETE target-only
#                (gated by an extra "MIRROR" typed confirmation in the UI)
#
# Identity matching is per-entity (see _match_key) so a Trunk is matched by
# Gateway.Name, a User by Number, a Holiday by Name+Month+Day, etc. Items
# without a matchable identity field are skipped (better to leave them
# alone than to blindly create duplicates).
def _match_key(item, ekey):
    if not isinstance(item, dict):
        return None
    if ekey == "trunks":
        nm = (item.get("Gateway") or {}).get("Name", "")
        return ("trunks", str(nm)) if nm else None
    if ekey == "users":
        nm = item.get("Number", "")
        return ("users", str(nm)) if nm else None
    if ekey == "holidays":
        nm = item.get("Name", "")
        return ("holidays", str(nm), item.get("Month"), item.get("Day")) if nm else None
    if ekey == "outboundrules":
        nm = item.get("Name", "")
        return ("outboundrules", str(nm)) if nm else None
    if ekey == "fxs":
        nm = item.get("MacAddress", "")
        return ("fxs", str(nm)) if nm else None
    if ekey in ("queues", "ringgroups", "receptionists", "groups",
                "parkings", "didnumbers", "fax", "peers"):
        nm = item.get("Number") or item.get("Name") or ""
        return (ekey, str(nm)) if nm else None
    # Generic fallback: prefer Name then Number then Id.
    for f in ("Name", "Number", "Id"):
        if item.get(f) not in (None, ""):
            return (ekey, str(item[f]))
    return None


# Identity fields the server assigns / owns — we never want to send
# these in a POST or PATCH body. Mostly the same set as the export-strip
# list (so a freshly-exported JSON is already clean), but be defensive
# here too in case the operator hand-edited the file.
_WRITE_STRIP_KEYS = set(_EXPORT_STRIP_KEYS) | {"@odata.context", "@odata.etag"}


def _prep_write_body(item):
    return _strip_for_export(item)  # same strip rules, same recursive walk


# ---- Cross-reference remapping at import time ------------------------------
# Several entities reference other entities by their auto-increment Id —
# OutboundRules.Routes[i].TrunkId is the prime example. Those Ids are
# per-PBX (Id 33 on the source may be Id 1 or absent on the target), so a
# literal POST/PATCH fails with WARNINGS.XAPI.NOT_FOUND. We re-resolve each
# foreign Id by matching its sibling "*Name" field against the target's
# current set of trunks, fetched once per host at import start.

def _build_trunk_name_to_id_map():
    # Fetch the target PBX trunks and return {trunk_name: id}.
    try:
        trunks = api_get("/xapi/v1/Trunks").get("value", []) or []
    except Exception:
        return {}
    out = {}
    for t in trunks:
        if not isinstance(t, dict):
            continue
        nm = (t.get("Gateway") or {}).get("Name") or t.get("Number")
        tid = t.get("Id")
        if nm and tid is not None:
            out[str(nm)] = tid
    return out


def _remap_trunk_refs(item, name_to_id):
    # Walk OutboundRules.Routes (and similar) and rewrite TrunkId by looking
    # up the sibling TrunkName in name_to_id. Returns (remapped_item,
    # skipped_routes) where skipped_routes is a list of TrunkName strings
    # for trunks not present on the target. Those routes are dropped so
    # the rest of the rule can still be created.
    if not isinstance(item, dict):
        return item, []
    skipped = []
    routes = item.get("Routes")
    if isinstance(routes, list):
        fixed = []
        for r in routes:
            if not isinstance(r, dict):
                fixed.append(r)
                continue
            nm = r.get("TrunkName")
            if nm and nm in name_to_id:
                r = dict(r)
                r["TrunkId"] = name_to_id[nm]
                fixed.append(r)
            elif nm:
                skipped.append(str(nm))
            else:
                # No name to remap by — leave as-is and hope the Id is valid.
                fixed.append(r)
        item = dict(item)
        item["Routes"] = fixed
    return item, skipped


if mode == "import":
    # Import payload was written to a temp file by the shell preamble to avoid
    # Linux's MAX_ARG_STRLEN (128 KB) limit on individual env-var strings.
    # Fall back to CONFIG["import_payload"] for backwards compatibility.
    _imp_file = os.environ.get("BSM_IMPORT_TMP", "")
    if _imp_file:
        try:
            with open(_imp_file, "r", encoding="utf-8") as _f:
                payload = json.loads(_f.read())
        except Exception as _e:
            print("ERROR: could not read import payload from temp file "
                  + repr(_imp_file) + ": " + str(_e))
            sys.exit(1)
        finally:
            try:
                os.unlink(_imp_file)
            except OSError:
                pass
    else:
        payload = CONFIG.get("import_payload") or {}
    strategy = (CONFIG.get("import_strategy") or "merge").lower().strip()
    # Strategies:
    #   additive — POST source-only items only (safest; never touches existing)
    #   patch    — PATCH matching items only (no creates, no deletes)
    #   merge    — POST source-only + PATCH matching (no deletes — recommended
    #              for Golden Standard cloning: creates missing items AND
    #              updates stale values on items that already exist)
    #   mirror   — merge + DELETE target-only items (destructive sync)
    if strategy not in ("additive", "patch", "merge", "mirror"):
        strategy = "merge"

    # Pre-build a TrunkName -> TrunkId map of the TARGET PBX so we can rewrite
    # cross-reference IDs in OutboundRules (and any other entity whose body
    # carries TrunkId/TrunkName pairs). Fetched once per import run.
    _TRUNK_NAME_TO_ID = _build_trunk_name_to_id_map()

    meta = payload.get("metadata") or {}
    print("==============================")
    print(" Golden Standard import (" + strategy + ")")
    print("==============================")
    if meta.get("source_hostname"):
        print("  source: " + str(meta.get("source_hostname"))
              + "  exported: " + str(meta.get("exported_at", "?")))
    print()

    IMPORT_CREATED = 0
    IMPORT_PATCHED = 0
    IMPORT_DELETED = 0
    IMPORT_FAILED  = 0
    IMPORT_SKIPPED = 0

    for ekey, edata in (payload.get("entities") or {}).items():
        ent = ENTITIES.get(ekey)
        if ent is None:
            # The operator's UI didn't add this entity, but the payload
            # has it — register a default entry so import still works
            # without forcing them to click around in the catalog.
            path = (edata.get("path") or "/xapi/v1/" + ekey).strip()
            ENTITIES[ekey] = {
                "label":     edata.get("label", ekey),
                "path":      path,
                "singleton": bool(edata.get("singleton", False)),
                "name_of":   _generic_name_of,
                "identity_of": _build_identity_of(ekey),
                "skip":      lambda _it: False,
            }
            ent = ENTITIES[ekey]

        label = ent["label"]
        print("---- " + label + " ----")
        source_items = edata.get("items") or []
        if not source_items:
            print("  (no items in source)")
            print()
            continue

        # Apply the operator's per-entity filter to the import payload too.
        # Without this, an "import Parameters" run would PATCH all 800 rows
        # in the JSON even when the operator only wants e.g.
        # NOTALLOWED_COUNTRYCODES. Singletons are exempt (single object,
        # no identity to filter on).
        is_singleton_pre = bool(edata.get("singleton")) or bool(ent.get("singleton"))
        if not is_singleton_pre:
            flt = ENTITY_FILTERS.get(ekey)
            if flt is not None:
                _identity_of = ent.get("identity_of") or (lambda _i: "")
                before_n = len(source_items)
                source_items = [it for it in source_items if flt(_identity_of(it))]
                after_n = len(source_items)
                if after_n != before_n:
                    print("  filter kept " + str(after_n) + " of "
                          + str(before_n) + " source items")
                if not source_items:
                    print("  (no items left after filter — nothing to import)")
                    print()
                    continue

        # ---- Singleton endpoints (e.g. VoicemailSettings, MailSettings) ----
        # These are fixed single objects on the PBX — no create/delete is
        # possible, only PATCH the endpoint directly with the source data.
        is_singleton = bool(edata.get("singleton")) or bool(ent.get("singleton"))
        if is_singleton:
            body = _prep_write_body(source_items[0])
            print("  [PATCH ] " + label + " (singleton — PATCHing directly)")
            try:
                code, err = api_patch(ent["path"], body)
                if code and 200 <= code < 300:
                    IMPORT_PATCHED += 1
                else:
                    print("  [FAIL  ] PATCH HTTP " + str(code) + ": " + str(err)[:200])
                    IMPORT_FAILED += 1
            except Exception as _e:
                print("  [FAIL  ] " + str(_e))
                IMPORT_FAILED += 1
            print()
            continue

        # ---- Collection endpoints — normal create / patch / delete logic ----
        try:
            target_items = api_get(ent["path"]).get("value", [])
        except Exception as e:
            print("  ERROR fetching target collection: " + str(e))
            IMPORT_FAILED += 1
            print()
            continue

        # Build target index by identity. Items that don't match the
        # entity's skip predicate (e.g. bridge trunks, disabled users)
        # are intentionally excluded so we don't accidentally PATCH them.
        target_by_key = {}
        for ti in target_items:
            if ent["skip"](ti):
                continue
            mk = _match_key(ti, ekey)
            if mk is not None:
                target_by_key[mk] = ti

        source_keys = set()

        for si in source_items:
            sk = _match_key(si, ekey)
            ident = ent["name_of"](si) if isinstance(si, dict) else str(si)
            if sk is None:
                print("  [SKIP  ] " + ident + " (no identity field to match on)")
                IMPORT_SKIPPED += 1
                continue
            source_keys.add(sk)
            existing = target_by_key.get(sk)

            # Remap cross-references (e.g. OutboundRules.Routes[].TrunkId)
            # before we send. Source TrunkId is per-source-PBX and won't
            # exist on the target; sibling TrunkName resolves to the
            # target's matching trunk Id.
            si_remapped, skipped_routes = _remap_trunk_refs(si, _TRUNK_NAME_TO_ID)
            if skipped_routes:
                print("  [warn  ] " + ident + " — dropping routes for trunk(s) not on target: "
                      + ", ".join(skipped_routes))

            if existing is None:
                # Source-only — create if strategy allows
                if strategy in ("additive", "merge", "mirror"):
                    body = _prep_write_body(si_remapped)
                    code, err = api_post(ent["path"], body)
                    if code and 200 <= code < 300:
                        print("  [CREATE] " + ident)
                        IMPORT_CREATED += 1
                    else:
                        print("  [FAIL  ] " + ident
                              + " -- POST HTTP " + str(code) + ": " + str(err)[:160])
                        IMPORT_FAILED += 1
                else:
                    print("  [SKIP  ] " + ident + " (patch-only: target has no match)")
                    IMPORT_SKIPPED += 1
            else:
                # Both have it — patch if strategy allows
                if strategy in ("patch", "merge", "mirror"):
                    target_id = existing.get("Id")
                    if target_id is None:
                        print("  [FAIL  ] " + ident + " -- target item missing Id")
                        IMPORT_FAILED += 1
                        continue
                    body = _prep_write_body(si_remapped)
                    code, err = api_patch(
                        ent["path"] + "(" + str(target_id) + ")", body)
                    if code and 200 <= code < 300:
                        print("  [PATCH ] " + ident)
                        IMPORT_PATCHED += 1
                    else:
                        print("  [FAIL  ] " + ident
                              + " -- PATCH HTTP " + str(code) + ": " + str(err)[:160])
                        IMPORT_FAILED += 1
                else:
                    print("  [SKIP  ] " + ident
                          + " (additive-only: target already has a match)")
                    IMPORT_SKIPPED += 1

        # Mirror: delete target-only items so target ends up exactly like source.
        if strategy == "mirror":
            for mk, ti in target_by_key.items():
                if mk in source_keys:
                    continue
                target_id = ti.get("Id")
                if target_id is None:
                    continue
                ident = ent["name_of"](ti)
                code, err = api_delete(ent["path"] + "(" + str(target_id) + ")")
                if code and 200 <= code < 300:
                    print("  [DELETE] " + ident)
                    IMPORT_DELETED += 1
                else:
                    print("  [FAIL  ] " + ident
                          + " -- DELETE HTTP " + str(code) + ": " + str(err)[:160])
                    IMPORT_FAILED += 1
        print()

    print("======")
    print("Import summary: "
          + str(IMPORT_CREATED) + " created, "
          + str(IMPORT_PATCHED) + " patched, "
          + str(IMPORT_DELETED) + " deleted, "
          + str(IMPORT_SKIPPED) + " skipped, "
          + str(IMPORT_FAILED)  + " failed.")
    if IMPORT_FAILED > 0:
        # Non-zero exit so the per-host card flips red — the operator sees
        # which systems still need attention without scanning every log.
        sys.exit(2)
    sys.exit(0)


# ---------- Endpoint discovery (probe mode only) ----------
# The 3CX xAPI is OData v4, so GET /xapi/v1/ returns a "service document"
# listing every entity set available on this PBX version. We use it to
# discover endpoints beyond the ones we explicitly catalogue (Trunks /
# Users) so the operator gets a full picture of what's batch-modifiable.
#
# For each discovered set that ISN'T already in our ENTITIES dict we fetch
# a sample item ($top=1) and walk it with the same recursive printer.
# Anything Trunks/Users gets is still printed below by the normal loop.
#
# Failure modes handled inline:
#   • Some entity sets require special scopes — those 401/403 and we just
#     note "(access denied)" without aborting the whole run.
#   • Some sets are empty on a fresh PBX — "(no items)".
#   • $top isn't universally honored by every entity set; if the response
#     is shaped weirdly we just skip that one with a one-line note.
if mode == "probe":
    # Fast per-request urlopen for probe — most 404/timeout endpoints are
    # report/stats variants that don't exist on every PBX, so we shouldn't
    # block for 30 seconds on each. 4-second timeout keeps a probe of all
    # 100+ entity sets under a minute even if many are slow/missing.
    def fast_get(path, t=4):
        req = Request(HOST + path)
        req.add_header("Authorization", "Bearer " + TOKEN)
        return json.loads(urlopen(req, context=ctx, timeout=t).read())

    # Scope: if the operator added panels (ACTIVE_ENTITY_KEYS is non-empty
    # and not the full fallback set), probe only those. Otherwise probe
    # everything 3CX advertises on /xapi/v1/. This makes a typical 1-panel
    # probe seconds instead of a minute.
    _have_panels = bool(ACTIVE_ENTITY_KEYS) and ACTIVE_ENTITY_KEYS != set(ENTITIES.keys()) | {
        (e.get("key") or "").strip()
        for e in (CONFIG.get("extras") or [])
        if (e.get("key") or "").strip()
    }
    if _have_panels:
        print("==============================")
        print(" Probe (scoped to " + str(len(ACTIVE_ENTITY_KEYS)) + " selected panel"
              + ("" if len(ACTIVE_ENTITY_KEYS) == 1 else "s") + ")")
        print("==============================")
        print("  Tip: remove all panels to probe every endpoint instead.")
        print()
    else:
        print("==============================")
        print(" Endpoint discovery (all entities)")
        print("==============================")
        print("  Tip: add panels first to scope probe to only those entities.")
        print()
    try:
        svc = fast_get("/xapi/v1/", t=8)
        sets = svc.get("value") or []
        # Each entry: {"name": "Trunks", "kind": "EntitySet", "url": "Trunks"}
        # Singletons / function imports are kept for visibility but only
        # EntitySets are probed (the others don't return collections).
        entity_sets = [s for s in sets
                       if str(s.get("kind", "EntitySet")) == "EntitySet"
                       and s.get("name")]
        other_kinds = [s for s in sets if s not in entity_sets]

        all_names = sorted(s["name"] for s in entity_sets)
        already   = {ent["path"].rsplit("/", 1)[-1] for ent in ENTITIES.values()}
        new_sets  = [s for s in entity_sets if s["name"] not in already]

        # If panels were selected, narrow new_sets down to just the ones
        # whose endpoint matches a configured ACTIVE_ENTITY_KEY's path.
        if _have_panels:
            _active_paths = {
                ENTITIES[k]["path"].rsplit("/", 1)[-1]
                for k in ACTIVE_ENTITY_KEYS if k in ENTITIES
            }
            new_sets = [s for s in new_sets if s["name"] in _active_paths]
            # Also skip the full listing — operator already knows what
            # they're probing.
        else:
            print("  Found " + str(len(entity_sets)) + " entity set"
                  + ("" if len(entity_sets) == 1 else "s")
                  + " on /xapi/v1/:")
            # Print 6 per line so the list stays scannable.
            line, width = [], 0
            for n in all_names:
                chunk = n + ("  (catalogued)" if n in already else "")
                if width and width + len(chunk) + 2 > 90:
                    print("    " + ", ".join(line))
                    line, width = [], 0
                line.append(chunk); width += len(chunk) + 2
            if line:
                print("    " + ", ".join(line))

            if other_kinds:
                print("  (also: " + ", ".join(
                    str(s.get("name", "?")) + " [" + str(s.get("kind", "?")) + "]"
                    for s in other_kinds
                ) + ")")
            print()

        for s in new_sets:
            name = s["name"]
            url  = s.get("url") or name
            print("  --- " + name + " (/xapi/v1/" + url + ") ---")
            try:
                # Try $top=1 first; fall back to no $top if the server
                # rejects the query option.
                try:
                    coll = fast_get("/xapi/v1/" + url + "?$top=1")
                except HTTPError as he:
                    if he.code in (400, 501):
                        coll = fast_get("/xapi/v1/" + url)
                    else:
                        raise
                d_items = coll.get("value") if isinstance(coll, dict) else None
                if d_items is None:
                    # Singleton-ish payload — treat the whole response as
                    # the sample.
                    if isinstance(coll, dict) and coll:
                        for k in sorted(coll.keys()):
                            if k.startswith("@odata"):
                                continue
                            walk_sample(k, coll[k], 0)
                    else:
                        print("    (response not a collection, no fields)")
                elif not d_items:
                    print("    (no items — entity set is empty on this PBX)")
                else:
                    sample = d_items[0]
                    if not isinstance(sample, dict):
                        print("    (sample item is " + type(sample).__name__
                              + ", not an object — nothing to walk)")
                    else:
                        for k in sorted(sample.keys()):
                            walk_sample(k, sample[k], 0)
            except HTTPError as he:
                if he.code in (401, 403):
                    print("    (access denied — HTTP " + str(he.code) + ")")
                elif he.code == 404:
                    print("    (not available — HTTP 404)")
                else:
                    print("    (HTTP " + str(he.code) + " error)")
            except URLError as ue:
                print("    (network error: " + str(ue.reason) + ")")
            except socket.timeout:
                print("    (timeout — endpoint took >4s; skipped)")
            except Exception as e:
                print("    (probe failed: " + str(e)[:120] + ")")
            print()
    except Exception as e:
        print("  ERROR: could not fetch /xapi/v1/ service document: "
              + str(e))
        print("  (falling back to the catalogued entities only)")
        print()


for key, ent in ENTITIES.items():
    # Operator removed this panel? Skip entirely (no GET, no audit, no
    # probe-second-pass) so removing Trunks/Users actually excludes them
    # from the run regardless of mode.
    if key not in ACTIVE_ENTITY_KEYS:
        continue
    targets = CONFIG.get(key) or []
    # Skip this entity entirely if there's nothing to do AND we don't need
    # to probe it.
    if not targets and mode == "apply" and not probe_first:
        continue

    print("==============================")
    print(" " + ent["label"])
    print("==============================")

    # Optional $expand — 3CX hides nested objects unless they're explicitly
    # expanded in the OData query. Operator sets this per-panel in the UI.
    # If the expand string is invalid for this entity (3CX returns 400 Bad
    # Request when the navigation property doesn't exist), retry without
    # the expand and warn so probe/audit/apply still succeeds.
    _expand = ENTITY_EXPANDS.get(key, "").strip()
    _expand_qs = ("?$expand=" + _expand) if _expand else ""

    def _fetch_items(path):
        # Handle both collection responses ({"value":[...]}) and singleton
        # responses (plain object with no "value" key — e.g. PhonesSettings,
        # MailSettings, NotificationSettings). Singletons get wrapped as a
        # one-item list so the downstream probe/audit/apply code Just Works.
        resp = api_get(path)
        if isinstance(resp, dict) and "value" in resp:
            return resp.get("value") or [], False
        flat = {k: v for k, v in (resp or {}).items() if not k.startswith("@")}
        return ([flat] if flat else []), True

    try:
        items, is_singleton = _fetch_items(ent["path"] + _expand_qs)
    except HTTPError as he:
        if _expand and he.code == 400:
            print("  WARNING: $expand='" + _expand + "' rejected by 3CX (400 Bad Request). "
                  "Retrying without expand. Try a different navigation property "
                  "or clear the $expand field for this entity.")
            try:
                items, is_singleton = _fetch_items(ent["path"])
            except Exception as e2:
                print("  ERROR: could not fetch " + ent["path"] + ": " + str(e2))
                print()
                continue
        else:
            print("  ERROR: could not fetch " + ent["path"] + _expand_qs + ": HTTP " + str(he.code))
            print()
            continue
    except Exception as e:
        print("  ERROR: could not fetch " + ent["path"] + _expand_qs + ": " + str(e))
        print()
        continue

    # Per-entity item filter (if any). We do this BEFORE probe / audit /
    # apply so the per-item lines below only cover what the operator
    # asked for, and the summary counts at the bottom are honest. The
    # filter intentionally leaves the entity-level "skip" predicate
    # untouched (so disabled users / bridge trunks are still skipped on
    # top of the filter).
    _flt = ENTITY_FILTERS.get(key)
    if _flt is not None:
        spec_disp = str(_raw_filters.get(key, ""))
        identity_of = ent.get("identity_of") or (lambda _i: "")
        before = len(items)
        items = [it for it in items if _flt(identity_of(it))]
        if not items:
            print("  (no " + key + " matched filter '" + spec_disp
                  + "' — checked " + str(before) + ")")
            print()
            continue
        print("  filter '" + spec_disp + "' matched "
              + str(len(items)) + " of " + str(before) + " " + key)

    if not items:
        print("  (no " + key + " found)")
        print()
        continue

    # Probe: dump every leaf field on a sample item, fully expanded with
    # dotted paths (e.g. Gateway.DeliverAudio) so the operator can copy
    # any path straight into a Custom field row.
    if mode == "probe" or probe_first:
        # Pick the most interesting sample for SipDevices specifically:
        # the 3CX "System" virtual device (Id=1, Registrar.Model='System')
        # is useless for finding real phone config. Skip it in favour of a
        # registered phone. Only applies when the entity HAS a Registrar
        # field — Users / PhoneTemplates / etc. don't and aren't placeholders.
        def _is_system_placeholder(it):
            if not isinstance(it, dict):
                return False
            reg = it.get("Registrar")
            if not isinstance(reg, dict):
                return False
            model = str(reg.get("Model", "") or "").strip()
            return model.lower() == "system"

        real_items = [it for it in items if not _is_system_placeholder(it)]
        sample_pool = real_items or items
        sample = sample_pool[0]
        total = len(items)
        skipped = total - len(real_items)
        if skipped > 0:
            print("  (skipped " + str(skipped) + " 'System' placeholder item"
                  + ("" if skipped == 1 else "s") + "; sampling a real one)")
        if is_singleton:
            print("  Singleton — full object:")
        else:
            print("  Available fields on first item (1 of "
                  + str(total) + ", sample recursive):")
        for k in sorted(sample.keys()):
            walk_sample(k, sample[k], 0)
        # Also surface any UNIQUE keys present on other items but absent on
        # the sample — these are the fields that vary per-instance and are
        # easy to miss otherwise.
        if not is_singleton and len(items) > 1:
            sample_keys = set(sample.keys())
            extra_keys = set()
            for it in items[1:6]:        # peek at up to 5 more
                if isinstance(it, dict):
                    extra_keys |= (set(it.keys()) - sample_keys)
            if extra_keys:
                print("  Additional fields seen on other items: "
                      + ", ".join(sorted(extra_keys)))
        print()
        if mode == "probe":
            continue

    # Audit mode: read-only — report per-item PASS / FAIL, with a multi-line
    # breakdown for failures so each problem field is easy to spot. The
    # script as a whole exits non-zero when ANY audit fails so the per-host
    # card in the UI flips red, exactly like the apply path would.
    if mode == "audit":
        pass_count = fail_count = 0
        for item in items:
            name = str(ent["name_of"](item))
            if ent["skip"](item):
                print("  [SKIP] " + name)
                continue
            AUDIT_TOTAL_ITEMS += 1
            ok_fields  = []      # list of (field, current_value) — already correct
            bad_fields = []      # list of (field, current, expected) — wrong value
            missing    = []      # list of field — not present on this 3CX version
            for tgt in targets:
                field = (tgt.get("field") or "").strip()
                if not field:
                    continue
                want = tgt.get("value")
                if _has_wildcard(field):
                    # Array path (e.g. Phones.*.Codecs) — check the field
                    # on every element of the array; the audit passes only
                    # if every element already matches.
                    vals = get_nested_with_array(item, field)
                    if vals is _NF:
                        missing.append(field)
                    elif not vals:
                        # Empty array (user has no phones) — nothing to audit
                        # but not an error either.
                        ok_fields.append((field, "(empty array)"))
                    elif all(v is not _NF and v == want for v in vals):
                        ok_fields.append((field, vals[0]))
                    else:
                        # Show the first mismatched value for the per-line
                        # log; full array of values would be too verbose.
                        first_bad = next((v for v in vals if v is _NF or v != want), vals[0])
                        bad_fields.append((field, first_bad, want))
                    continue
                cur  = get_nested(item, field)
                if cur is _NF:
                    missing.append(field)
                elif cur == want:
                    ok_fields.append((field, cur))
                else:
                    bad_fields.append((field, cur, want))

            total_checked = len(ok_fields) + len(bad_fields) + len(missing)

            if not bad_fields and not missing:
                # Passing items are deliberately NOT printed — only failures
                # are interesting in an audit log. The per-entity rollup and
                # final banner still report the pass count so the operator
                # knows how much was checked.
                pass_count += 1
            else:
                # Multi-line breakdown — one indented line per failed field so
                # the operator can scan a fleet log for what specifically broke.
                n_problems = len(bad_fields) + len(missing)
                problems_summary = []
                if bad_fields: problems_summary.append(str(len(bad_fields)) + " mismatch")
                if missing:    problems_summary.append(str(len(missing)) + " missing")
                print("  [FAIL] " + name + "  -- "
                      + " + ".join(problems_summary)
                      + " of " + str(total_checked) + " field"
                      + ("" if total_checked == 1 else "s") + " checked:")
                for f, c, w in bad_fields:
                    print("           x  " + f
                          + ": got " + repr(c) + ", expected " + repr(w))
                for f in missing:
                    print("           ?  " + f
                          + ": FIELD NOT FOUND on this 3CX version")
                if ok_fields:
                    print("           (" + str(len(ok_fields))
                          + " already correct: "
                          + ", ".join(f for f, _ in ok_fields) + ")")
                fail_count += 1
                AUDIT_FAILED_ITEMS  += 1
                AUDIT_FAILED_FIELDS += n_problems

        # Per-entity summary — tags FAIL prominently when anything went wrong
        # so a quick eyeball scan of a long fleet log lights up the problems.
        print("")
        if fail_count == 0:
            print("  " + ent["label"] + " audit: PASS (" + str(pass_count)
                  + " item" + ("" if pass_count == 1 else "s") + " match)")
        else:
            print("  " + ent["label"] + " audit: FAIL ("
                  + str(fail_count) + " item"
                  + ("" if fail_count == 1 else "s")
                  + " with problems, " + str(pass_count) + " clean)")
        print("")
        continue

    # Apply mode
    ok = patched = failed = 0

    # Optional "clone from source" — fetch one reference item and use its
    # field values instead of the catalog defaults. Lets the operator
    # configure ONE extension via the 3CX web UI and replicate to many.
    # When `targets_all_items` includes the unfiltered set, we look up the
    # source there so the source itself doesn't need to be in the target
    # filter.
    _all_items_for_clone = None
    _clone_source_item = None
    if CLONE_SOURCES.get(key):
        # Re-fetch the unfiltered collection so the source can be anywhere,
        # even outside the operator's "Apply to items" filter.
        try:
            _all_resp = api_get(ent["path"] + _expand_qs)
            if isinstance(_all_resp, dict) and "value" in _all_resp:
                _all_items_for_clone = _all_resp.get("value") or []
            else:
                # Singleton — clone doesn't apply meaningfully.
                _all_items_for_clone = items
        except Exception as _e:
            print("  [warn] couldn't re-fetch for clone source: " + str(_e))
            _all_items_for_clone = items
        _clone_source_item = _resolve_clone_source(key, ent, _all_items_for_clone)
        if _clone_source_item is not None:
            print("  cloning from source: "
                  + str(ent["name_of"](_clone_source_item)))

    for item in items:
        name = str(ent["name_of"](item))
        if ent["skip"](item):
            print("  [" + name + "]  SKIPPED")
            continue
        # Don't clone the source onto itself (no-op, and the audit-style
        # equality check would skip it anyway, but the log line is cleaner).
        if _clone_source_item is not None and item is _clone_source_item:
            print("  [" + name + "]  SKIPPED (this is the clone source)")
            continue

        changes  = {}
        notes    = []
        missing  = []
        # Group array-path targets (e.g. Phones.*.Codecs) by their array
        # prefix so we can emit ONE collection-replace patch per array
        # instead of N partial patches that 3CX would reject.
        array_groups = {}    # {array_prefix: [(path, value), ...]}
        flat_targets = []
        for tgt in targets:
            field = (tgt.get("field") or "").strip()
            if not field:
                continue
            # Override the catalog value with the source's actual value
            # when clone-from is active. For wildcard paths, the source
            # value is read with get_nested_with_array — but the result
            # is a list of per-element values, which we collapse to the
            # first element since 3CX's collection-replace semantics
            # apply the same value to every element on the TARGET. Most
            # users have one phone, so this is what the operator wants.
            value = tgt.get("value")
            if _clone_source_item is not None:
                if _has_wildcard(field):
                    src_vals = get_nested_with_array(_clone_source_item, field)
                    if src_vals is not _NF and src_vals:
                        # Prefer the first non-NF value; if all are NF,
                        # fall through to the catalog value.
                        for v in src_vals:
                            if v is not _NF:
                                value = v
                                break
                else:
                    src_val = get_nested(_clone_source_item, field)
                    if src_val is not _NF:
                        value = src_val
            if _has_wildcard(field):
                prefix = ".".join(field.split(".")[:field.split(".").index("*")])
                array_groups.setdefault(prefix, []).append((field, value))
            else:
                flat_targets.append((field, value))

        # Flat-path targets: original behaviour.
        for field, want in flat_targets:
            cur = get_nested(item, field)
            if cur is _NF:
                missing.append(field)
                continue
            if cur == want:
                continue
            merge_into(changes, build_patch(field, want))
            notes.append(field + ": " + repr(cur) + " -> " + repr(want))

        # Array-path targets: build one collection-replace patch per array.
        for prefix, group in array_groups.items():
            cur_array = get_nested(item, prefix)
            if cur_array is _NF or not isinstance(cur_array, list):
                # The whole array is missing from GET. 3CX may still
                # accept a PATCH that creates it, but without an existing
                # array we don't know the element schema — bail.
                for path, _ in group:
                    missing.append(path)
                continue
            if not cur_array:
                # Empty array (user has no phones) — nothing to patch.
                continue
            # If 3CX hasn't returned the target field on any element
            # (common when the value is at the default — 3CX omits it
            # from GET but accepts it on PATCH), still send the write.
            # The audit will continue to flag this as "missing", but the
            # operator's explicit Apply means they want the value set.
            already_ok = True
            for path, want in group:
                vals = get_nested_with_array(item, path)
                # vals is _NF means field absent on every element. That's
                # NOT a reason to skip apply — we'll write it anyway.
                if vals is _NF or any(v is _NF or v != want for v in (vals or [])):
                    already_ok = False
                    break
            if already_ok:
                continue
            patch_body, _applied, _miss = build_array_patches(item, group)
            if patch_body:
                merge_into(changes, patch_body)
                # Concise per-change note. Show "(missing)" when the
                # field wasn't in GET so the operator knows the value
                # is being set for the first time, not updated.
                for path, want in group:
                    vals = get_nested_with_array(item, path)
                    if vals is _NF:
                        notes.append(path + ": (missing) -> " + repr(want))
                    else:
                        notes.append(path + " -> " + repr(want))

        if not changes:
            if missing:
                print("  [" + name + "]  FIELDS NOT FOUND: " + ", ".join(missing))
                failed += 1
            else:
                print("  [" + name + "]  OK (no change needed)")
                ok += 1
            continue

        # Resolve any BLF XML in the patch body (adds the per-extension
        # and per-parking ID attributes 3CX requires for BLFs to actually
        # function — without these the PATCH succeeds with HTTP 204 but
        # the BLF keys render empty on the phone).
        _resolve_blfs_in_patch(changes)
        print("  [" + name + "]  patching " + "; ".join(notes) + " ... ",
              end="", flush=True)
        code, err = api_patch(ent["path"] + "(" + str(item.get("Id", "")) + ")", changes)
        if code in (200, 204):
            extra = ""
            if missing:
                extra = "  (FIELDS NOT FOUND: " + ", ".join(missing) + ")"
            print("OK" + extra)
            patched += 1
            # Queue this user's phones for reprovision if (a) the operator
            # opted in via the UI, (b) we're patching the Users entity, and
            # (c) at least one of the ticked targets was phone-resident.
            # We check the entity-level target list (not per-item notes) so
            # the decision is consistent across users — either every patched
            # user gets its phones reprovisioned, or none do.
            if (REPROVISION_AFTER_APPLY and key == "users"
                and any(_is_phone_affecting_field((t.get("field") or "").strip())
                        for t in targets)):
                for ph in (item.get("Phones") or []):
                    mac = ph.get("MacAddress")
                    if mac:
                        _MACS_TO_REPROVISION.add(str(mac).strip().upper())
        else:
            print("FAILED HTTP " + str(code) + ": " + err)
            failed += 1

    print("")
    print("  summary: " + str(ok) + " already correct, "
          + str(patched) + " patched, "
          + str(failed) + " failed")
    print("")


# Reprovision queued phones now that the Users entity is fully patched.
# We do this AFTER the per-entity loop (rather than inline per-user) so
# (a) every PATCH lands before the PBX re-renders provisioning files,
# avoiding two reprovisions in quick succession on multi-field changes,
# and (b) the log shows a clean grouped summary at the end instead of
# scattered reprovision lines interleaved with the per-user PATCH log.
# /xapi/v1/Users/Pbx.ReprovisionPhone is an OData action — POST
# {"mac": "<MAC>"} returns 204 No Content on success. We treat any 2xx
# as success; everything else is reported with the server's error body
# (trimmed) so the operator can see whether it's an unknown MAC, a
# stale phone, or a transient PBX hiccup.
if mode == "apply" and REPROVISION_AFTER_APPLY:
    if _MACS_TO_REPROVISION:
        print("==============================")
        print(" Reprovisioning phones (" + str(len(_MACS_TO_REPROVISION)) + ")")
        print("==============================")
        _repro_ok = 0
        _repro_fail = 0
        for _mac in sorted(_MACS_TO_REPROVISION):
            code, err = api_post("/xapi/v1/Users/Pbx.ReprovisionPhone",
                                 {"mac": _mac})
            if code and 200 <= code < 300:
                print("  [OK    ] " + _mac)
                _repro_ok += 1
            else:
                short_err = (err or "")[:160].replace("\n", " ")
                print("  [FAIL  ] " + _mac
                      + " -- HTTP " + str(code) + ": " + short_err)
                _repro_fail += 1
        print("")
        print("  reprovision summary: " + str(_repro_ok) + " ok, "
              + str(_repro_fail) + " failed")
        print("")
    else:
        print("(reprovision requested, but no phones were queued — either no "
              "User patches landed or no phone-resident fields were ticked)")
        print("")


# In audit mode, exit non-zero when ANY tested field on ANY non-skipped item
# didn't match the expected value (or wasn't found at all). The deployer's
# `require_marker=False` setting for the threecx action means the host card
# is driven purely by exit status — so this exit code is what flips the
# card red and surfaces the audit failure in the fleet summary.
if mode == "audit":
    if AUDIT_FAILED_ITEMS > 0:
        print("")
        print("==============================")
        print(" AUDIT FAILED")
        print("==============================")
        print("  " + str(AUDIT_FAILED_FIELDS) + " problem field"
              + ("" if AUDIT_FAILED_FIELDS == 1 else "s")
              + " across " + str(AUDIT_FAILED_ITEMS) + " item"
              + ("" if AUDIT_FAILED_ITEMS == 1 else "s")
              + " of " + str(AUDIT_TOTAL_ITEMS) + " audited")
        print("  (see [FAIL] lines above for specifics)")
        # Exit code 2: distinguishes "audit found mismatches" from
        # exit 1 (script error) and exit 0 (everything OK).
        sys.exit(2)
    else:
        print("")
        print("Audit PASS: every tested field on every audited item matches "
              "(" + str(AUDIT_TOTAL_ITEMS) + " item"
              + ("" if AUDIT_TOTAL_ITEMS == 1 else "s") + " checked).")

print("Done.")
PYEOF

# Honour python's exit status so the per-host card reflects success/failure.
rc=$?
unset THREECX_USERNAME THREECX_PASSWORD THREECX_CONFIG_B64 BSM_IMPORT_TMP
[ -n "$_BSM_IMPORT_TMP" ] && rm -f "$_BSM_IMPORT_TMP"
exit $rc
"""
    script = template.replace("__PW_DECL__", pw_decl)
    script = script.replace("__USERNAME__", quoted_user)
    script = script.replace("__CONFIG_B64__", config_b64)
    script = script.replace("__IMPORT_TMP_SETUP__", import_tmp_setup)
    return script



# --------------------------------------------------------------------------- #
# Quick diagnostic — portable read-only health snapshot
# --------------------------------------------------------------------------- #

def build_quick_diag_script() -> str:
    """
    Build a POSIX-sh diagnostic script that gathers a read-only health snapshot
    from any host.  Nothing is modified; the script always exits 0.

    Compatible with:
      * Debian / Ubuntu  (systemd, apt, /proc, free)
      * OpenBSD          (rcctl, pkg_add, sysctl vm.loadavg, vmstat)

    Use require_marker=False and interpreter="sh -s" when calling deploy_host.
    """
    return r"""#!/bin/sh
# ---------------------------------------------------------------
# Quick diagnostic - read-only health snapshot.
# Works on Debian/Ubuntu Linux and OpenBSD.  Always exits 0.
# ---------------------------------------------------------------
log()  { printf '[*] %s\n' "$*"; }
warn() { printf '[!] %s\n' "$*" >&2; }

log "=== $(hostname) ==="
log "Date     : $(date -u '+%Y-%m-%d %H:%M UTC')"
log "Uptime   : $(uptime 2>/dev/null | sed 's/^[[:space:]]*//')"

# OS identification
if [ -f /etc/os-release ]; then
    . /etc/os-release
    log "OS       : ${PRETTY_NAME:-${ID} ${VERSION_ID}}"
else
    log "OS       : $(uname -sr)"
fi

# Load average — /proc/loadavg on Linux, sysctl on OpenBSD
if [ -r /proc/loadavg ]; then
    log "Load     : $(cut -d' ' -f1-3 /proc/loadavg)"
else
    log "Load     : $(sysctl -n vm.loadavg 2>/dev/null || echo n/a)"
fi

# Disk usage (POSIX df -h works on both)
log "Disk /   : $(df -h / | awk 'NR==2{print $3"/"$2" ("$5" used)"}')"

# Memory — free(1) on Linux, vmstat on OpenBSD
if command -v free >/dev/null 2>&1; then
    log "Memory   : $(free -h | awk '/^Mem/{print $3"/"$2" used"}')"
else
    # OpenBSD vmstat: col 4 = free pages; rough indicator only
    log "Memory   : $(vmstat 2>/dev/null | awk 'NR==3{printf "free pages: %s", $4}' || echo n/a)"
fi

# heplify service status
if command -v systemctl >/dev/null 2>&1; then
    _svc=$(systemctl is-active heplify 2>/dev/null || echo 'unit not found')
    log "heplify  : ${_svc} (systemd)"
elif command -v rcctl >/dev/null 2>&1; then
    rcctl check heplify >/dev/null 2>&1 \
        && log "heplify  : running (rcctl)" \
        || log "heplify  : not running (rcctl)"
else
    pgrep -x heplify >/dev/null 2>&1 \
        && log "heplify  : running (process found)" \
        || log "heplify  : not found"
fi

# Reboot flag — Debian/Ubuntu only; harmless absence on other systems
if [ -f /var/run/reboot-required ]; then
    warn "REBOOT   : REQUIRED (kernel or library was updated)"
else
    log "REBOOT   : not required"
fi

# Pending package upgrades
if command -v apt-get >/dev/null 2>&1; then
    _pending=$(apt list --upgradable 2>/dev/null | grep -vc '^Listing' || echo '?')
    log "Pending upgrades (apt) : ${_pending}"
elif command -v pkg_info >/dev/null 2>&1; then
    # OpenBSD: count installable updates (dry-run; non-fatal)
    _pending=$(pkg_add -u -n 2>/dev/null | grep -c '^Update' || echo '?')
    log "Pending upgrades (pkg) : ${_pending}"
else
    log "Pending upgrades       : n/a"
fi

exit 0
"""


# --------------------------------------------------------------------------- #
# SSH execution
# --------------------------------------------------------------------------- #

def _get_interpreter(script: str) -> str:
    """
    Read the shebang line of *script* and return the shell invocation to use
    when piping the script over stdin (e.g. ``bash -s``).

    Recognised shebangs → interpreter:
      #!/bin/bash  /  #!/usr/bin/env bash  →  bash -s
      #!/bin/ksh   /  #!/usr/bin/env ksh   →  ksh  -s
      #!/bin/zsh   /  #!/usr/bin/env zsh   →  zsh  -s
      #!/bin/sh    /  anything else        →  sh   -s  (POSIX; works on Linux + OpenBSD)

    Built-in scripts (heplify deploy, apt upgrade) call this indirectly by
    passing ``interpreter="bash -s"`` explicitly.
    """
    first = script.lstrip().split("\n")[0] if script.strip() else ""
    if first.startswith("#!"):
        parts = first[2:].strip().split()
        name = parts[0].split("/")[-1]          # last path component of the executable
        if name == "env" and len(parts) > 1:    # #!/usr/bin/env bash
            name = parts[1].split("/")[-1]
        if name in {"bash", "ksh", "ksh93", "zsh", "dash"}:
            return f"{name} -s"
    return "sh -s"


def _make_client(strict: bool) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    # Load any previously-trusted hosts.
    try:
        client.load_system_host_keys()
    except Exception:
        pass
    if os.path.exists(KNOWN_HOSTS_PATH):
        try:
            client.load_host_keys(KNOWN_HOSTS_PATH)
        except Exception:
            pass
    if strict:
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
    else:
        # Trust-on-first-use: accept and persist unknown keys to a local file.
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    return client


def _sanitise_var_name(raw: str) -> str:
    """
    Convert a CSV column header into a shell-safe identifier.

    Rules:
      * non-[A-Za-z0-9_] characters → '_'   (so "Web Site" → "Web_Site")
      * leading digit gets a '_' prefix    (so "1pass" → "_1pass")
      * empty input returns ''             (caller should skip empties)

    Case is preserved verbatim so the column header in the CSV matches the
    variable name in the script — operators tend to expect `$foo` for a
    column literally named `foo`, not `$FOO`.
    """
    if not raw:
        return ""
    name = re.sub(r"[^A-Za-z0-9_]", "_", str(raw))
    if not name:
        return ""
    if name[0].isdigit():
        name = "_" + name
    return name


def _build_host_vars_prelude(host_vars: Dict[str, str]) -> str:
    """
    Build a POSIX-sh prelude that ``export``s each (column, value) pair as
    an environment variable. Caller prepends this to the user's script so
    the variables are visible to every command in it.

    Security: the caller is expected to have already filtered out columns
    that should NEVER be exposed (notably ``Password`` — letting it leak
    via ``env`` or a child process's environment is exactly the kind of
    accident we built this tool to avoid).

    Quoting: values are single-quoted with POSIX ``'`` → ``'\\''`` escaping,
    so any payload — including embedded quotes, newlines, $variables, and
    backticks — survives intact and is NOT re-interpreted by the shell.
    """
    if not host_vars:
        return ""
    lines = ["# --- per-host variables from compound CSV (auto-injected) ---"]
    seen = set()
    for raw_name, raw_val in host_vars.items():
        name = _sanitise_var_name(raw_name)
        if not name or name in seen:
            continue
        seen.add(name)
        val = "" if raw_val is None else str(raw_val)
        quoted = "'" + val.replace("'", "'\\''") + "'"
        lines.append(f"export {name}={quoted}")
    lines.append("# --- end per-host variables ---")
    return "\n".join(lines) + "\n"


def _exec_with_su(
    client: paramiko.SSHClient,
    script: str,
    interpreter: str,
    root_password: str,
    exec_timeout: int,
    log_callback=None,
) -> Tuple[str, int]:
    """
    Run *script* as root via ``su``, feeding root's password through a PTY
    while keeping the user's script body OFF the PTY entirely.

    Design (and the lessons that led here):

    ``su`` insists on reading the password from ``/dev/tty`` — a real
    controlling terminal — so the SSH channel must have a PTY allocated for
    su to talk to. That part is unavoidable.

    What ISN'T necessary is delivering the user's script over that same PTY.
    Doing so causes three different pain points:

      1. **Echo race.** The PTY's kernel-level line discipline echoes every
         byte we write straight back to the output side, BEFORE the spawned
         shell has had a chance to run ``stty -echo`` — so the user's
         script lines appear in the captured output no matter how quickly
         we try to suppress them.
      2. **Interactive shell.** ``bash -s`` with a TTY stdin decides it is
         interactive and prints ``#`` prompts.
      3. **``sudo`` inside the script hangs.** A ``sudo`` invocation reads
         its own password from ``/dev/tty``, which IS the same PTY su is
         using — so sudo sits there forever waiting for input that never
         comes, and the whole host card stays at "queued…".

    The fix: bake the entire script into the ``su -c`` argument via
    base64 (so arbitrary script content survives shell quoting), and
    pipe it into the interpreter through a real pipe::

        su -c 'printf %s <b64> | base64 -d | <interpreter>' root

    Now the script runs in a NON-TTY subshell whose stdin is the pipe.
    No echo, no interactive prompts, no ``sudo`` hangs. The PTY is only
    used for su's own password exchange.

    Returns (output, exit_status). Strips ``\\r`` and the visible
    ``Password:`` prompt. Authentication failure lines are kept verbatim
    so the operator sees why. The password itself is never echoed back
    (su disables tty echo while reading it).
    """
    import base64
    import time

    transport = client.get_transport()
    if transport is None:
        raise RuntimeError("SSH transport closed unexpectedly")

    chan = transport.open_session(timeout=exec_timeout)
    chan.settimeout(exec_timeout)
    # PTY MUST be requested before exec_command. Modest size avoids weird
    # terminal-width artefacts in any output that DOES come through the PTY
    # (in practice only su's "Password:" prompt + any preflight banners).
    chan.get_pty(term="dumb", width=200, height=50)

    # Encode the script so it survives shell quoting intact regardless of
    # whatever quotes / backslashes / newlines / non-ASCII chars it
    # contains. base64 output is shell-safe (A–Za–z0–9+/=) so single-
    # quoting the inner command is sufficient.
    encoded = base64.b64encode(script.encode("utf-8")).decode("ascii")
    # `printf %s` (no trailing newline) is more portable than `echo -n`
    # across shells. `base64 -d` is in coreutils (Debian) and OpenBSD base.
    inner = f"printf %s {encoded} | base64 -d | {interpreter}"
    su_cmd = f"su -c '{inner}' root"
    chan.exec_command(su_cmd)

    # ---- 1. Wait for the password prompt -----------------------------------
    # `su` prints "Password:" (no newline) and then blocks on /dev/tty.
    # Some locales / distros may print "password:" lowercase or
    # "Password for root:" — match all the common shapes.
    prompt_buf = bytearray()
    prompt_deadline = time.time() + min(15, exec_timeout)
    saw_prompt = False
    while time.time() < prompt_deadline:
        if chan.recv_ready():
            try:
                prompt_buf += chan.recv(4096)
            except socket.timeout:
                break
            low = bytes(prompt_buf).lower()
            if b"password:" in low or b"password for" in low:
                saw_prompt = True
                break
        elif chan.exit_status_ready():
            # su gave up before prompting — usually "su: must be run from a
            # terminal" (no PTY) or a config / PAM error. Drain everything.
            while chan.recv_ready():
                try:
                    prompt_buf += chan.recv(4096)
                except socket.timeout:
                    break
            break
        else:
            time.sleep(0.05)

    if not saw_prompt:
        rc = chan.recv_exit_status() if chan.exit_status_ready() else -1
        text = bytes(prompt_buf).decode("utf-8", errors="replace").replace("\r", "").strip()
        return (text or "su did not prompt for a password within 15s", rc if rc != -1 else 97)

    # ---- 2. Send the root password ----------------------------------------
    # Always followed by exactly one newline. su consumes one line; what
    # comes next goes to the spawned shell, but our spawned shell is
    # running a self-contained `printf | base64 -d | <interp>` pipeline
    # that gets ALL its input from the pipe — it never reads from the PTY,
    # so any stray bytes we sent here would be ignored anyway.
    chan.sendall((root_password + "\n").encode("utf-8"))

    # ---- 3. Drain output until EOF/exit -----------------------------------
    out = bytearray(prompt_buf)  # the "Password:" prompt is filtered later
    _line_buf = ""               # partial line accumulator for log_callback
    drain_deadline = time.time() + exec_timeout
    while time.time() < drain_deadline:
        if chan.recv_ready():
            try:
                chunk = chan.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            out += chunk
            # Emit complete lines to log_callback in real-time.
            if log_callback and chunk:
                _line_buf += chunk.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
                while "\n" in _line_buf:
                    nl = _line_buf.index("\n")
                    line = _line_buf[:nl]
                    _line_buf = _line_buf[nl + 1:]
                    s = line.strip()
                    if s in ("Password:", "password:") or s.lower().startswith("password for "):
                        continue
                    try:
                        log_callback(line)
                    except Exception:
                        pass
        elif chan.exit_status_ready():
            # Final drain to grab anything that arrived between checks.
            while chan.recv_ready():
                try:
                    chunk = chan.recv(65536)
                except socket.timeout:
                    break
                if not chunk:
                    break
                out += chunk
                if log_callback and chunk:
                    _line_buf += chunk.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
            break
        else:
            time.sleep(0.05)
    # Flush any trailing partial line.
    if log_callback and _line_buf.strip():
        s = _line_buf.strip()
        if s not in ("Password:", "password:") and not s.lower().startswith("password for "):
            try:
                log_callback(_line_buf.rstrip("\r\n"))
            except Exception:
                pass

    exit_status = chan.recv_exit_status()

    # ---- 4. Clean the output ----------------------------------------------
    # The PTY adds \r before \n on its half of the conversation (the
    # "Password:" prompt). The script's own output came through a pipe and
    # has no such artefact. Normalise CRs, then drop only the prompt line.
    text = bytes(out).decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    cleaned_lines = []
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped in ("Password:", "password:"):
            continue
        if stripped.lower().startswith("password for "):
            continue
        cleaned_lines.append(line)
    return "\n".join(cleaned_lines).strip(), exit_status


def check_auth(target: Target, password: str, cfg: DeployConfig):
    """
    Connect-only SSH auth test for *target*. Returns ``(ok, error)`` — no
    command is run. Lets the UI verify credentials before preparing an action.
    """
    if not password:
        return (False, "no password available for this host")
    client = _make_client(cfg.strict_host_keys)
    try:
        client.connect(
            hostname=target.host,
            port=target.port,
            username=target.user,
            password=password,
            timeout=cfg.connect_timeout,
            banner_timeout=cfg.connect_timeout,
            auth_timeout=cfg.connect_timeout,
            allow_agent=False,
            look_for_keys=False,
        )
        if not cfg.strict_host_keys:
            try:
                client.save_host_keys(KNOWN_HOSTS_PATH)
            except Exception:
                pass
        return (True, "")
    except paramiko.AuthenticationException:
        return (False, "authentication failed")
    except (paramiko.SSHException, socket.timeout, socket.error, OSError) as e:
        return (False, f"connection error: {e}")
    except Exception as e:  # noqa: BLE001 - last-resort guard
        return (False, f"unexpected error: {e}")
    finally:
        try:
            client.close()
        except Exception:
            pass


def deploy_host(
    target: Target,
    password: str,
    script: str,
    cfg: DeployConfig,
    *,
    interpreter: str = "bash -s",
    require_marker: bool = True,
    success_text: str = "done",
    root_password: str = "",
    host_vars: Optional[Dict[str, str]] = None,
    log_callback=None,
) -> HostResult:
    """
    Run *script* on a single host via SSH. Never logs the password.

    interpreter    Shell invocation used when piping the script over stdin.
                   Built-in scripts use ``bash -s``; custom user scripts have
                   their interpreter auto-detected from the shebang (see
                   ``_get_interpreter``).  Use ``sh -s`` for POSIX/OpenBSD compat.

    require_marker If True (default for built-in scripts), the result is only
                   considered successful when the script exits 0 AND prints the
                   ``DEPLOY_RESULT=success`` sentinel.  Set to False for custom
                   user scripts that don't emit the sentinel.

    success_text   Human-readable label shown in the result card on success.

    root_password  Optional. When set, the script runs as **root** via
                   ``su -c '<interpreter>' root`` on a PTY-allocated channel
                   (see ``_exec_with_su``). Used by the Custom Script action
                   when the operator supplies a root password to escalate
                   from a non-root SSH user. Leave empty to run the script
                   directly as the SSH login user.
    """
    import time
    start = time.time()
    if not password:
        return HostResult(target.label, False, "auth",
                          "no password available for this host", duration_s=0.0)

    client = _make_client(cfg.strict_host_keys)
    try:
        client.connect(
            hostname=target.host,
            port=target.port,
            username=target.user,
            password=password,
            timeout=cfg.connect_timeout,
            banner_timeout=cfg.connect_timeout,
            auth_timeout=cfg.connect_timeout,
            allow_agent=False,
            look_for_keys=False,
        )
    except paramiko.AuthenticationException:
        return HostResult(target.label, False, "auth", "authentication failed",
                          duration_s=time.time() - start)
    except (paramiko.SSHException, socket.timeout, socket.error, OSError) as e:
        return HostResult(target.label, False, "connect", f"connection error: {e}",
                          duration_s=time.time() - start)
    except Exception as e:  # noqa: BLE001 - last-resort guard
        return HostResult(target.label, False, "connect", f"unexpected error: {e}",
                          duration_s=time.time() - start)

    # Persist host key learned via TOFU.
    if not cfg.strict_host_keys:
        try:
            client.save_host_keys(KNOWN_HOSTS_PATH)
        except Exception:
            pass

    # ---- Per-host environment-variable injection -------------------------
    # When the operator supplied a Compound CSV with extra columns, each
    # row's column values become $variables visible to the user's script.
    # We prepend `export NAME='VAL'` lines to the script body — taking care
    # to keep any shebang as the literal first line so an output dump still
    # looks like a normal script.
    # RouterOS has no POSIX shell, so the `export NAME='VAL'` prelude is
    # meaningless there — skip it (RouterOS scripts read CSV columns, if at
    # all, by other means).
    if host_vars and interpreter != "routeros":
        prelude = _build_host_vars_prelude(host_vars)
        if prelude:
            if script.startswith("#!"):
                nl = script.find("\n")
                if nl == -1:
                    script = script + "\n" + prelude
                else:
                    script = script[: nl + 1] + prelude + script[nl + 1 :]
            else:
                script = prelude + script

    try:
        # ---- RouterOS (MikroTik) path -----------------------------------------
        # RouterOS lands you in its own console over SSH — there is no `sh`,
        # no `su`, no POSIX env. Piping to `sh -s` fails with
        # "bad command name sh". Instead we run the script text directly as
        # console command(s) and read the result back.
        if interpreter == "routeros":
            stdin, stdout, stderr = client.exec_command(script, timeout=cfg.exec_timeout)
            stdout.channel.set_combine_stderr(True)
            chan = stdout.channel
            chan.settimeout(cfg.exec_timeout)
            ros_chunks: List[str] = []
            try:
                for raw in stdout:
                    line = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
                    line = line.rstrip("\r\n")
                    ros_chunks.append(line + "\n")
                    if log_callback:
                        try:
                            log_callback(line)
                        except Exception:
                            pass
            except socket.timeout:
                return HostResult(target.label, False, "exec",
                                  f"command timed out after {cfg.exec_timeout}s",
                                  output="".join(ros_chunks),
                                  duration_s=time.time() - start)
            exit_status = chan.recv_exit_status()
            output = "".join(ros_chunks).strip()
            low = output.lower()
            ros_err = ("bad command name" in low or "syntax error" in low
                       or "expected end of command" in low
                       or "expected command name" in low)
            ok = (exit_status == 0) and not ros_err
            msg = success_text if ok else f"RouterOS command failed (exit {exit_status})"
            return HostResult(target.label, ok, "done" if ok else "exec", msg,
                              exit_status=exit_status, output=output,
                              duration_s=time.time() - start)

        if root_password:
            # ---- Root-escalation path via su + PTY ----------------------------
            try:
                output, exit_status = _exec_with_su(
                    client, script, interpreter, root_password, cfg.exec_timeout,
                    log_callback=log_callback,
                )
            except socket.timeout:
                return HostResult(target.label, False, "exec",
                                  f"command timed out after {cfg.exec_timeout}s",
                                  duration_s=time.time() - start)
            # Surface auth failure as a dedicated error category so the UI can
            # show "auth" instead of a generic exec failure.
            auth_failed = ("authentication failure" in output.lower()
                           or "su: incorrect password" in output.lower())
            if auth_failed:
                return HostResult(target.label, False, "auth",
                                  "root password rejected by su",
                                  exit_status=exit_status, output=output,
                                  duration_s=time.time() - start)
            marker_present = "DEPLOY_RESULT=success" in output
            ok = (exit_status == 0) and (marker_present if require_marker else True)
            if ok:
                msg = success_text + " (as root via su)"
            elif exit_status == 0 and require_marker and not marker_present:
                msg = "exited 0 but success marker missing"
            else:
                msg = f"script exited {exit_status} (su path)"
            return HostResult(target.label, ok, "done" if ok else "exec", msg,
                              exit_status=exit_status, output=output,
                              duration_s=time.time() - start)

        # ---- Normal (non-root-escalated) path ---------------------------------
        # Pipe the script via stdin so nothing touches argv/process list.
        stdin, stdout, stderr = client.exec_command(interpreter, timeout=cfg.exec_timeout)
        # Merge stderr into stdout so we stream both channels in one pass.
        stdout.channel.set_combine_stderr(True)
        stdin.write(script)
        stdin.channel.shutdown_write()

        chan = stdout.channel
        chan.settimeout(cfg.exec_timeout)
        out_chunks: List[str] = []
        try:
            # Read line-by-line so log_callback gets each line as it arrives
            # rather than everything in one burst when the script finishes.
            # Paramiko's ChannelFile.__iter__ calls readline() which unblocks
            # as soon as a '\n' is received from the remote side.
            for raw in stdout:
                # Paramiko ChannelFile yields bytes by default but some
                # builds / wrappers return str — handle both.
                if isinstance(raw, bytes):
                    line = raw.decode("utf-8", errors="replace")
                else:
                    line = raw
                line = line.rstrip("\r\n")
                out_chunks.append(line + "\n")
                if log_callback:
                    try:
                        log_callback(line)
                    except Exception:
                        pass
        except socket.timeout:
            return HostResult(target.label, False, "exec",
                              f"command timed out after {cfg.exec_timeout}s",
                              output="".join(out_chunks),
                              duration_s=time.time() - start)

        exit_status = chan.recv_exit_status()
        output = "".join(out_chunks).strip()
        marker_present = "DEPLOY_RESULT=success" in output
        ok = (exit_status == 0) and (marker_present if require_marker else True)
        if ok:
            msg = success_text
        elif exit_status == 0 and require_marker and not marker_present:
            msg = "exited 0 but success marker missing"
        else:
            msg = f"script exited {exit_status}"
        return HostResult(target.label, ok, "done" if ok else "exec", msg,
                          exit_status=exit_status, output=output,
                          duration_s=time.time() - start)
    except Exception as e:  # noqa: BLE001
        return HostResult(target.label, False, "exec", f"execution error: {e}",
                          duration_s=time.time() - start)
    finally:
        try:
            client.close()
        except Exception:
            pass
