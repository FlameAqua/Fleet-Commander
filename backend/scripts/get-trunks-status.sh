#!/bin/bash
# Lists every SIP trunk on each PBX with registration state and provider information.
#
# Requires: $Password (exposed by default).

ONLY_FAILED=0
NAME_PREFIXES=("SIP" "NTES")
DEBUG=0

if [ -z "$Password" ]; then echo "ERROR: \$Password is not set." >&2; exit 1; fi
USERNAME="0000"; HOST="https://localhost"

JSON_PAYLOAD=$(python3 -c 'import os, json; print(json.dumps({"Username":"0000","Password":os.environ.get("Password",""),"SecurityCode":""}))')
if [ -z "$JSON_PAYLOAD" ]; then echo "ERROR: Failed to safely prepare authentication payload." >&2; exit 1; fi

TOKEN=$(wget -q -O- --no-check-certificate \
  --header="Content-Type: application/json" \
  --post-data="$JSON_PAYLOAD" \
  "${HOST}/webclient/api/Login/GetAccessToken" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('Token', {}).get('access_token', ''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then echo "ERROR: token retrieval failed on $(hostname)" >&2; exit 1; fi

TRUNKS_TMP=$(mktemp /tmp/.bsm_trunks_XXXXXX)
wget -q -O "$TRUNKS_TMP" --no-check-certificate \
  --header="Authorization: Bearer ${TOKEN}" \
  "${HOST}/xapi/v1/Trunks"

HOSTNAME_VAL="$(hostname)" \
ONLY_FAILED="$ONLY_FAILED" \
DEBUG="$DEBUG" \
NAME_PREFIXES_CSV="$(IFS=,; echo "${NAME_PREFIXES[*]}")" \
TRUNKS_F="$TRUNKS_TMP" \
python3 <<'PY'
import os, json

host        = os.environ.get("HOSTNAME_VAL", "?")
only_failed = os.environ.get("ONLY_FAILED", "0") == "1"
debug       = os.environ.get("DEBUG", "0") == "1"
prefixes    = [p.strip().lower() for p in os.environ.get("NAME_PREFIXES_CSV", "").split(",") if p.strip()]

with open(os.environ["TRUNKS_F"], "r") as fh:
    trunks = (json.load(fh) or {}).get("value", []) or []

if debug and trunks:
    print(f"DEBUG fields on first trunk: {sorted(trunks[0].keys())}")

def is_bridge(t):
    if t.get("IsBridge") or t.get("IsBridgeToMaster"):
        return True
    name = (t.get("Name") or "").lower()
    if "bridge" in name or "webmeeting" in name:
        return True
    return False

def name_keep(t):
    if not prefixes:
        return True
    name = (t.get("Name") or "").lower()
    return any(name.startswith(p) for p in prefixes)

rows = []
total = len(trunks)
filtered_bridges = 0
filtered_name = 0
for t in trunks:
    if is_bridge(t):
        filtered_bridges += 1
        continue
    if not name_keep(t):
        filtered_name += 1
        continue
    reg_bool = t.get("IsRegistered")
    if reg_bool is None and "Status" in t:
        reg_bool = (str(t.get("Status") or "").lower() == "registered")
    state = "registered" if reg_bool else ("OFFLINE" if reg_bool is False else "unknown")
    if only_failed and reg_bool is True:
        continue
    name   = (t.get("Name") or "").strip()
    number = (t.get("Number") or "").strip()
    enabled = "yes" if t.get("Enabled", True) else "DISABLED"
    provider = (t.get("ProviderName") or t.get("AuthID") or "").strip()
    max_calls = t.get("SimultaneousCalls") or t.get("MaxSimCalls") or "?"
    rows.append((number, name, state, enabled, provider, max_calls))

healthy = sum(1 for r in rows if r[2] == "registered" and r[3] == "yes")
suffix = ""
if filtered_bridges or filtered_name:
    suffix = f"   ({filtered_bridges} bridge, {filtered_name} other-name filtered out of {total})"
print(f"=== {host}: {len(rows)} trunks shown ({healthy} healthy){suffix} ===")
print("  --------")
print(f"  {'Num':<8} {'Name':<22} {'State':<11} {'Enabled':<9} {'MaxCh':>5}  {'Provider'}")
print(f"  {'-'*8} {'-'*22} {'-'*11} {'-'*9} {'-'*5}  {'-'*20}")
for number, name, state, enabled, provider, max_calls in sorted(rows, key=lambda r: (r[1].lower(), r[0])):
    print(f"  {number:<8} {name:<22} {state:<11} {enabled:<9} {str(max_calls):>5}  {provider}")
PY

rm -f "$TRUNKS_TMP"