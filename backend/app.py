"""
app.py — local web UI for the heplify fleet deployer.

Run:
    pip install -r requirements.txt
    python app.py
    # open http://127.0.0.1:8765

The server binds to 127.0.0.1 by default (localhost only). Do not expose it to a
network without putting authentication in front of it — it accepts credential
uploads.
"""

from __future__ import annotations

import base64
import json
import os
import queue as _queue_mod
import re
import subprocess
import sys
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from typing import Dict, List

from flask import (
    Flask,
    Response,
    abort,
    jsonify,
    render_template,
    request,
    send_from_directory,
    stream_with_context,
)

# Optional dep: cryptography. Only required for the encrypted-CSV upload
# path (POST /api/decrypt-csv). If it isn't installed we degrade
# gracefully — the endpoint reports an "install cryptography" error,
# the rest of the app keeps working. We avoid making `cryptography` a
# hard requirements.txt addition so existing deployments that never use
# .enc inputs don't need a fresh pip install.
try:
    from cryptography.fernet import Fernet, InvalidToken
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    _CRYPTO_AVAILABLE = True
except ImportError:  # noqa: BLE001
    _CRYPTO_AVAILABLE = False

import deployer
import bsm_paths
from deployer import DeployConfig, Target

app = Flask(
    __name__,
    template_folder=bsm_paths.resource_path("templates"),
    static_folder=bsm_paths.resource_path("static"),
)
#
# 8 MB was fine for the original use case (Compound CSV + a few-KB script)
# but Golden Standard import payloads can easily exceed it. 3CX's
# Parameters entity alone is a few MB on a typical install (one row per
# system-wide setting), and a full export with Trunks + Users + Queues +
# Parameters can hit 20-30 MB on busy systems. Raising to 128 MB so any
# realistic config payload fits with headroom; the body is still bounded
# so we can't accidentally DoS the dev server with a gigabyte upload.
_MAX_UPLOAD_BYTES = 128 * 1024 * 1024           # 128 MB
app.config["MAX_CONTENT_LENGTH"] = _MAX_UPLOAD_BYTES

# Werkzeug 2.3+ introduced a *separate* per-request form-field memory cap
# (`max_form_memory_size`) that defaults to 500 KB — completely independent
# of MAX_CONTENT_LENGTH.  A Golden Standard import embeds the full JSON
# payload inside the `threecx_config` form field, which can easily be
# 1–10 MB for entities like Parameters.  Without raising this limit the
# server 413s even though the overall payload is well under 128 MB.
# Flask 2.3+ reads MAX_FORM_MEMORY_SIZE from config; we also patch the
# request class directly to cover older Flask / newer Werkzeug combos.
app.config["MAX_FORM_MEMORY_SIZE"] = _MAX_UPLOAD_BYTES
try:
    app.request_class.max_form_memory_size = _MAX_UPLOAD_BYTES
except AttributeError:
    pass   # Werkzeug < 2.3 — attribute doesn't exist, no per-field cap anyway


@app.errorhandler(413)
def request_entity_too_large(e):
    """
    Return a JSON body with diagnostic sizes rather than Werkzeug's default
    HTML 413 page.  Two separate limits can trigger this:
      1. MAX_CONTENT_LENGTH  — total request body (default raised to 128 MB)
      2. max_form_memory_size — per-form-field in-memory cap (Werkzeug 2.3+,
         default 500 KB, also raised to 128 MB above)
    """
    import logging
    actual   = request.content_length or 0
    cl_limit = app.config.get("MAX_CONTENT_LENGTH", 0)
    fm_limit = app.config.get("MAX_FORM_MEMORY_SIZE", getattr(app.request_class, "max_form_memory_size", 0) or 0)
    actual_mb   = actual   / 1024 / 1024
    cl_limit_mb = cl_limit / 1024 / 1024
    fm_limit_mb = fm_limit / 1024 / 1024
    logging.warning(
        "413 on %s  content-length=%d  MAX_CONTENT_LENGTH=%d  MAX_FORM_MEMORY_SIZE=%d",
        request.path, actual, cl_limit, fm_limit,
    )
    if actual > cl_limit:
        msg = (
            f"Upload rejected: total payload is {actual_mb:.1f} MB "
            f"but MAX_CONTENT_LENGTH is {cl_limit_mb:.0f} MB."
        )
    else:
        msg = (
            f"Upload rejected: a form field exceeds the per-field memory cap "
            f"(MAX_FORM_MEMORY_SIZE = {fm_limit_mb:.0f} MB). "
            f"Total content-length was {actual_mb:.1f} MB."
        )
    return jsonify({"ok": False, "error": msg,
                    "content_length_bytes": actual,
                    "max_content_length_bytes": cl_limit,
                    "max_form_memory_size_bytes": fm_limit}), 413

HOST = os.environ.get("DEPLOYER_HOST", "127.0.0.1")
PORT = int(os.environ.get("DEPLOYER_PORT", "8765"))

# --------------------------------------------------------------------------- #
# Script library
# --------------------------------------------------------------------------- #
# A small on-disk library of operator-saved scripts. Lives in `scripts/`
# next to app.py. The four /api/scripts endpoints below are deliberately
# scoped to this single directory and validate every filename against an
# allowlist regex (letters/digits/dots/dashes/underscores, max 80 chars,
# .sh suffix). os.path.basename() is applied before any disk operation
# so a malicious "../etc/passwd" request can never reach a parent dir.

SCRIPTS_DIR = bsm_paths.default_scripts_dir()
bsm_paths.seed_default_scripts()
_SCRIPT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
_MAX_SCRIPT_BYTES = 1024 * 1024   # 1 MB per script — generous; rejects accidents


def _resolve_scripts_dir(raw):
    """
    Pick a scripts directory based on the caller-supplied path.
    Empty / missing → default SCRIPTS_DIR (the bundled ./scripts/).
    Anything else  → expand ~, resolve to an absolute path, return it.
    Raises ValueError if the path doesn't exist or isn't a directory
    (creation is the operator's responsibility — we won't silently make
    directories outside our project root).
    """
    if not raw or not str(raw).strip():
        # No per-request dir → use the persisted override (or the default).
        d = bsm_paths.scripts_dir()
        os.makedirs(d, exist_ok=True)
        return d
    p = os.path.abspath(os.path.expanduser(str(raw).strip()))
    if not os.path.exists(p):
        raise ValueError(f"directory does not exist: {p}")
    if not os.path.isdir(p):
        raise ValueError(f"path is not a directory: {p}")
    return p


def _get_scripts_dir():
    """
    Look up the operator's chosen scripts directory from the current request.
    Reads `dir` from query string (GET/DELETE) or form (POST). Falls back to
    the bundled SCRIPTS_DIR.
    """
    raw = request.args.get("dir") or request.form.get("dir") or ""
    return _resolve_scripts_dir(raw)


