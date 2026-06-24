#!/bin/bash
# Checks the 3CX PBX for any provisioned phone matching a specific keyword.
# Robustly handles special characters (", $, &, ~) in the system password.
# Includes MAC address OUI fallback matching for unnamed Yealink DECT bases.
#
# Returns exit code 0 if found, or exit 2 if missing.
#
# Requires: $Password (exposed by default in Custom Script runs).

# ── Config (Edit Me) ─────────────────────────────────────────────────────────
TARGET_DEVICE="Yealink"
DEVICE_SCOPE="fxs"      # Options: "desk" (desk phones only), "fxs" (cordless/DECT only), "both"

# ── Auth ────────────────────────────────────────────────────────────────────
if [ -z "$Password" ]; then echo "ERROR: \$Password is not set." >&2; exit 1; fi
USERNAME="0000"; HOST="https://localhost"

# Use Python to safely pull the password from the environment and construct valid JSON
JSON_PAYLOAD=$(python3 -c 'import os, json; print(json.dumps({"Username":"0000","Password":os.environ.get("Password",""),"SecurityCode":""}))')

if [ -z "$JSON_PAYLOAD" ]; then echo "ERROR: Failed to safely prepare authentication payload." >&2; exit 1; fi

TOKEN=$(wget -q -O- --no-check-certificate \
  --header="Content-Type: application/json" \
  --post-data="$JSON_PAYLOAD" \
  "${HOST}/webclient/api/Login/GetAccessToken" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('Token', {}).get('access_token', ''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then echo "ERROR: token retrieval failed on $(hostname) (Check password integrity or 2FA)" >&2; exit 1; fi

# ── Fetch Data ──────────────────────────────────────────────────────────────
USERS_TMP=$(mktemp /tmp/.bsm_check_XXXXXX)
wget -q -O "$USERS_TMP" --no-check-certificate \
  --header="Authorization: Bearer ${TOKEN}" \
  "${HOST}/xapi/v1/Users?\$expand=Phones"

FXS_TMP=$(mktemp /tmp/.bsm_fxs_XXXXXX)
wget -q -O "$FXS_TMP" --no-check-certificate \
  --header="Authorization: Bearer ${TOKEN}" \
  "${HOST}/xapi/v1/Fxs"

# ── Parse and Verify via Python ──────────────────────────────────────────────
TARGET_DEVICE="$TARGET_DEVICE" \
DEVICE_SCOPE="$DEVICE_SCOPE" \
USERS_F="$USERS_TMP" \
FXS_F="$FXS_TMP" \
python3 <<'PY'
import os, json, sys

target = os.environ.get("TARGET_DEVICE", "").strip().lower()
scope = os.environ.get("DEVICE_SCOPE", "both").strip().lower()

# Known Yealink MAC Address OUI prefixes (normalized to lowercase, alphanumeric)
YEALINK_OUIS = {"001565", "249ad8", "44dbd2", "805e0c", "805ec0", "c4fc22"}

if not target:
    print("ERROR: TARGET_DEVICE environment variable is empty.")
    sys.exit(1)

matches = []

# 1. Parse standard desk phones (Only if scope is "desk" or "both")
if scope in ("desk", "both"):
    with open(os.environ["USERS_F"], "r") as fh:
        users = (json.load(fh) or {}).get("value", []) or []

    for u in users:
        ext = (u.get("Number") or "").strip()
        for ph in (u.get("Phones") or []):
            name = (ph.get("Name") or "").strip()
            mac = ''.join(c for c in (ph.get("MacAddress") or ph.get("Mac") or "") if c.isalnum()).lower()
            
            if name:
                parts = name.split(None, 1)
                vendor = parts[0].lower()
                model = parts[1].lower() if len(parts) > 1 else ""
            else:
                vendor = model = ""

            # Match by name string or via Yealink OUI fallback
            is_yealink = (target in name.lower() or target in vendor or target in model or (target == "yealink" and mac[:6] in YEALINK_OUIS))
            
            if is_yealink:
                matches.append(f"Ext {ext} ({name})")

# 2. Parse FXS / DECT devices (Only if scope is "fxs" or "both")
if scope in ("fxs", "both") and os.path.exists(os.environ.get("FXS_F", "")):
    with open(os.environ["FXS_F"], "r") as fh:
        fxs_list = (json.load(fh) or {}).get("value", []) or []
    
    for f in fxs_list:
        name = (f.get("Name") or f.get("Description") or "").strip()
        vendor = (f.get("Vendor") or "").strip()
        model = (f.get("Model") or "").strip()
        mac = (f.get("MacAddress") or f.get("Mac") or "").strip()
        mac_clean = ''.join(c for c in mac if c.isalnum()).lower()
        
        if not vendor and name:
            parts = name.split(None, 1)
            vendor = parts[0]
            model = parts[1] if len(parts) > 1 else ""

        combined_text = f"{name} {vendor} {model} {mac}".lower()
        
        # Match by text context OR see if it uses a known Yealink MAC prefix
        is_yealink = (target in combined_text or (target == "yealink" and mac_clean[:6] in YEALINK_OUIS))
        
        if is_yealink:
            # Reconstruct linked extensions inside the DECT group
            ext_list = []
            for key in ["Extensions", "Lines", "AssignedExtensions"]:
                val = f.get(key)
                if isinstance(val, list):
                    for item in val:
                        if isinstance(item, dict):
                            num = item.get("Number") or item.get("Extension")
                            if num: ext_list.append(str(num))
                        elif item:
                            ext_list.append(str(item))
            
            ext_str = ", ".join(sorted(list(set(ext_list)))) if ext_list else "DECT Base"
            disp_vendor = vendor if vendor else "Yealink (Detected via MAC)"
            matches.append(f"FXS/DECT Base [{ext_str}] ({disp_vendor} {model} - MAC: {mac})")

if matches:
    scope_lbl = f" [{scope.upper()} ONLY]" if scope != "both" else ""
    print(f"SUCCESS: Found {len(matches)} device(s) matching '{os.environ['TARGET_DEVICE']}'{scope_lbl}:")
    for m in matches:
        print(f"  - {m}")
    sys.exit(0)
else:
    scope_lbl = f" within scope context '{scope}'" if scope != "both" else ""
    print(f"FAILURE: No devices matching '{os.environ['TARGET_DEVICE']}' found on this system{scope_lbl}.")
    sys.exit(2)
PY

# Capture Python's exit code, clean up all temp files, and bubble the code up
EXIT_CODE=$?
rm -f "$USERS_TMP" "$FXS_TMP"
exit $EXIT_CODE