from __future__ import annotations

import os
import shutil
import sys


APP_NAME = "Batch System Manager"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def base_dir() -> str:
    if is_frozen():
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def resource_dir() -> str:
    return getattr(sys, "_MEIPASS", base_dir())


def resource_path(*parts: str) -> str:
    return os.path.join(resource_dir(), *parts)


def data_dir() -> str:
    override = os.environ.get("BSM_DATA_DIR")
    candidates: list[str] = []
    if override:
        candidates.append(os.path.abspath(os.path.expanduser(override)))
    if os.name == "nt":
        root = os.environ.get("APPDATA") or os.path.expanduser("~")
        candidates.append(os.path.join(root, APP_NAME))
    else:
        root = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
        candidates.append(os.path.join(root, "batch-system-manager"))
    candidates.append(os.path.join(base_dir(), "data"))
    candidates.append(os.path.join(os.getcwd(), "data"))

    last_error: Exception | None = None
    for path in candidates:
        try:
            os.makedirs(path, exist_ok=True)
            return path
        except OSError as e:
            last_error = e
    raise last_error or OSError("could not create application data directory")


def data_path(*parts: str) -> str:
    path = os.path.join(data_dir(), *parts)
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    return path


def default_scripts_dir() -> str:
    path = data_path("scripts")
    os.makedirs(path, exist_ok=True)
    return path


def default_csv_dir() -> str:
    # Sits next to the scripts/ dir in the data directory. Operators can drop
    # plaintext .csv or encrypted .enc fleet files here to pick from in the UI.
    path = data_path("csv")
    os.makedirs(path, exist_ok=True)
    return path


def seed_default_scripts() -> None:
    src_dir = resource_path("scripts")
    dst_dir = default_scripts_dir()
    if not os.path.isdir(src_dir):
        return
    for name in os.listdir(src_dir):
        if not name.lower().endswith(".sh"):
            continue
        src = os.path.join(src_dir, name)
        dst = os.path.join(dst_dir, name)
        if os.path.isfile(src) and not os.path.exists(dst):
            shutil.copy2(src, dst)


def seed_file_once(resource_name: str, data_name: str | None = None) -> str:
    dst = data_path(data_name or resource_name)
    src = resource_path(resource_name)
    if os.path.isfile(src) and not os.path.exists(dst):
        shutil.copy2(src, dst)
    return dst
