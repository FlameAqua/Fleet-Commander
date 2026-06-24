#!/bin/bash
# Lists every call queue on each PBX along with its agents and routing overflow targets.
#
# Requires: $Password (exposed by default).

ONLY_EMPTY=0
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

QUEUES_TMP=$(mktemp /tmp/.bsm_queues_XXXXXX)
wget -q -O "$QUEUES_TMP" --no-check-certificate \
  --header="Authorization: Bearer ${TOKEN}" \
  "${HOST}/xapi/v1/Queues?\$expand=Agents"

HOSTNAME_VAL="$(hostname)" \
ONLY_EMPTY="$ONLY_EMPTY" \
DEBUG="$DEBUG" \
QUEUES_F="$QUEUES_TMP" \
python3 <<'PY'
import os, json

host       = os.environ.get("HOSTNAME_VAL", "?")
only_empty = os.environ.get("ONLY_EMPTY", "0") == "1"
debug      = os.environ.get("DEBUG", "0") == "1"

with open(os.environ["QUEUES_F"], "r") as fh:
    queues = (json.load(fh) or {}).get("value", []) or []

if debug and queues:
    print(f"DEBUG queue keys: {sorted(queues[0].keys())}")

rows = []
for q in queues:
    num     = (q.get("Number") or "").strip()
    name    = (q.get("Name")   or "").strip()
    agents  = q.get("Agents") or []
    a_nums  = [str((a.get("Number") or "").strip()) for a in agents]
    a_nums  = [n for n in a_nums if n]
    strategy = (q.get("PollingStrategy") or q.get("Strategy") or "?").strip()
    overflow = (q.get("NotifyCodeOnFailure") or q.get("DestinationOnNoAnswer") or "").strip()
    if only_empty and a_nums and overflow:
        continue
    rows.append((num, name, strategy, a_nums, overflow))

print(f"=== {host}: {len(rows)} queues ===")
print("  --------")
print(f"  {'Num':<6} {'Strategy':<14} {'Agents':>6}  {'Overflow':<14} {'Name'}")
print(f"  {'-'*6} {'-'*14} {'-'*6}  {'-'*14} {'-'*20}")
for num, name, strategy, a_nums, overflow in sorted(rows):
    agent_count = len(a_nums)
    overflow_disp = overflow if overflow else "(none)"
    print(f"  {num:<6} {strategy:<14} {agent_count:>6}  {overflow_disp:<14} {name}")
    if a_nums:
        print(f"           agents: {','.join(a_nums)}")
PY

rm -f "$QUEUES_TMP"