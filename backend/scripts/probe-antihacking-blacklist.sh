#!/bin/bash
# Read-only probe: dumps the full AntiHackingSettings singleton and greps
# Parameters for blacklist-related names, to locate the V20 "Automatic
# Global IP Blacklist" toggle. Changes nothing.
#
# Requires: $Password (exposed by default).

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

AH_TMP=$(mktemp /tmp/.bsm_ah_XXXXXX)
PA_TMP=$(mktemp /tmp/.bsm_pa_XXXXXX)

wget -q -O "$AH_TMP" --no-check-certificate \
  --header="Authorization: Bearer ${TOKEN}" \
  "${HOST}/xapi/v1/AntiHackingSettings"

wget -q -O "$PA_TMP" --no-check-certificate \
  --header="Authorization: Bearer ${TOKEN}" \
  "${HOST}/xapi/v1/Parameters"

HOSTNAME_VAL="$(hostname)" \
AH_F="$AH_TMP" \
PA_F="$PA_TMP" \
python3 <<'PY'
import os, json

host = os.environ.get("HOSTNAME_VAL", "?")

def load(path):
    try:
        with open(path, "r") as fh:
            return json.load(fh)
    except Exception as e:
        return {"__error__": str(e)}

print("=== %s ===" % host)

# --- AntiHackingSettings: dump every field, verbatim -----------------
ah = load(os.environ["AH_F"])
print()
print("  --- AntiHackingSettings (/xapi/v1/AntiHackingSettings) ---")
if "__error__" in ah:
    print("    (fetch/parse failed: %s)" % ah["__error__"])
else:
    keys = [k for k in sorted(ah.keys()) if not k.startswith("@odata")]
    if not keys:
        print("    (no fields returned)")
    for k in keys:
        v = ah[k]
        if isinstance(v, (dict, list)):
            v = json.dumps(v)
            if len(v) > 200:
                v = v[:200] + " ...(truncated)"
        print("    %-40s %s  [%s]" % (k, v, type(ah[k]).__name__))

# --- Parameters: anything that smells like a blacklist toggle --------
pa = load(os.environ["PA_F"])
print()
print("  --- Parameters matching blacklist/blocklist/global ---")
if "__error__" in pa:
    print("    (fetch/parse failed: %s)" % pa["__error__"])
else:
    entries = (pa or {}).get("value", []) or []
    needles = ("BLACKLIST", "BLOCKLIST", "GLOBAL", "ANTIHACK", "ANTI_HACK", "IPBLACK")
    hits = [
        e for e in entries
        if any(n in str(e.get("Name", "")).upper() for n in needles)
    ]
    print("    (%d of %d parameters matched)" % (len(hits), len(entries)))
    for e in sorted(hits, key=lambda x: str(x.get("Name", ""))):
        val = e.get("Value")
        if val is not None and len(str(val)) > 120:
            val = str(val)[:120] + " ...(truncated)"
        print("    %-46s = %s" % (e.get("Name", "?"), val))
PY

rm -f "$AH_TMP" "$PA_TMP"
