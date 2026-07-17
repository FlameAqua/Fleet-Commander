#!/bin/bash
# Read-only: dumps the 3CX xAPI OData $metadata document as a compact,
# pasteable schema listing — every endpoint, whether it is a Singleton or
# an EntitySet, and each property with its exact type (enums expanded).
#
# This is the authoritative schema, not a sample of live data, so it is the
# correct source for TCX_EXTRA_CATALOGS / TCX_ENDPOINTS in catalogs.ts.
#
# Requires: $Password (exposed by default).
#
# Tunables (edit below):
#   TCX_TYPES       comma-separated container names to expand, or "*" for all.
#   TCX_LIST_ONLY   1 = only list endpoints + kind + type, no properties.
#   TCX_DEPTH       how deep to expand ComplexType properties (default 2).
#   TCX_EXPAND_NAV  1 = also expand NavigationProperties (Users.Phones.* etc).
#                   Off by default: these are separate entities, and following
#                   them inflates the dump a lot.

TCX_TYPES="${TCX_TYPES:-AntiHackingSettings,Trunks,Users,OutboundRules,Holidays,Fxs,InboundRules,RingGroups,Queues,Parameters,Blocklist,VoicemailSettings,MailSettings,NotificationSettings,CountryCodes,CodecsSettings,RemoteArchivingSettings,OfficeHours,GeneralSettingsForPbx,SecureSipSettings,CDRSettings,MusicOnHoldSettings,ConferenceSettings,PhonesSettings,FaxServerSettings,BlackListNumbers}"
TCX_LIST_ONLY="${TCX_LIST_ONLY:-0}"
TCX_DEPTH="${TCX_DEPTH:-2}"
TCX_EXPAND_NAV="${TCX_EXPAND_NAV:-0}"

if [ -z "$Password" ]; then echo "ERROR: \$Password is not set." >&2; exit 1; fi
HOST="https://localhost"

JSON_PAYLOAD=$(python3 -c 'import os, json; print(json.dumps({"Username":"0000","Password":os.environ.get("Password",""),"SecurityCode":""}))')
if [ -z "$JSON_PAYLOAD" ]; then echo "ERROR: Failed to safely prepare authentication payload." >&2; exit 1; fi