def _sanitize_script_name(name: str) -> str:
    """
    Reduce *name* to a safe filename inside the active scripts directory,
    or '' if it can't be safely represented. Auto-appends .sh when the
    operator omits it.
    """
    if not name:
        return ""
    n = os.path.basename(str(name).strip())   # strip path components
    if not n.lower().endswith(".sh"):
        n = n + ".sh"
    if n.startswith("."):                     # no hidden / .. files
        return ""
    if not _SCRIPT_NAME_RE.match(n):
        return ""
    return n


def _script_path(scripts_dir: str, name: str) -> str:
    """Resolve *name* under *scripts_dir*. Caller must have sanitized first."""
    return os.path.join(scripts_dir, name)


@app.route("/api/scripts", methods=["GET"])
def list_scripts():
    """Return a sorted list of saved scripts with size + modified time."""
    try:
        scripts_dir = _get_scripts_dir()
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e), "dir": ""}), 400
    try:
        items = []
        for name in sorted(os.listdir(scripts_dir)):
            path = os.path.join(scripts_dir, name)
            if not os.path.isfile(path):
                continue
            if not name.lower().endswith(".sh"):
                continue
            st = os.stat(path)
            items.append({
                "name": name,
                "size": st.st_size,
                "modified": int(st.st_mtime),
            })
        return jsonify({"ok": True, "scripts": items, "dir": scripts_dir})
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(e), "dir": scripts_dir}), 500


@app.route("/api/scripts/<path:name>", methods=["GET"])
def get_script(name):
    """Return the content of one saved script as JSON."""
    safe = _sanitize_script_name(name)
    if not safe:
        return jsonify({"ok": False, "error": "invalid script name"}), 400
    try:
        scripts_dir = _get_scripts_dir()
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    path = _script_path(scripts_dir, safe)
    if not os.path.isfile(path):
        return jsonify({"ok": False, "error": "not found"}), 404
    try:
        with open(path, "rb") as f:
            raw = f.read()
        return jsonify({
            "ok": True,
            "name": safe,
            "content": raw.decode("utf-8", errors="replace"),
        })
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/scripts/<path:name>", methods=["DELETE"])
def delete_script(name):
    """Remove a saved script from disk."""
    safe = _sanitize_script_name(name)
    if not safe:
        return jsonify({"ok": False, "error": "invalid script name"}), 400
    try:
        scripts_dir = _get_scripts_dir()
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    path = _script_path(scripts_dir, safe)
    if not os.path.isfile(path):
        return jsonify({"ok": False, "error": "not found"}), 404
    try:
        os.remove(path)
        return jsonify({"ok": True})
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/scripts", methods=["POST"])
def save_script():
    """
    Create or overwrite a saved script. Form fields:
      name    — file name (will be sanitized; .sh appended if missing)
      content — script text (UTF-8)
      dir     — optional override of the scripts directory
    """
    name = request.form.get("name", "")
    content = request.form.get("content", "")
    if not content.strip():
        return jsonify({"ok": False, "error": "script content is empty"}), 400
    safe = _sanitize_script_name(name)
    if not safe:
        return jsonify({
            "ok": False,
            "error": ("invalid name — use letters, digits, dots, dashes, "
                      "underscores; no leading dot; max 80 chars (without .sh suffix)"),
        }), 400
    body = content.encode("utf-8")
    if len(body) > _MAX_SCRIPT_BYTES:
        return jsonify({
            "ok": False,
            "error": f"script too large ({len(body)} bytes; max {_MAX_SCRIPT_BYTES})",
        }), 400
    try:
        scripts_dir = _get_scripts_dir()
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    try:
        # Atomic write: write to a temp file then rename. Avoids leaving a
        # half-written script on disk if the process dies mid-write.
        path = _script_path(scripts_dir, safe)
        tmp  = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, path)
        st = os.stat(path)
        return jsonify({
            "ok": True,
            "name": safe,
            "size": st.st_size,
            "modified": int(st.st_mtime),
        })
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/pick-scripts-dir", methods=["POST"])
def pick_scripts_dir():
    """
    Open a native OS folder-picker dialog and return whichever directory
    the operator selects. Lets the frontend swap the freeform path input
    for a real OS-managed picker (Explorer on Windows, Finder on macOS,
    GTK/KDE dialog on Linux).

    Why this is fine despite running server-side:
      • The app binds 127.0.0.1, so the "server" IS the operator's local
        machine — popping a Tk dialog appears on their own desktop.
      • Tk's filedialog.askdirectory() is stdlib (no extra deps on
        Windows + macOS; Linux needs `python3-tk` if missing).
      • The dialog runs on a worker thread so the Flask request thread
        doesn't block other in-flight requests (status checks, polls)
        while the operator is still picking.

    Returns:
      200 {ok: true,  path: "<absolute-path>"}
      200 {ok: true,  path: null}             — operator cancelled
      503 {ok: false, error: "<reason>"}      — tkinter unavailable
    """
    try:
        import tkinter
        from tkinter import filedialog
    except ImportError:
        return jsonify({
            "ok": False,
            "error": ("tkinter isn't available on this Python install. "
                      "On Debian/Ubuntu install `python3-tk`; on Fedora "
                      "install `python3-tkinter`. Until then you can "
                      "type the path manually."),
        }), 503

    # Tk needs to own the main thread on macOS, but we're in a Flask
    # request thread. Running the dialog on a child thread works on
    # Windows + Linux without issue; on macOS Tk will print warnings
    # but the dialog still appears. The dialog itself is modal, so the
    # main Flask event loop stays responsive thanks to threaded=True.
    result = {"path": None, "error": None}

    def _run_picker():
        try:
            root = tkinter.Tk()
            root.withdraw()             # hide the empty Tk root window
            root.attributes("-topmost", True)
            root.after(50, lambda: root.focus_force())
            path = filedialog.askdirectory(
                title="Pick a directory for saved scripts",
                mustexist=True,
            )
            root.destroy()
            # filedialog returns "" on Cancel — normalise to None so
            # the client doesn't have to distinguish "" vs missing.
            result["path"] = path or None
        except Exception as e:          # noqa: BLE001
            result["error"] = str(e)

    import threading
    th = threading.Thread(target=_run_picker, daemon=True)
    th.start()
    th.join(timeout=300)                # 5-min cap on the modal dialog

    if result["error"]:
        return jsonify({"ok": False, "error": result["error"]}), 500
    return jsonify({"ok": True, "path": result["path"]})


