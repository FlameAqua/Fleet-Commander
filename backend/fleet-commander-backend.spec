# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Fleet Commander backend sidecar.
# Build (from backend/, with the venv active):
#   pyinstaller --noconfirm --clean fleet-commander-backend.spec
# Produces a ONEDIR bundle: dist/fleet-commander-backend/ containing the
# launcher exe plus its unpacked dependencies. Electron spawns
# dist/fleet-commander-backend/fleet-commander-backend(.exe).
#
# Why onedir (not onefile): a onefile exe unpacks the entire Python runtime +
# every native lib into a fresh temp dir on EVERY launch before the app can
# start — several seconds of cold start. Onedir keeps everything unpacked on
# disk, so launch is near-instant. The tradeoff is a folder instead of a single
# file, which is fine since electron-builder ships it inside resources/backend/.
#
# The renderer SPA is NOT bundled here; Electron passes its location via
# BSM_SPA_DIR and Flask serves it.

from PyInstaller.utils.hooks import collect_submodules


# Data files the app reads at runtime via bsm_paths.resource_path(...).
# templates/ is the legacy Jinja fallback; kept so a standalone backend run
# (without BSM_SPA_DIR) still works.
datas = [
    ("templates", "templates"),
    ("static", "static"),
    ("scripts", "scripts"),
    ("README.md", "."),
    ("known_hosts", "."),
]

hiddenimports = (
    collect_submodules("cryptography")
    + collect_submodules("paramiko")
    # pykeepass loads these lazily (argon2 KDF, AES, XML), so PyInstaller
    # cannot see them by static analysis.
    + collect_submodules("pykeepass")
    + collect_submodules("construct")
    + collect_submodules("argon2")
    + collect_submodules("Cryptodome")
)


a = Analysis(
    ["app.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="fleet-commander-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="fleet-commander-backend",
)
