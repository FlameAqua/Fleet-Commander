"""
decrypt_csv.py — recover a plaintext CSV from a master-password-encrypted
`.enc` blob written by encrypt_csv.py / scraper.py.

Usage:
    python decrypt_csv.py <path-to-file.enc>

Prompts for the master password once (hidden input). The plaintext output
lands next to the input as `<basename>.csv`. If the password is wrong or
the file has been tampered with, Fernet's HMAC will fail and decryption
aborts with a clear error — no partial / garbage CSV is ever written.

Output format mirrors what scraper.py writes (and what encrypt_csv.py
writes):
    [ 16 bytes salt ] [ Fernet token (variable length) ]

Delete the decrypted .csv when you're done with it — the whole point of
the `.enc` flow is that the plaintext only exists transiently. The Batch
System Manager app accepts `.enc` files directly so you typically don't
need to run this script at all; it's here for offline inspection.
"""

from __future__ import annotations

import base64
import getpass
import os
import sys

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC


PBKDF2_ITERS = 480_000
SALT_BYTES   = 16


def _make_fernet(password: str, salt: bytes) -> Fernet:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERS,
    )
    return Fernet(base64.urlsafe_b64encode(kdf.derive(password.encode())))


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {os.path.basename(argv[0])} <path-to-file.enc>", file=sys.stderr)
        return 2

    in_path = os.path.abspath(argv[1])
    if not os.path.isfile(in_path):
        print(f"ERROR: not a file: {in_path}", file=sys.stderr)
        return 1

    base, ext = os.path.splitext(in_path)
    out_path = base + ".csv"
    if os.path.exists(out_path):
        # Decryption produces fresh plaintext from an authoritative source
        # (the .enc), so overwriting an old plaintext copy is usually the
        # operator's intent. Still ask, because that old copy might have
        # been hand-edited.
        ans = input(f"{out_path} already exists. Overwrite? [y/N] ").strip().lower()
        if ans not in ("y", "yes"):
            print("Aborted.")
            return 1

    # Slurp the whole .enc — Fernet tokens are short (KBs, not MBs even
    # for a few-hundred-row CSV) so the memory cost is negligible.
    with open(in_path, "rb") as fh:
        data = fh.read()

    if len(data) <= SALT_BYTES:
        print(f"ERROR: {in_path} is too short to be a valid .enc file "
              f"(got {len(data)} bytes, need > {SALT_BYTES}).", file=sys.stderr)
        return 1

    salt, token = data[:SALT_BYTES], data[SALT_BYTES:]
    master_password = getpass.getpass("Master password: ")
    if not master_password:
        print("Password can't be empty.", file=sys.stderr)
        return 1

    try:
        plaintext = _make_fernet(master_password, salt).decrypt(token)
    except InvalidToken:
        # Fernet raises InvalidToken for both wrong-password and
        # tampered-ciphertext cases — we can't tell them apart without
        # weakening the auth tag, so report both possibilities.
        print("ERROR: wrong password or file is corrupted.", file=sys.stderr)
        return 1

    # Write the plaintext verbatim — we don't know or care what encoding
    # the original file used, and re-encoding could mangle non-ASCII
    # characters in passwords (umlauts, accents, etc.).
    with open(out_path, "wb") as fh:
        fh.write(plaintext)

    print(f"Decrypted {len(plaintext)} bytes -> {out_path}")
    print("Remember: delete the plaintext .csv when you're done with it.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