@app.route("/api/decrypt-csv", methods=["POST"])
def decrypt_csv_endpoint():
    """
    Decrypt a master-password-encrypted CSV (the `.enc` format produced
    by Web Scraper / encrypt_csv.py) and return the plaintext to the
    browser in the response body.

    Inputs (multipart/form-data):
      • enc_file         — the `.enc` blob the operator picked
      • master_password  — the master password they typed in the modal

    Plaintext is held in memory only — never written to disk on this
    server. The browser receives the CSV text in a JSON response and
    holds it in a Blob/File object until the next page reload. Same
    in-memory-only handling as every other password and credential the
    app touches.

    Why server-side and not browser-side: Fernet's format (version byte,
    timestamp, IV, ciphertext, HMAC) is fiddly to reimplement correctly
    in WebCrypto, and the bind is 127.0.0.1 anyway — the master password
    flows over loopback only and is protected by the same CSRF gate as
    every other POST.

    Returns:
      200 {ok: true,  csv: "<plaintext>", filename: "<basename>.csv"}
      400 {ok: false, error: "<reason>"}     — malformed input / no file
      401 {ok: false, error: "<reason>"}     — wrong password / tampered
      503 {ok: false, error: "<reason>"}     — cryptography lib missing
    """
    if not _CRYPTO_AVAILABLE:
        return jsonify({
            "ok": False,
            "error": "The `cryptography` Python package isn't installed on the "
                     "server. Run `pip install cryptography` and restart Flask.",
        }), 503

    master_password = request.form.get("master_password", "")
    if not master_password:
        return jsonify({"ok": False, "error": "Master password is required."}), 400

    # Source the encrypted bytes from either an upload (enc_file) or a file the
    # operator picked from the data-dir csv/ folder (server_name).
    enc_file = request.files.get("enc_file")
    server_name = request.form.get("server_name", "")
    if enc_file:
        blob = enc_file.read()
        orig_name = enc_file.filename or "decrypted.enc"
    elif server_name:
        safe = _sanitize_csv_name(server_name)
        if not safe or not safe.lower().endswith(".enc"):
            return jsonify({"ok": False, "error": "invalid server file name"}), 400
        path = os.path.join(bsm_paths.csv_dir(), safe)
        if not os.path.isfile(path):
            return jsonify({"ok": False, "error": "server file not found"}), 404
        with open(path, "rb") as f:
            blob = f.read()
        orig_name = safe
    else:
        return jsonify({"ok": False, "error": "No enc_file uploaded."}), 400

    if len(blob) <= 16:
        return jsonify({
            "ok": False,
            "error": (f"File looks truncated — got {len(blob)} bytes, need at "
                      "least 17 (16-byte salt + a Fernet token)."),
        }), 400

    salt, token = blob[:16], blob[16:]

    # Derive the Fernet key. PBKDF2 iteration count and SHA-256 must
    # match encrypt_csv.py / scraper.py exactly — drift here means the
    # browser-side picker silently can't read files encrypted by the
    # CLI tools, and vice versa.
    try:
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=480_000,
        )
        key = base64.urlsafe_b64encode(kdf.derive(master_password.encode()))
        plaintext = Fernet(key).decrypt(token)
    except InvalidToken:
        # Fernet raises this for both wrong-password and tampered-token
        # cases. The two are indistinguishable by design (the HMAC tag
        # was made to be); we report a single user-friendly message.
        return jsonify({
            "ok": False,
            "error": "Wrong master password, or the file has been corrupted.",
        }), 401
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"Decryption failed: {e}"}), 400

    # Decode bytes -> str. We're lenient on encoding because scraper.py
    # writes UTF-8 but a CSV encrypted by hand may use cp1252 (Excel) or
    # similar — fall back to latin-1 (1:1 byte mapping, never errors)
    # so the operator at least sees *something* and can fix it client-
    # side rather than the whole flow erroring out.
    try:
        csv_text = plaintext.decode("utf-8")
    except UnicodeDecodeError:
        csv_text = plaintext.decode("latin-1")

    # Build a sensible default filename: strip .enc, append .csv. The
    # browser uses this for the file-picker name display and as the
    # filename on the multipart blob it ultimately uploads.
    base, ext = os.path.splitext(orig_name)
    suggested = (base if ext.lower() == ".enc" else orig_name) + ".csv"

    return jsonify({"ok": True, "csv": csv_text, "filename": suggested})


