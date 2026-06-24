#!/bin/bash
# Lists every IP / DECT phone provisioned on each PBX, grouped by Vendor + Model.
# Now queries both standard extensions and the FXS/DECT base station gateway endpoints.
#
# Requires: $Password (exposed by default in Custom Script runs).

# ── Config / Exclusions ──────────────────────────────────────────────────────
SKIP_VENDORS=()
SKIP_MODELS=()
DEBUG=0

# ── Auth ────────────────────────────────────────────────────────────────────
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

# ── Data Collection ─────────────────────────────────────────────────────────
USERS_TMP=$(mktemp /tmp/.bsm_phones_XXXXXX)
wget -q -O "$USERS_TMP" --no-check-certificate \
  --header="Authorization: Bearer ${TOKEN}" \
  "${HOST}/xapi/v1/Users?\$expand=Phones"

FXS_TMP=$(mktemp /tmp/.bsm_fxs_XXXXXX)
wget -q -O "$FXS_TMP" --no-check-certificate \
  --header="Authorization: Bearer ${TOKEN}" \
  "${HOST}/xapi/v1/Fxs"

# ── Processing Engine ────────────────────────────────────────────────────────
HOSTNAME_VAL="$(hostname)" \
SKIP_VENDORS_CSV="$(IFS=,; echo "${SKIP_VENDORS[*]}")" \
SKIP_MODELS_CSV="$(IFS=,; echo "${SKIP_MODELS[*]}")" \
DEBUG="$DEBUG" \
USERS_F="$USERS_TMP" \
FXS_F="$FXS_TMP" \
python3 <<'PY'
import os, json, re
from collections import Counter

host    = os.environ.get("HOSTNAME_VAL", "?")
v_skip  = [s.strip().lower() for s in os.environ.get("SKIP_VENDORS_CSV", "").split(",") if s.strip()]
m_skip  = [s.strip().lower() for s in os.environ.get("SKIP_MODELS_CSV",  "").split(",") if s.strip()]
debug   = os.environ.get("DEBUG", "0") == "1"

with open(os.environ["USERS_F"], "r") as fh:
    users = (json.load(fh) or {}).get("value", []) or []

fxs_list = []
if os.path.exists(os.environ.get("FXS_F", "")):
    try:
        with open(os.environ["FXS_F"], "r") as fh:
            fxs_list = (json.load(fh) or {}).get("value", []) or []
    except Exception:
        pass

if debug:
    for u in users:
        phones0 = u.get("Phones") or []
        if phones0:
            print("DEBUG first phone record (truncated to 1500 chars):")
            print("  " + json.dumps(phones0[0], indent=2, default=str)[:1500])
            print()
            break
    if fxs_list:
        print("DEBUG first FXS record (truncated to 1500 chars):")
        print("  " + json.dumps(fxs_list[0], indent=2, default=str)[:1500])
        print()

_VER_RE = re.compile(r"^\d+(?:\.\d+){1,5}$")

def parse_user_agent(ua):
    if not ua: return ("", "", "")
    ua = ua.replace("/", " ")
    parts = [p for p in ua.strip().split() if p]
    if not parts: return ("", "", "")
    vendor = parts[0]
    firmware = ""
    fw_idx = None
    for i, p in enumerate(parts[1:], start=1):
        if _VER_RE.match(p):
            firmware = p
            fw_idx = i
            break
    model_parts = parts[1:fw_idx] if fw_idx is not None else parts[1:]
    if not firmware and model_parts:
        last = model_parts[-1]
        if re.match(r"^[0-9a-fA-F:.\-]{12,17}$", last):
            model_parts = model_parts[:-1]
    model = " ".join(model_parts)
    model = re.sub(r"^SIP[-_ ]", "", model, flags=re.I).strip()
    return (vendor, model, firmware)

def derive_phone_info(ph):
    name = (ph.get("Name") or "").strip()
    v = m = ""
    if name:
        parts = name.split(None, 1)
        v = parts[0]
        m = parts[1] if len(parts) > 1 else ""

    settings = ph.get("Settings") or {}
    f = (settings.get("Firmware") or settings.get("FirmwareVersion") or "").strip()
    f = re.sub(r"\.(z|rom|bin|fw|img|tar|gz|zip)$", "", f, flags=re.I)

    if not v: v = (ph.get("Vendor") or "").strip()
    if not m: m = (ph.get("Model")  or "").strip()
    if not f: f = (ph.get("FirmwareVersion") or "").strip()

    if not v or not m or not f:
        ua = ((ph.get("Registrar") or {}).get("UserAgent") or ph.get("UserAgent") or "")
        if ua:
            uv, um, uf = parse_user_agent(ua)
            if not v: v = uv
            if not m: m = um
            if not f: f = uf

    return (v, m, f)

