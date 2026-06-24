"""
encrypt_csv.py — turn a plaintext CSV (or any text file) into a
master-password-encrypted `.enc` blob.

Usage:
    python encrypt_csv.py <path-to-plaintext.csv>

The encrypted output lands next to the input as `<basename>.enc`. The
master password is read interactively (hidden) and confirmed by a second
prompt so a typo can't lock you out of your own file.

Output format (matches scraper.py + decrypt_csv.py):
    [ 16 bytes salt ] [ Fernet token (variable length) ]

Crypto choices (all match Fernet's recipe so the output is exchangeable
with the existing scraper-encrypted files):
    • KDF       PBKDF2-HMAC-SHA256, 480_000 iterations, 32-byte key
    • Encrypt   Fernet (AES-128-CBC + HMAC-SHA256, version-byte framing)
    • Salt      16 random bytes from os.urandom (per-file, never reused)
"""

from __future__ import annotations

import base64
import getpass
import os
import sys

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC


PBKDF2_ITERS = 480_000
SALT_BYTES   = 16


def _make_fernet(password: str, salt: bytes) -> Fernet:
    """Derive a Fernet instance from a master password + salt."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERS,
    )
    return Fernet(base64.urlsafe_b64encode(kdf.derive(password.encode())))


def _prompt_password_with_confirm() -> str:
    """
    Prompt for a master password twice; bail if the two entries differ.
    Hidden input (getpass) so the password never appears on the terminal
    or in shell history. Empty passwords are rejected — Fernet would
    technically accept them but they offer zero protection.
    """
    while True:
        pw1 = getpass.getpass("Master password: ")
        if not pw1:
            print("Password can't be empty. Try again.", file=sys.stderr)
            continue
        pw2 = getpass.getpass("Confirm password: ")
        if pw1 != pw2:
            print("Passwords didn't match. Try again.", file=sys.stderr)
            continue
        return pw1


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {os.path.basename(argv[0])} <path-to-csv>", file=sys.stderr)
        return 2

    in_path = os.path.abspath(argv[1])
    if not os.path.isfile(in_path):
        print(f"ERROR: not a file: {in_path}", file=sys.stderr)
        return 1

    # Output next to the input, swapping the extension to .enc. We refuse
    # to overwrite an existing .enc without confirmation — easy mistake
    # when re-encrypting and would silently destroy whatever was there.
    base, _ = os.path.splitext(in_path)
    out_path = base + ".enc"
    if os.path.exists(out_path):
        ans = input(f"{out_path} already exists. Overwrite? [y/N] ").strip().lower()
        if ans not in ("y", "yes"):
            print("Aborted.")
            return 1

    # Read the plaintext as bytes so we don't accidentally transcode
    # whatever encoding the source uses (CSVs from Excel are often
    # cp1252 or UTF-8-BOM). Fernet doesn't care about the encoding.
    with open(in_path, "rb") as fh:
        plaintext = fh.read()

    master_password = _prompt_password_with_confirm()
    salt = os.urandom(SALT_BYTES)
    token = _make_fernet(master_password, salt).encrypt(plaintext)

    # Write with O_TRUNC so any pre-existing content is fully replaced
    # (the overwrite confirmation above is the user's intent, this just
    # makes the actual write atomic from a length perspective).
    with open(out_path, "wb") as fh:
        fh.write(salt + token)

    print(f"Encrypted {len(plaintext)} bytes -> {out_path}")
    print("Keep your master password safe — without it the file is unrecoverable.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