@app.route("/api/encrypt-csv", methods=["POST"])
def encrypt_csv_endpoint():
    """
    Encrypt a plaintext CSV using the same `.enc` format as encrypt_csv.py:
    16-byte random salt followed by a Fernet token. The plaintext is held
    in memory only and the encrypted blob is returned as a download.
    """
    if not _CRYPTO_AVAILABLE:
        return jsonify({
            "ok": False,
            "error": "The `cryptography` Python package isn't installed on the server.",
        }), 503

    csv_file = request.files.get("csv_file")
    if not csv_file:
        return jsonify({"ok": False, "error": "No csv_file uploaded."}), 400

    master_password = request.form.get("master_password", "")
    if not master_password:
        return jsonify({"ok": False, "error": "Master password is required."}), 400

    plaintext = csv_file.read()
    if not plaintext:
        return jsonify({"ok": False, "error": "CSV file is empty."}), 400

    try:
        salt = os.urandom(16)
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=480_000,
        )
        key = base64.urlsafe_b64encode(kdf.derive(master_password.encode()))
        blob = salt + Fernet(key).encrypt(plaintext)
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"Encryption failed: {e}"}), 400

    orig = os.path.basename(csv_file.filename or "fleet.csv")
    base, _ = os.path.splitext(orig)
    safe_base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._-") or "fleet"
    filename = safe_base + ".enc"

    # When `save=true`, write the .enc straight into the CSV library folder
    # (the data-dir csv/ folder) so it shows up in "Import from csv folder…"
    # for future use, instead of being returned as a one-off download.
    if request.form.get("save", "").lower() in ("1", "true", "yes"):
        d = bsm_paths.csv_dir()
        try:
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, filename), "wb") as f:
                f.write(blob)
        except OSError as e:
            return jsonify({"ok": False, "error": f"Couldn't save to CSV folder: {e}"}), 500
        return jsonify({"ok": True, "filename": filename, "dir": d})

    return Response(
        blob,
        mimetype="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@app.route("/api/help", methods=["GET"])
def get_help():
    """
    Return the user manual (README.md) as plain text. Kept as a fallback
    for the help modal in case the inline embed (see / route) was empty
    at page-load time. Returns text/markdown instead of JSON so the
    response is robust to JSON-encoding quirks and trivially curlable.
    """
    text = _load_readme_text()
    if not text:
        return ("README.md not found", 404, {"Content-Type": "text/plain"})
    return (text, 200, {"Content-Type": "text/markdown; charset=utf-8"})


@app.after_request
def _security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Cache-Control"] = "no-store"
    return resp


# ---- CSRF protection -------------------------------------------------------
# The app binds 127.0.0.1 so only local clients can reach it, BUT a browser
# visiting a malicious site can POST cross-origin `multipart/form-data` to
# any URL — including our local Flask port — without CORS preflight.  Such
# a forged request could trigger an SSH fleet deploy against attacker-
# controlled targets and exfiltrate the user's saved scripts library.
#
# Defense: require every state-changing request to carry a matching Origin
# (or Referer, fallback) header pointing at our own host:port.  GETs are
# left alone — they only read data and are subject to same-origin policy
# on the JSON they return.
_ALLOWED_ORIGINS = {
    f"http://{HOST}:{PORT}",
    f"http://localhost:{PORT}",
    f"http://127.0.0.1:{PORT}",
}


@app.before_request
def _csrf_guard():
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return None
    # The same-origin fetch from index.html sends an Origin header. A
    # browser cross-origin POST does too, but with a different value.
    # If neither Origin nor Referer is present, the request didn't come
    # from a browser at all (e.g. curl) — accept it since the local-only
    # bind is the trust boundary in that case.
    origin = request.headers.get("Origin", "")
    referer = request.headers.get("Referer", "")
    if not origin and not referer:
        return None
    if origin and origin in _ALLOWED_ORIGINS:
        return None
    if referer:
        # Strip path to compare just the scheme://host:port prefix.
        for allowed in _ALLOWED_ORIGINS:
            if referer.startswith(allowed + "/") or referer == allowed:
                return None
    return jsonify({"ok": False, "error": "CSRF: cross-origin request blocked"}), 403


def _load_readme_text() -> str:
    # Read README.md from disk and return raw text, or "" if unreachable.
    # Used both by /api/help (legacy fetch) and by the index template
    # (inline embed). Re-reading on every request means operators editing
    # the README see updates on the next page load — no Flask restart.
    readme_path = bsm_paths.resource_path("README.md")
    try:
        with open(readme_path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:  # noqa: BLE001
        return ""


# In a packaged build, Electron sets BSM_SPA_DIR to the directory holding the
# Vite-built SPA (index.html + assets/). When set, Flask serves that single-page
# app so the renderer stays same-origin with the API (no CORS, streaming works).
# In dev this is unset — the Vite dev server serves the renderer instead.
_SPA_DIR = (os.environ.get("BSM_SPA_DIR") or "").strip()


def _spa_index_path() -> str:
    return os.path.join(_SPA_DIR, "index.html") if _SPA_DIR else ""


# --------------------------------------------------------------------------- #
# CSV library — plaintext .csv / encrypted .enc fleet files the operator drops
# into the data-dir `csv/` folder (next to scripts/). Listed + read here so the
# Import-CSV UI can pick from them in addition to uploading a file.
_CSV_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ +-]{0,120}\.(csv|enc)$", re.IGNORECASE)


def _sanitize_csv_name(name: str) -> str:
    n = os.path.basename((name or "").strip())
    return n if _CSV_NAME_RE.match(n) else ""


@app.route("/api/csv-files")
def list_csv_files():
    d = bsm_paths.csv_dir()
    items = []
    try:
        for name in sorted(os.listdir(d)):
            path = os.path.join(d, name)
            if not os.path.isfile(path):
                continue
            low = name.lower()
            if not (low.endswith(".csv") or low.endswith(".enc")):
                continue
            st = os.stat(path)
            items.append({
                "name": name,
                "encrypted": low.endswith(".enc"),
                "size": st.st_size,
                "modified": int(st.st_mtime),
            })
    except OSError as e:
        return jsonify({"ok": False, "error": str(e), "dir": d, "files": []}), 500
    return jsonify({"ok": True, "dir": d, "files": items})


@app.route("/api/csv-file/<path:name>")
def get_csv_file(name):
    """Return a plaintext .csv from the data-dir csv/ folder (.enc must be decrypted)."""
    safe = _sanitize_csv_name(name)
    if not safe:
        return jsonify({"ok": False, "error": "invalid file name"}), 400
    if safe.lower().endswith(".enc"):
        return jsonify({"ok": False, "error": "encrypted file — decrypt with the master password"}), 400
    path = os.path.join(bsm_paths.csv_dir(), safe)
    if not os.path.isfile(path):
        return jsonify({"ok": False, "error": "not found"}), 404
    with open(path, "rb") as f:
        raw = f.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    return jsonify({"ok": True, "csv": text, "filename": safe})


@app.route("/api/open-csv-folder", methods=["POST"])
def open_csv_folder():
    """
    Open the CSV library folder in the operator's file manager. Safe because
    the app binds 127.0.0.1 — the "server" is the operator's own machine, so
    the Explorer/Finder window appears on their desktop.
    """
    d = bsm_paths.csv_dir()
    try:
        os.makedirs(d, exist_ok=True)
        if sys.platform.startswith("win"):
            os.startfile(d)  # noqa: S606 — local desktop, trusted path
        elif sys.platform == "darwin":
            subprocess.Popen(["open", d])
        else:
            subprocess.Popen(["xdg-open", d])
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"Couldn't open the folder: {e}"}), 500
    return jsonify({"ok": True, "dir": d})


def _open_in_file_manager(d: str):
    os.makedirs(d, exist_ok=True)
    if sys.platform.startswith("win"):
        os.startfile(d)  # noqa: S606 — local desktop, trusted path
    elif sys.platform == "darwin":
        subprocess.Popen(["open", d])
    else:
        subprocess.Popen(["xdg-open", d])


_SHIP_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"}
_MAX_SHIP_BYTES = 3 * 1024 * 1024  # 3 MB per clip-art image


def _safe_ship_basename(name: str) -> str:
    """Basename of an existing ship file — accepts any name (incl. odd chars)
    dropped directly in the folder. Path traversal is blocked by basename;
    only the extension is constrained."""
    n = os.path.basename((name or "").strip())
    if os.path.splitext(n)[1].lower() not in _SHIP_EXTS:
        return ""
    return n


def _sanitize_for_save(filename: str) -> str:
    """Turn an arbitrary upload filename into a safe stored name, preserving
    the (validated) extension. Special characters → '_'."""
    base, ext = os.path.splitext(os.path.basename((filename or "").strip()))
    if ext.lower() not in _SHIP_EXTS:
        return ""
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._-")[:60] or "ship"
    return safe + ext.lower()


@app.route("/api/ships")
def list_ships():
    """List the clip-art images available as ship art."""
    d = bsm_paths.default_ships_dir()
    items = []
    try:
        for name in sorted(os.listdir(d)):
            if (os.path.isfile(os.path.join(d, name))
                    and os.path.splitext(name)[1].lower() in _SHIP_EXTS):
                items.append(name)
    except OSError:
        pass
    return jsonify({"ok": True, "dir": d, "ships": items})


@app.route("/api/ship/<path:name>")
def get_ship(name):
    """Serve a ship clip-art image by name."""
    safe = _safe_ship_basename(name)
    if not safe:
        return jsonify({"ok": False, "error": "invalid file name"}), 400
    d = bsm_paths.default_ships_dir()
    if not os.path.isfile(os.path.join(d, safe)):
        return jsonify({"ok": False, "error": "not found"}), 404
    return send_from_directory(d, safe)


