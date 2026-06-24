# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Fleet Commander backend sidecar.
# Build (from backend/, with the venv active):
#   pyinstaller --noconfirm --clean fleet-commander-backend.spec
# Produces dist/fleet-commander-backend(.exe) — a single self-contained binary
# that Electron spawns. The renderer SPA is NOT bundled here; Electron passes
# its location via BSM_SPA_DIR and Flask serves it.

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

hiddenimports = collect_submodules("cryptography") + collect_submodules("paramiko")


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
    a.binaries,
    a.datas,
    [],
    name="fleet-commander-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