TOKEN=$(wget -q -O- --no-check-certificate \
  --header="Content-Type: application/json" \
  --post-data="$JSON_PAYLOAD" \
  "${HOST}/webclient/api/Login/GetAccessToken" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('Token', {}).get('access_token', ''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then echo "ERROR: token retrieval failed on $(hostname)" >&2; exit 1; fi

MD_TMP=$(mktemp /tmp/.bsm_md_XXXXXX)

# NOTE: the '$' in $metadata must not be expanded by the shell.
wget -q -O "$MD_TMP" --no-check-certificate \
  --header="Authorization: Bearer ${TOKEN}" \
  --header="Accept: application/xml" \
  "${HOST}/xapi/v1/\$metadata"

if [ ! -s "$MD_TMP" ]; then
  echo "ERROR: \$metadata came back empty on $(hostname)." >&2
  rm -f "$MD_TMP"; exit 1
fi

echo "=== $(hostname): \$metadata is $(wc -c < "$MD_TMP") bytes ==="

HOSTNAME_VAL="$(hostname)" \
MD_F="$MD_TMP" \
TCX_TYPES="$TCX_TYPES" \
TCX_LIST_ONLY="$TCX_LIST_ONLY" \
TCX_DEPTH="$TCX_DEPTH" \
TCX_EXPAND_NAV="$TCX_EXPAND_NAV" \
python3 <<'PY'
import os, sys
import xml.etree.ElementTree as ET

md_f       = os.environ["MD_F"]
want_raw   = (os.environ.get("TCX_TYPES") or "").strip()
list_only  = os.environ.get("TCX_LIST_ONLY", "0") == "1"
max_depth  = int(os.environ.get("TCX_DEPTH", "2"))
expand_nav = os.environ.get("TCX_EXPAND_NAV", "0") == "1"

def tag(el):
    # Strip the XML namespace so we can match on local names only.
    t = el.tag
    return t.rsplit("}", 1)[-1] if "}" in t else t

try:
    root = ET.parse(md_f).getroot()
except Exception as e:
    print("ERROR: could not parse $metadata: %s" % e)
    sys.exit(1)

# --- Index every declared type, keyed both bare and namespace-qualified ---
entity_types, complex_types, enum_types = {}, {}, {}

for schema in root.iter():
    if tag(schema) != "Schema":
        continue
    ns = schema.get("Namespace") or ""
    for child in schema:
        k, name = tag(child), child.get("Name")
        if not name:
            continue
        for key in (name, ns + "." + name):
            if k == "EntityType":
                entity_types[key] = child
            elif k == "ComplexType":
                complex_types[key] = child
            elif k == "EnumType":
                enum_types[key] = child

def resolve(type_ref):
    # "Collection(Pbx.Foo)" -> ("Pbx.Foo", True)
    if not type_ref:
        return "", False
    coll = type_ref.startswith("Collection(")
    if coll:
        type_ref = type_ref[len("Collection("):-1]
    return type_ref, coll

def props_of(el, seen):
    # Walk BaseType chain so inherited properties are included.
    out = []
    base = el.get("BaseType")
    if base:
        b = entity_types.get(base) or complex_types.get(base)
        if b is not None and id(b) not in seen:
            out.extend(props_of(b, seen | {id(b)}))
    for c in el:
        if tag(c) in ("Property", "NavigationProperty"):
            out.append(c)
    return out

def describe(type_ref, coll):
    if type_ref in enum_types:
        members = [m.get("Name") for m in enum_types[type_ref] if tag(m) == "Member"]
        s = "enum(" + "|".join(m for m in members if m) + ")"
    else:
        s = type_ref.replace("Edm.", "")
    return ("Collection<%s>" % s) if coll else s

def dump(el, prefix, depth, seen):
    for p in props_of(el, {id(el)}):
        name = p.get("Name")
        if not name:
            continue
        tref, coll = resolve(p.get("Type"))
        path = prefix + name
        nullable = "" if (p.get("Nullable") or "true") == "true" else " required"
        if tref in complex_types and depth < max_depth and tref not in seen:
            print("    %-52s %s" % (path + ".*" if coll else path, describe(tref, coll)))
            dump(complex_types[tref], (path + ".*." if coll else path + "."),
                 depth + 1, seen | {tref})
        elif tref in entity_types:
            # Navigation to another entity. Inline it only when asked —
            # entity graphs are cyclic (User -> Phone -> ... -> User), so the
            # `seen` set is what stops us recursing forever.
            print("    %-52s -> %s%s" % (path, describe(tref, coll), nullable))
            if expand_nav and depth < max_depth and tref not in seen:
                dump(entity_types[tref], (path + ".*." if coll else path + "."),
                     depth + 1, seen | {tref})
        else:
            print("    %-52s %s%s" % (path, describe(tref, coll), nullable))

# --- The EntityContainer is the list of actual endpoints ---
container = None
for el in root.iter():
    if tag(el) == "EntityContainer":
        container = el
        break

if container is None:
    print("ERROR: no EntityContainer in $metadata.")
    sys.exit(1)

members = []
for c in container:
    k = tag(c)
    if k in ("EntitySet", "Singleton"):
        members.append((c.get("Name"), k, c.get("EntityType") or c.get("Type")))

print()
print("=== ENDPOINTS (%d) — name : kind : type ===" % len(members))
for name, kind, tref in sorted(members):
    print("  %-38s %-10s %s" % (name, kind, tref))

if list_only:
    sys.exit(0)

want = None if want_raw == "*" else {w.strip() for w in want_raw.split(",") if w.strip()}
if want:
    missing = want - {m[0] for m in members}
    if missing:
        print()
        print("  !! not present on this PBX: " + ", ".join(sorted(missing)))

print()
print("=== SCHEMA ===")
for name, kind, tref in sorted(members):
    if want is not None and name not in want:
        continue
    et = entity_types.get(tref or "")
    print()
    print("  --- %s  [%s]  %s ---" % (name, kind, tref))
    if et is None:
        print("    (type not declared in $metadata)")
        continue
    dump(et, "", 0, set())
PY

rm -f "$MD_TMP"