@app.route("/api/ship-upload", methods=["POST"])
def upload_ship():
    """Save an uploaded clip-art image into the ships folder. The filename is
    sanitised (special characters supported), uniquified, and the safe stored
    name is returned."""
    f = request.files.get("ship")
    if not f or not f.filename:
        return jsonify({"ok": False, "error": "No image uploaded."}), 400
    name = _sanitize_for_save(f.filename)
    if not name:
        return jsonify({
            "ok": False,
            "error": "Use a PNG / JPG / GIF / SVG / WEBP image.",
        }), 400
    data = f.read()
    if len(data) > _MAX_SHIP_BYTES:
        return jsonify({"ok": False, "error": "Image too large (max 3 MB)."}), 400
    d = bsm_paths.default_ships_dir()
    os.makedirs(d, exist_ok=True)
    # Uniquify so a new upload never silently overwrites an existing image.
    base, ext = os.path.splitext(name)
    final, n = name, 1
    while os.path.exists(os.path.join(d, final)):
        n += 1
        final = f"{base}-{n}{ext}"
    try:
        with open(os.path.join(d, final), "wb") as out:
            out.write(data)
    except OSError as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, "filename": final})


@app.route("/api/ship-delete", methods=["POST"])
def delete_ship():
    """Remove a clip-art image from the ships folder."""
    name = (request.get_json(silent=True) or {}).get("name", "")
    safe = _safe_ship_basename(name)
    if not safe:
        return jsonify({"ok": False, "error": "invalid file name"}), 400
    path = os.path.join(bsm_paths.default_ships_dir(), safe)
    try:
        if os.path.isfile(path):
            os.remove(path)
    except OSError as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, "removed": safe})


def _folder_for(which: str) -> str:
    if which == "scripts":
        return bsm_paths.scripts_dir()
    if which == "ships":
        return bsm_paths.default_ships_dir()
    return bsm_paths.csv_dir()


@app.route("/api/folder-path", methods=["POST"])
def folder_path():
    """Resolve a library folder's absolute path without opening it (so the
    Electron app can open it itself and bring it to the foreground)."""
    which = (request.get_json(silent=True) or {}).get("which", "csv")
    d = _folder_for(which)
    os.makedirs(d, exist_ok=True)
    return jsonify({"ok": True, "path": d})


@app.route("/api/open-folder", methods=["POST"])
def open_folder():
    """Open the CSV, Scripts, or Ships folder in the OS file manager."""
    which = (request.get_json(silent=True) or {}).get("which", "csv")
    d = _folder_for(which)
    try:
        _open_in_file_manager(d)
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"Couldn't open the folder: {e}"}), 500
    return jsonify({"ok": True, "dir": d})


@app.route("/api/settings", methods=["GET", "POST"])
def settings_endpoint():
    """
    Read or update persisted user settings. Today this covers the CSV and
    Scripts library folder overrides; an empty/missing value clears an
    override (back to the default data-dir folder).
    """
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        patch = {}
        for key in ("csv_dir", "scripts_dir"):
            if key not in data:
                continue
            val = data.get(key)
            if val in (None, ""):
                patch[key] = None
            else:
                p = os.path.abspath(os.path.expanduser(str(val).strip()))
                if not os.path.isdir(p):
                    return jsonify({"ok": False, "error": f"Not a folder: {p}"}), 400
                patch[key] = p
        bsm_paths.save_settings(patch)
    s = bsm_paths.load_settings()
    return jsonify({
        "ok": True,
        "csv_dir": bsm_paths.csv_dir(),
        "scripts_dir": bsm_paths.scripts_dir(),
        "csv_dir_custom": bool((s.get("csv_dir") or "").strip()),
        "scripts_dir_custom": bool((s.get("scripts_dir") or "").strip()),
        "default_csv_dir": bsm_paths.default_csv_dir(),
        "default_scripts_dir": bsm_paths.default_scripts_dir(),
    })


@app.route("/api/pick-folder", methods=["POST"])
def pick_folder():
    """Open a native folder-picker and return the chosen path (or null)."""
    try:
        import tkinter
        from tkinter import filedialog
    except ImportError:
        return jsonify({
            "ok": False,
            "error": "tkinter isn't available on this Python install; type the path manually.",
        }), 503
    title = (request.get_json(silent=True) or {}).get("title") or "Pick a folder"
    result = {"path": None, "error": None}

    def _run_picker():
        try:
            root = tkinter.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            root.after(50, lambda: root.focus_force())
            path = filedialog.askdirectory(title=title, mustexist=True)
            root.destroy()
            result["path"] = path or None
        except Exception as e:  # noqa: BLE001
            result["error"] = str(e)

    th = threading.Thread(target=_run_picker, daemon=True)
    th.start()
    th.join(timeout=300)
    if result["error"]:
        return jsonify({"ok": False, "error": result["error"]}), 500
    return jsonify({"ok": True, "path": result["path"]})


@app.route("/")
def index():
    # Packaged build: serve the built React SPA.
    if _SPA_DIR and os.path.isfile(_spa_index_path()):
        return send_from_directory(_SPA_DIR, "index.html")
    # Legacy fallback: the old single-file Jinja UI (standalone backend run).
    return render_template(
        "index.html",
        test_host=deployer.TEST_HOST,
        help_content=_load_readme_text(),
    )


@app.route("/<path:filename>")
def spa_asset(filename):
    # Serve the built SPA's static assets (assets/*.js|css, fleet.ico, images).
    # Guard against shadowing the API namespace; those routes are registered
    # explicitly and take precedence, but be defensive anyway.
    if filename.startswith("api/"):
        abort(404)
    if _SPA_DIR:
        candidate = os.path.normpath(os.path.join(_SPA_DIR, filename))
        # Containment check: never serve outside the SPA dir.
        if candidate.startswith(os.path.normpath(_SPA_DIR)) and os.path.isfile(candidate):
            return send_from_directory(_SPA_DIR, filename)
    abort(404)


@app.route("/api/config")
def config():
    """Static config the SPA needs at startup (Test Host label + heplify defaults)."""
    return jsonify({
        "ok": True,
        "test_host": deployer.TEST_HOST,
        "defaults": {
            "interface": deployer.DEFAULT_INTERFACE,
            "hep_server": deployer.DEFAULT_HEP_SERVER,
            "capture_mode": deployer.DEFAULT_CAPTURE_MODE,
            "discard_methods": deployer.DEFAULT_DISCARD_METHODS,
            "max_workers": 10,
        },
    })


@app.route("/api/releases")
def releases():
    try:
        rels = deployer.fetch_releases()
        latest = deployer.resolve_version("latest")
        return jsonify({"ok": True, "releases": rels, "latest": latest,
                        "fallback": deployer.KNOWN_GOOD_FALLBACK})
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(e),
                        "fallback": deployer.KNOWN_GOOD_FALLBACK}), 502


