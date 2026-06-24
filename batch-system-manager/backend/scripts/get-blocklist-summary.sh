#!/bin/bash
# Summarises each PBX's IP blocklist — total count, breakdown by type
# and country, plus the N most recent additions.
#
# Requires: $Password (exposed by default).

TOP_N=20
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

BL_TMP=$(mktemp /tmp/.bsm_block_XXXXXX)
wget -q -O "$BL_TMP" --no-check-certificate \
  --header="Authorization: Bearer ${TOKEN}" \
  "${HOST}/xapi/v1/Blocklist"

HOSTNAME_VAL="$(hostname)" \
TOP_N="$TOP_N" \
DEBUG="$DEBUG" \
BL_F="$BL_TMP" \
python3 <<'PY'
import os, json
from collections import Counter

host  = os.environ.get("HOSTNAME_VAL", "?")
top_n = int(os.environ.get("TOP_N", "20"))
debug = os.environ.get("DEBUG", "0") == "1"

with open(os.environ["BL_F"], "r") as fh:
    entries = (json.load(fh) or {}).get("value", []) or []

if debug and entries:
    print(f"DEBUG blocklist entry keys: {sorted(entries[0].keys())}")

types     = Counter((e.get("Type") or "?") for e in entries)
countries = Counter((e.get("Country") or e.get("CountryCode") or "?") for e in entries)

print(f"=== {host}: {len(entries)} blocklist entries ===")
print("  by type:")
for t, n in sorted(types.items(), key=lambda x: -x[1]):
    print(f"    {n:>6}  {t}")
print("  by country (top 10):")
for c, n in countries.most_common(10):
    print(f"    {n:>6}  {c}")

def added_at(e):
    return (e.get("DateAdded") or e.get("Created")
            or e.get("AddedAt") or e.get("Date") or "")

recent = sorted(entries, key=added_at, reverse=True)[:top_n]
if recent:
    print()
    print(f"  most recent {len(recent)} additions:")
    print("    --------")
    print(f"    {'IP':<18} {'Type':<8} {'Country':<8} {'Added'}")
    print(f"    {'-'*18} {'-'*8} {'-'*8} {'-'*20}")
    for e in recent:
        ip      = (e.get("Address") or e.get("Ip") or e.get("IpAddress") or "?")
        etype   = (e.get("Type") or "?")
        country = (e.get("Country") or e.get("CountryCode") or "?")
        when    = added_at(e) or "?"
        if "T" in when:
            when = when.split(".")[0].replace("T", " ")
        print(f"    {ip:<18} {etype:<8} {country:<8} {when}")
PY

rm -f "$BL_TMP"