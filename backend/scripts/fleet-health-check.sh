#!/bin/bash
# Combined health snapshot for each PBX — single run gives you a one-page
# answer to "is this system OK?".
#
# Requires: $Password (exposed by default).

BLOCKLIST_HIGH=20000   
BLOCKLIST_LOW=1       
TRUNK_NAME_PREFIXES=("SIP" "NTES")    

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

api_get() {
  local path="$1" tmp
  tmp=$(mktemp /tmp/.bsm_health_XXXXXX)
  wget -q -O "$tmp" --no-check-certificate \
    --header="Authorization: Bearer ${TOKEN}" \
    "${HOST}${path}" || { rm -f "$tmp"; return 1; }
  echo "$tmp"
}

TRUNKS=$(api_get      "/xapi/v1/Trunks")
USERS=$(api_get       "/xapi/v1/Users?\$expand=Phones")
SERVICES=$(api_get    "/xapi/v1/Services")
BLOCKLIST=$(api_get   "/xapi/v1/Blocklist")

HOSTNAME_VAL="$(hostname)" \
TRUNKS_F="$TRUNKS" USERS_F="$USERS" SERVICES_F="$SERVICES" BLOCKLIST_F="$BLOCKLIST" \
BLOCKLIST_HIGH="$BLOCKLIST_HIGH" BLOCKLIST_LOW="$BLOCKLIST_LOW" \
TRUNK_NAME_PREFIXES_CSV="$(IFS=,; echo "${TRUNK_NAME_PREFIXES[*]}")" \
python3 <<'PY'
import json, os

def load(env):
    p = os.environ.get(env, "")
    if not p or not os.path.exists(p): return None
    with open(p, "r") as fh:
        try: return json.load(fh)
        except Exception: return None

host       = os.environ.get("HOSTNAME_VAL", "?")
trunks     = (load("TRUNKS_F")    or {}).get("value", []) or []
users      = (load("USERS_F")     or {}).get("value", []) or []
services   = (load("SERVICES_F")  or {}).get("value", []) or []
blocklist  = (load("BLOCKLIST_F") or {}).get("value", []) or []
hi = int(os.environ.get("BLOCKLIST_HIGH", "20000"))
lo = int(os.environ.get("BLOCKLIST_LOW",  "1"))
trunk_prefixes = [p.strip().lower() for p in os.environ.get("TRUNK_NAME_PREFIXES_CSV", "").split(",") if p.strip()]

findings = []

def is_bridge(t):
    if t.get("IsBridge") or t.get("IsBridgeToMaster"):
        return True
    name = (t.get("Name") or "").lower()
    return ("bridge" in name) or ("webmeeting" in name)

def name_keep(t):
    if not trunk_prefixes:
        return True
    name = (t.get("Name") or "").lower()
    return any(name.startswith(p) for p in trunk_prefixes)

graded_trunks = 0
for t in trunks:
    if is_bridge(t):    continue
    if not name_keep(t): continue
    graded_trunks += 1
    reg = t.get("IsRegistered")
    if reg is None and "Status" in t:
        reg = (str(t.get("Status") or "").lower() == "registered")
    if reg is False:
        findings.append(("FAIL", "trunk",
            f"{t.get('Number','?')} {t.get('Name','')} not registered"))
    elif reg is None:
        findings.append(("WARN", "trunk",
            f"{t.get('Number','?')} {t.get('Name','')} no registration field"))

for u in users:
    if u.get("Enabled"): continue
    phones = u.get("Phones") or []
    if phones:
        macs = ", ".join((p.get("MacAddress") or "?") for p in phones)
        findings.append(("WARN", "user",
            f"ext {u.get('Number','?')} disabled but still has {len(phones)} phone(s): {macs}"))

for u in users:
    if not u.get("Enabled"): continue
    if u.get("IsRegistered"): continue        
    phones = u.get("Phones") or []
    if not phones: continue                   
    macs = ", ".join((p.get("MacAddress") or "?") for p in phones)
    findings.append(("WARN", "phone",
        f"ext {u.get('Number','?')} ({u.get('DisplayName','').strip()}) not registered — {len(phones)} phone(s) offline"))

for s in services:
    state = (s.get("Status") or "").lower()
    if state and state != "running":
        findings.append(("FAIL", "service",
            f"{s.get('ServiceName') or s.get('Name','?')} status={s.get('Status') or '?'}"))

n_block = len(blocklist)
if n_block < lo:
    findings.append(("WARN", "blocklist",
        f"only {n_block} entries — anti-hacking module may be disabled"))
elif n_block > hi:
    findings.append(("WARN", "blocklist",
        f"{n_block} entries (>{hi:,}) — consider pruning stale entries or investigating attack volume"))

fails = sum(1 for s, *_ in findings if s == "FAIL")
warns = sum(1 for s, *_ in findings if s == "WARN")
verdict = "PASS" if not findings else ("FAIL" if fails else "WARN")
print(f"=== {host}: {verdict}  ({fails} fail, {warns} warn) ===")
print(f"   trunks-graded={graded_trunks}/{len(trunks)}  users={len(users)}  services={len(services)}  blocklist={n_block}")
if findings:
    print("   --------")
    for sev, area, detail in findings:
        print(f"   [{sev:4}] {area:<9} {detail}")
PY

rm -f "$TRUNKS" "$USERS" "$SERVICES" "$BLOCKLIST"