def _build_config(form) -> DeployConfig:
    cfg = DeployConfig(
        version=(form.get("version") or "latest").strip(),
        interface=(form.get("interface") or deployer.DEFAULT_INTERFACE).strip(),
        hep_server=(form.get("hep_server") or deployer.DEFAULT_HEP_SERVER).strip(),
        capture_mode=(form.get("capture_mode") or deployer.DEFAULT_CAPTURE_MODE).strip(),
        discard_methods=(form.get("discard_methods") or deployer.DEFAULT_DISCARD_METHODS).strip(),
        strict_host_keys=form.get("strict_host_keys") == "on",
    )
    try:
        cfg.max_workers = max(1, min(50, int(form.get("max_workers", "10"))))
    except ValueError:
        cfg.max_workers = 10
    return cfg


def _event(obj: Dict) -> str:
    """Encode one NDJSON event line."""
    return json.dumps(obj, ensure_ascii=False) + "\n"


def _resolve_targets_creds(mode):
    """
    Parse targets + per-host credentials from the current request, shared by
    /api/deploy and /api/auth-check. Returns
    ``(targets, creds, parse_errors, fatal)`` where *fatal* is a user-facing
    string when the request is unusable (missing files / bad test host), else
    None. Mirrors the source modes: Test host, combined KeePass CSV, or the
    SSH-URL CSV + Password CSV pair (with the fallback-hosts filter applied).
    """
    targets: List[Target] = []
    creds: Dict[str, str] = {}
    parse_errors: List[str] = []

    kp_file = request.files.get("keepass_csv")
    have_keepass = bool(kp_file and kp_file.filename)

    if mode == "test":
        try:
            test_target = deployer.parse_ssh_url(deployer.TEST_HOST)
        except ValueError as e:
            return [], {}, [], f"bad test host: {e}"
        targets = [test_target]
        test_pw = request.form.get("test_password", "")
        if have_keepass:
            _, kp_creds, kp_errs = deployer.load_keepass_csv(kp_file.read())
            parse_errors += kp_errs
            if test_target.label in kp_creds:
                creds[test_target.label] = kp_creds[test_target.label]
        elif request.files.get("pass_csv") and request.files["pass_csv"].filename:
            m, errs = deployer.load_credentials(request.files["pass_csv"].read(), targets)
            parse_errors += errs
            creds.update(m)
        if test_pw:
            creds[test_target.label] = test_pw
        return targets, creds, parse_errors, None

    if have_keepass:
        targets, creds, kerrs = deployer.load_keepass_csv(kp_file.read())
        parse_errors += kerrs
    else:
        ssh_file = request.files.get("ssh_csv")
        pass_file = request.files.get("pass_csv")
        if not ssh_file or not ssh_file.filename:
            return [], {}, [], "Upload a KeePass CSV, or an SSH URL CSV + Password CSV"
        if not pass_file or not pass_file.filename:
            return [], {}, [], "Password CSV is required (or upload a combined KeePass CSV instead)"
        targets, terrs = deployer.load_targets(ssh_file.read())
        parse_errors += terrs
        creds, cerrs = deployer.load_credentials(pass_file.read(), targets)
        parse_errors += cerrs

    if mode == "fallback":
        try:
            wanted = set(json.loads(request.form.get("fallback_hosts") or "[]"))
        except json.JSONDecodeError:
            wanted = set()
        if wanted:
            targets = [t for t in targets if t.label in wanted]

    return targets, creds, parse_errors, None


@app.route("/api/auth-check", methods=["POST"])
def auth_check():
    """
    Connect-only SSH auth test for the selected systems. Same multipart form as
    /api/deploy (mode + CSVs + test_password). Returns per-host pass/fail so the
    operator can verify credentials before preparing or running an action.
    """
    mode = (request.form.get("mode") or "universal").strip()
    cfg = _build_config(request.form)
    targets, creds, parse_errors, fatal = _resolve_targets_creds(mode)
    if fatal:
        return jsonify({"ok": False, "error": fatal}), 400
    if not targets:
        return jsonify({"ok": False, "error": "No systems found. " + " | ".join(parse_errors)}), 400

    def _one(t):
        ok, err = deployer.check_auth(t, creds.get(t.label, ""), cfg)
        return {"label": t.label, "ok": ok, "error": err}

    results: List[dict] = []
    with ThreadPoolExecutor(max_workers=min(10, len(targets))) as pool:
        results = list(pool.map(_one, targets))

    passed = sum(1 for r in results if r["ok"])
    return jsonify({"ok": True, "results": results, "passed": passed, "total": len(results)})


