#!/bin/bash
# Lists extensions safely across systems with difficult password characters.

if [ -z "$Password" ]; then
  echo "ERROR: \$Password is not set. Tick 'Expose \$Password to the script' in the Custom Script pane." >&2
  exit 1
fi

USERNAME="0000"
HOST="https://localhost"

JSON_PAYLOAD=$(python3 -c 'import os, json; print(json.dumps({"Username":"0000","Password":os.environ.get("Password",""),"SecurityCode":""}))')
if [ -z "$JSON_PAYLOAD" ]; then echo "ERROR: Failed to safely prepare authentication payload." >&2; exit 1; fi

TOKEN=$(wget -q -O- --no-check-certificate \
  --header="Content-Type: application/json" \
  --post-data="$JSON_PAYLOAD" \
  "${HOST}/webclient/api/Login/GetAccessToken" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('Token', {}).get('access_token', ''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to retrieve token on $(hostname)" >&2
  exit 1
fi

wget -q -O- --no-check-certificate \
  --header="Authorization: Bearer ${TOKEN}" \
  "${HOST}/xapi/v1/Users" \
| HOSTNAME_VAL="$(hostname)" python3 -c "
import sys, json, os
users = json.load(sys.stdin).get('value', [])
host  = os.environ.get('HOSTNAME_VAL', '?')

def sortkey(u):
    n = (u.get('Number') or '').strip()
    try: return (0, int(n))
    except ValueError: return (1, n)

enabled = [u for u in users if u.get('Enabled')]
print(f'=== {host}: {len(users)} extensions ({len(enabled)} enabled, {len(users) - len(enabled)} disabled) ===')
print(f'  {\"Ext\":<8} {\"State\":<9} {\"Reg\":<11} {\"Name\"}')
print(f'  {\"-\"*8} {\"-\"*9} {\"-\"*11} {\"-\"*30}')

for u in sorted(users, key=sortkey):
    num     = u.get('Number') or '?'
    name    = (u.get('DisplayName') or u.get('FirstName') or '').strip()
    state   = 'enabled' if u.get('Enabled') else 'DISABLED'
    reg     = 'registered' if u.get('IsRegistered') else 'offline'
    print(f'  {num:<8} {state:<9} {reg:<11} {name}')
"