# Fleet Commander — SBOM & Vulnerability Report

Generated for beta 7. Covers both dependency trees of the application: the
Electron/React renderer (npm) and the Flask sidecar (Python).

## Artifacts

| File | Ecosystem | Format |
| ---- | --------- | ------ |
| `sbom-npm.json`    | npm (production deps)     | CycloneDX 1.x |
| `sbom-python.json` | Python (backend `.venv`)  | CycloneDX 1.x |

Regenerate:

```powershell
# npm (production only)
npx @cyclonedx/cyclonedx-npm --omit dev --output-file sbom/sbom-npm.json

# python (against the backend venv, using out-of-venv tooling)
python -m cyclonedx_py environment backend/.venv --output-file sbom/sbom-python.json

# vulnerability scan
npm audit
backend/.venv/Scripts/python.exe -m pip_audit
```

## Vulnerability scan results

### npm — `npm audit`
**0 vulnerabilities** (production and dev).

### Python — `pip-audit`
Initial scan found **7 findings across 2 packages**. All remediated by
upgrading; a re-scan reports **no known vulnerabilities**.

| Package | Was | Now | Advisories fixed |
| ------- | --- | --- | ---------------- |
| `cryptography` | 45.0.7 | 49.0.0 | GHSA-537c-gmf6-5ccf (bundled OpenSSL), PYSEC-2026-35 (DNS name-constraint bypass), PYSEC-2026-36 (buffer overflow on non-contiguous buffers), CVE-2026-26007 (EC subgroup check) |
| `paramiko` | 3.5.1 | 5.0.0 | CVE-2026-44405 (`rsakey.py` allowed SHA-1) |

`backend/requirements.txt` was tightened accordingly:

```
paramiko>=4.0,<6.0        # CVE-2026-44405 fixed in 4.0+
cryptography>=48.0.1,<50.0 # OpenSSL advisory fixed in 48.0.1+
```

### Compatibility notes
- paramiko 3.x → 5.x is a major bump. The backend uses only stable API
  (`SSHClient`, `MissingHostKeyPolicy`, `RejectPolicy`, `HostKeys`,
  `get_transport`, `AuthenticationException`/`SSHException`). Backend imports
  and the custom TOFU host-key policy verified working post-upgrade.
- cryptography is used only for the CSV Fernet/PBKDF2 encryption path and via
  paramiko; no API changes affect it.

## Scope / caveats
- The Python SBOM is generated from the backend `.venv`, which also contains
  the PyInstaller build toolchain (`pyinstaller`, `altgraph`, `pefile`,
  `pywin32-ctypes`) and residual dev-time transitive packages. **None of these
  ship in the packaged app** — PyInstaller bundles by import graph from
  `app.py`, not by installed set. The `pip-audit` scan covered the entire venv
  regardless and is clean.