rows = []
filtered = 0
seen = set()

# 1. Parse Standalone Desk Phones (from Users Endpoint)
for u in users:
    ext       = (u.get("Number") or "").strip()
    name      = (u.get("DisplayName") or u.get("FirstName") or "").strip()
    user_reg  = bool(u.get("IsRegistered"))
    enabled   = bool(u.get("Enabled", True))
    for ph in (u.get("Phones") or []):
        vendor, model, fw = derive_phone_info(ph)
        mac = (ph.get("MacAddress") or "").strip()
        
        if any(s in vendor.lower() for s in v_skip):
            filtered += 1; continue
        if any(s in model.lower() for s in m_skip):
            filtered += 1; continue
            
        state = "registered" if user_reg else ("offline" if enabled else "disabled")
        
        row_key = (mac.lower(), ext)
        if row_key not in seen:
            seen.add(row_key)
            rows.append((vendor or "?", model or "?", ext, name, mac, fw or "?", state))

# 2. Parse Gateways / Cordless Bases (from FXS Endpoint)
for f in fxs_list:
    base_name = (f.get("Name") or f.get("Description") or "").strip()
    base_vendor = (f.get("Vendor") or "").strip()
    base_model = (f.get("Model") or "").strip()
    mac = (f.get("MacAddress") or f.get("Mac") or "").strip()
    
    if not base_vendor and base_name:
        parts = base_name.split(None, 1)
        base_vendor = parts[0]
        base_model = parts[1] if len(parts) > 1 else ""

    settings = f.get("Settings") or {}
    fw = (f.get("FirmwareVersion") or f.get("Firmware") or settings.get("Firmware") or "?").strip()
    fw = re.sub(r"\.(z|rom|bin|fw|img|tar|gz|zip)$", "", fw, flags=re.I)
    
    is_reg = f.get("IsRegistered") or (str(f.get("Status") or "").lower() == "registered")
    base_state = "registered" if is_reg or f.get("IsRegistered") is None else "offline"

    if any(s in base_vendor.lower() for s in v_skip):
        filtered += 1; continue
    if any(s in base_model.lower() for s in m_skip):
        filtered += 1; continue

    lines_found = False
    for key_f in ["Extensions", "Lines", "AssignedExtensions"]:
        val = f.get(key_f)
        if isinstance(val, list) and val:
            for item in val:
                lines_found = True
                ext_num = ""
                ext_name = base_name
                if isinstance(item, dict):
                    ext_num = str(item.get("Number") or item.get("Extension") or "")
                    if item.get("Name"): 
                        ext_name = str(item.get("Name"))
                else:
                    ext_num = str(item)
                
                row_key = (mac.lower(), ext_num)
                if row_key not in seen:
                    seen.add(row_key)
                    rows.append((base_vendor or "?", base_model or "?", ext_num or "DECT", ext_name, mac, fw or "?", base_state))
    
    # Handle base stations or analog gateways without mapped extensions
    if not lines_found:
        row_key = (mac.lower(), "FXS")
        if row_key not in seen:
            seen.add(row_key)
            rows.append((base_vendor or "?", base_model or "?", "FXS", base_name, mac, fw or "?", base_state))

# ── Render Presentation Layer ────────────────────────────────────────────────
suffix = f" ({filtered} filtered)" if filtered else ""
print(f"=== {host}: {len(rows)} phones{suffix} ===")

counts = Counter((v, m) for v, m, *_ in rows)
print("  -------- model summary --------")
for (v, m), n in sorted(counts.items(), key=lambda x: (-x[1], x[0])):
    print(f"  {n:>4}  {v} {m}")

print()
print("  -------- detail --------")
print(f"  {'Ext':<6} {'Vendor':<10} {'Model':<14} {'MAC':<14} {'Firmware':<14} {'State':<11} {'Name'}")
print(f"  {'-'*6} {'-'*10} {'-'*14} {'-'*14} {'-'*14} {'-'*11} {'-'*20}")
for vendor, model, ext, name, mac, fw, state in sorted(rows, key=lambda r: (r[0], r[1], r[2])):
    print(f"  {ext:<6} {vendor:<10} {model:<14} {mac:<14} {fw:<14} {state:<11} {name}")
PY

# ── Cleanup ─────────────────────────────────────────────────────────────────
rm -f "$USERS_TMP" "$FXS_TMP"