@app.route("/api/deploy", methods=["POST"])
def deploy():
    """
    Multipart form:
      mode: 'universal' | 'test' | 'fallback'
      keepass_csv: file — combined KeePass export (Account, Login Name, Password,
                   Web Site, Comments). If present, supersedes ssh_csv/pass_csv.
      ssh_csv:  file (required for universal/fallback if no keepass_csv)
      pass_csv: file (required for universal/fallback if no keepass_csv)
      fallback_hosts: JSON list of host labels (for mode=fallback)
      version, interface, hep_server, capture_mode, discard_methods, strict_host_keys, max_workers
    Returns a streamed NDJSON response, one event per line.
    """
    mode = (request.form.get("mode") or "universal").strip()
    action = (request.form.get("action") or "deploy").strip()
    if action not in {"deploy", "apt_upgrade", "custom_script", "quick_diag", "threecx"}:
        return Response(_event({"type": "fatal", "message": f"unknown action '{action}'"}),
                        mimetype="application/x-ndjson")
    cfg = _build_config(request.form)

    # ---- Resolve targets + credentials ---------------------------------- #
    targets, creds, parse_errors, fatal = _resolve_targets_creds(mode)
    if fatal:
        return Response(_event({"type": "fatal", "message": fatal}),
                        mimetype="application/x-ndjson")

    if not targets:
        return Response(
            _event({"type": "fatal",
                    "message": "No targets to deploy to. " + " | ".join(parse_errors)}),
            mimetype="application/x-ndjson")

    # ---- Build the remote script + per-action execution settings ------- #
    # interpreter    — shell used to pipe the script over stdin
    # require_marker — whether DEPLOY_RESULT=success must appear in output
    # success_text   — label shown in the per-host card on success
    if action == "quick_diag":
        script = deployer.build_quick_diag_script()
        cfg.exec_timeout = max(cfg.exec_timeout, 120)   # diagnostics finish fast
        interpreter    = "sh -s"   # POSIX sh — works on Linux and OpenBSD
        require_marker = False     # diagnostic always exits 0; no sentinel needed
        success_text   = "diagnostic complete"

    elif action == "apt_upgrade":
        script = deployer.build_apt_upgrade_script()
        cfg.exec_timeout = max(cfg.exec_timeout, 900)  # patching can be slow
        # POSIX sh: the script branches on OS at runtime (Debian apt-get vs
        # OpenBSD pkg_add) and works under dash *and* OpenBSD's pdksh-as-sh.
        interpreter  = "sh -s"
        require_marker = True
        success_text = "upgrade complete"

    elif action == "custom_script":
        script_file = request.files.get("custom_script")
        if not script_file or not script_file.filename:
            return Response(_event({"type": "fatal",
                                    "message": "No script file uploaded for custom_script action"}),
                            mimetype="application/x-ndjson")
        script = deployer._decode(script_file.read())
        # Normalise line endings to LF. CRLF (Windows) or lone CR (legacy
        # Mac) breaks shell `\`-newline continuations: bash treats `\` as
        # escaping the following character, so `\` + `\r` produces a
        # literal CR in the command, and the `\n` then ends the line.
        # A multi-line `curl ... \` becomes multiple commands, with `-H`
        # and `-d` interpreted as commands → "command not found".
        # Affects BOTH pasted-from-textarea and uploaded-.sh inputs since
        # either may originate on a CRLF platform.
        script = script.replace("\r\n", "\n").replace("\r", "\n")
        if not script.strip():
            return Response(_event({"type": "fatal", "message": "Uploaded script file is empty"}),
                            mimetype="application/x-ndjson")
        # Be generous: user scripts can do anything (DB dumps, config changes, …)
        cfg.exec_timeout = max(cfg.exec_timeout, 600)
        interpreter  = deployer._get_interpreter(script)
        # The operator can force RouterOS (MikroTik) mode, which sends the
        # commands straight to the RouterOS console instead of a POSIX shell
        # (RouterOS has no `sh`, so the default path fails with
        # "bad command name sh"). See deployer.deploy_host's routeros branch.
        if (request.form.get("custom_interpreter", "") or "").strip().lower() == "routeros":
            interpreter = "routeros"
        require_marker = False   # user scripts don't emit our sentinel
        success_text = f"script completed ({script_file.filename})"

        # Root-escalation handling is done in the SSH layer (see the
        # `root_password=` argument passed to deployer.deploy_host below and
        # the deployer._exec_with_su helper). We deliberately do NOT inject
        # any sudo wrapper into the script body anymore: the operator-supplied
        # model is "SSH-only users escalate by knowing the root password" —
        # which `su` handles correctly and `sudo` cannot (sudo's first check
        # is sudoers membership, which the SSH user is intentionally excluded
        # from in this security model).

    elif action == "threecx":
        # The 3CX config — entity targets, username, password source — is
        # bundled into one JSON blob by the UI. We hand it straight to
        # deployer.build_threecx_script which generates the per-host script.
        raw = request.form.get("threecx_config", "")
        if not raw:
            return Response(_event({"type": "fatal",
                                    "message": "missing threecx_config"}),
                            mimetype="application/x-ndjson")
        try:
            threecx_cfg = json.loads(raw)
            if not isinstance(threecx_cfg, dict):
                raise ValueError("threecx_config must be an object")
        except (json.JSONDecodeError, ValueError) as e:
            return Response(_event({"type": "fatal",
                                    "message": f"invalid threecx_config JSON: {e}"}),
                            mimetype="application/x-ndjson")
        script = deployer.build_threecx_script(threecx_cfg)
        cfg.exec_timeout = max(cfg.exec_timeout, 600)
        interpreter    = "bash -s"
        require_marker = False
        # Mode-aware success label so the per-host card reflects what the
        # operator actually asked for (audit / probe / apply), instead of
        # always claiming "applied" even when nothing was changed.
        _tcx_mode = (threecx_cfg.get("mode") or "apply").strip()
        success_text = {
            "audit":  "3CX audit passed (all fields match)",
            "probe":  "3CX fields probed",
            "apply":  "3CX configuration applied",
            "export": "3CX Golden config exported",
            "import": "3CX Golden config imported",
        }.get(_tcx_mode, "3CX configuration applied")

    else:  # action == "deploy"
        try:
            cfg.resolved_version = deployer.resolve_version(cfg.version)
        except Exception as e:  # noqa: BLE001
            cfg.resolved_version = deployer.KNOWN_GOOD_FALLBACK
            parse_errors.append(f"version resolution failed ({e}); using {deployer.KNOWN_GOOD_FALLBACK}")
        try:
            script = deployer.build_remote_script(cfg)
        except ValueError as e:
            return Response(_event({"type": "fatal", "message": f"invalid configuration: {e}"}),
                            mimetype="application/x-ndjson")
        interpreter  = "bash -s"
        require_marker = True
        success_text = "deployed and heplify active"

    # ---- Root escalation password (custom_script only) -------------------- #
    # When the operator provides a root password in the Custom Script pane,
    # deployer.deploy_host takes the su-via-PTY path so the script runs as
    # root even if the SSH user is intentionally a non-sudoer. For every
    # other action (deploy/diag/apt_upgrade) we ignore the field — those
    # actions already manage their own privilege requirements (heplify needs
    # the SSH user to be root anyway; the built-in scripts use `id -u`
    # checks to fail loud if not).
    # ---- Per-host CSV variables (custom_script + threecx) ----------------- #
    # Compound-CSV columns become $variables visible to the script. The
    # browser sends a JSON map keyed by canonical Target.label
    # ("ssh://user@host:port") → {column_name: value}. We pass the per-host
    # dict to deploy_host, which prepends `export …` lines to the script.
    #
    # custom_script → operator-authored scripts can use any $variable.
    # threecx       → the 3CX manager reads $Password (or whatever column
    #                 the operator selected) when "PBX password from CSV"
    #                 is chosen, so we forward the same map.
    # Other actions (deploy/diag/apt_upgrade) ignore the field — their
    # built-in scripts don't take user-supplied variables.
    host_vars_by_label: Dict[str, Dict[str, str]] = {}
    if action in {"custom_script", "threecx"}:
        raw = request.form.get("host_vars", "")
        if raw:
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    # Coerce inner dict values to strings; ignore non-dict entries.
                    for k, v in parsed.items():
                        if isinstance(v, dict):
                            host_vars_by_label[str(k)] = {
                                str(ck): "" if cv is None else str(cv)
                                for ck, cv in v.items()
                            }
                else:
                    parse_errors.append("host_vars JSON was not an object; ignored")
            except json.JSONDecodeError as e:
                parse_errors.append(f"host_vars JSON parse error ({e}); ignored")

    # For the 3CX action: if the operator picked the "ssh" password source
    # (the default for Test Host and Manual modes — where there's no
    # separate Compound CSV column to draw from), reuse the same SSH
    # password we already loaded for the SSH connection as the PBX login
    # password. We do this by mirroring each target's credential into
    # host_vars[label][Password], then telling the 3CX script to read
    # from $Password the same way it does for Compound CSV mode. This
    # means the operator types ONE password (per host or across the
    # fleet) and it's used for both SSH and 3CX, matching the Compound
    # CSV experience.
    if action == "threecx":
        try:
            _tcfg_for_pw = json.loads(request.form.get("threecx_config", "") or "{}")
        except (json.JSONDecodeError, ValueError):
            _tcfg_for_pw = {}
        if (_tcfg_for_pw.get("password_source") or "").strip() == "ssh":
            # The build_threecx_script() helper only knows "csv" and
            # "inline" — translate "ssh" to "csv" with column "Password",
            # which is what the threecx script reads as $Password.
            _tcfg_for_pw["password_source"] = "csv"
            _tcfg_for_pw["password_column"] = "Password"
            # Re-generate the per-host script with the rewritten config.
            script = deployer.build_threecx_script(_tcfg_for_pw)
            # Mirror SSH creds into host_vars[label][Password]. Leave
            # any operator-supplied entry alone (defensive: should be
            # absent on Test/Manual paths).
            for _t in targets:
                pw = creds.get(_t.label, "")
                if not pw:
                    continue
                slot = host_vars_by_label.setdefault(_t.label, {})
                slot.setdefault("Password", pw)

    # ---- Per-host root password (custom_script only) ---------------------- #
    # Two sources, mutually exclusive:
    #   • inline (default) — one password typed by the operator, same for every
    #     host. Each target gets the same value in the per-host map.
    #   • csv column        — when each system has a different root password,
    #     the operator names a column in the Compound CSV. We look up each
    #     host's value from host_vars_by_label, populate root_passwords, and
    #     POP that column out of host_vars_by_label so it is NOT exported as
    #     an env var into the script (defense-in-depth: the script already
    #     runs as root, but a leaked variable could be re-used elsewhere).
    root_passwords: Dict[str, str] = {}
    if action == "custom_script":
        inline_root_pw = request.form.get("root_password", "")
        root_pw_column = (request.form.get("root_password_column", "") or "").strip()
        if root_pw_column:
            for label, vars_ in list(host_vars_by_label.items()):
                if root_pw_column in vars_:
                    root_passwords[label] = vars_.pop(root_pw_column)
        elif inline_root_pw:
            for t in targets:
                root_passwords[t.label] = inline_root_pw

    @stream_with_context
    def generate():
        yield _event({
            "type": "meta",
            "action": action,
            "mode": mode,
            "version": cfg.resolved_version if action == "deploy" else "",
            "interpreter": interpreter,
            "count": len(targets),
            "interface": cfg.interface,
            "hep_server": cfg.hep_server,
            "strict_host_keys": cfg.strict_host_keys,
            "warnings": parse_errors,
        })
        for t in targets:
            yield _event({"type": "start", "host": t.label})

        workers = 1 if mode == "test" else min(cfg.max_workers, len(targets))
        succeeded, failed = 0, 0

        # Real-time log streaming: each host thread pushes individual output
        # lines into this queue as they arrive from the SSH channel.  The
        # generator drains it continuously so the browser sees each line the
        # moment the remote script prints it instead of waiting for EOF.
        #
        # Protocol:
        #   {"type": "log",    "host": label, "line": "..."}  — one output line
        #   {"type": "result", ...HostResult fields...}        — host finished
        event_q: _queue_mod.Queue = _queue_mod.Queue()

        def _run(t):
            def _cb(line):
                event_q.put({"type": "log", "host": t.label, "line": line})
            res = deployer.deploy_host(
                t, creds.get(t.label, ""), script, cfg,
                interpreter=interpreter,
                require_marker=require_marker,
                success_text=success_text,
                root_password=root_passwords.get(t.label, ""),
                host_vars=host_vars_by_label.get(t.label),
                log_callback=_cb,
            )
            payload = asdict(res)
            payload["type"] = "result"
            event_q.put(payload)

        with ThreadPoolExecutor(max_workers=workers) as pool:
            for t in targets:
                pool.submit(_run, t)

            done = 0
            while done < len(targets):
                try:
                    ev = event_q.get(timeout=1.0)
                except _queue_mod.Empty:
                    continue
                if ev["type"] == "result":
                    done += 1
                    if ev.get("ok"):
                        succeeded += 1
                    else:
                        failed += 1
                yield _event(ev)

        yield _event({"type": "summary", "succeeded": succeeded,
                      "failed": failed, "total": len(targets)})

    return Response(generate(), mimetype="application/x-ndjson")


def _disable_windows_quickedit() -> None:
    """
    Windows console windows ship with 'QuickEdit Mode' enabled. A stray click
    inside the cmd window silently puts the console into text-selection mode,
    which BLOCKS every subsequent write to stdout (Flask access logs, prints,
    tracebacks) until the user presses Enter or Esc. From the user's point of
    view the app appears to hang.

    Clearing ENABLE_QUICK_EDIT_MODE on the console input handle at startup
    prevents the click-to-freeze behaviour. Best-effort: any failure is
    swallowed so this never blocks startup.
    """
    if os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.windll.kernel32
        STD_INPUT_HANDLE = -10
        ENABLE_EXTENDED_FLAGS  = 0x0080
        ENABLE_QUICK_EDIT_MODE = 0x0040
        ENABLE_MOUSE_INPUT     = 0x0010

        h = kernel32.GetStdHandle(STD_INPUT_HANDLE)
        if not h or h == wintypes.HANDLE(-1).value:
            return
        mode = wintypes.DWORD()
        if not kernel32.GetConsoleMode(h, ctypes.byref(mode)):
            return
        # Must OR-in EXTENDED_FLAGS for the clears to take effect.
        new_mode = (mode.value | ENABLE_EXTENDED_FLAGS) & ~(ENABLE_QUICK_EDIT_MODE | ENABLE_MOUSE_INPUT)
        kernel32.SetConsoleMode(h, new_mode)
    except Exception:
        pass


if __name__ == "__main__":
    _disable_windows_quickedit()
    _limit_mb    = app.config.get("MAX_CONTENT_LENGTH",   0) // (1024 * 1024)
    _fm_limit_mb = app.config.get("MAX_FORM_MEMORY_SIZE", 0) // (1024 * 1024)
    url = f"http://{HOST}:{PORT}"
    print(f" * Batch Device System Manager on {url}")
    print(f"   Upload limit     : {_limit_mb} MB  (MAX_CONTENT_LENGTH)")
    print(f"   Form field limit : {_fm_limit_mb} MB  (MAX_FORM_MEMORY_SIZE)")
    print(f"   Data directory   : {bsm_paths.data_dir()}")
    print("   (click-to-select is disabled on this console so the app can't")
    print("    freeze on a stray click; use Ctrl+C to stop, or close the window.)")
    if os.environ.get("BSM_NO_BROWSER", "").lower() not in {"1", "true", "yes"}:
        threading.Thread(
            target=lambda: (time.sleep(1.0), webbrowser.open(url)),
            daemon=True,
        ).start()
    # threaded=True so the streaming endpoint can fan out SSH work.
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
