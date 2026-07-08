"""
Backend regression tests for Fleet Commander.

Dependency-free: a tiny assert harness (no pytest needed) so it runs with just
the backend venv. Covers the endpoints and helpers that have bitten us before —
script categories, the streaming auth-check, CSV deletion guards, and the
known_hosts corruption handling.

Run:  node tools/run-tests.mjs      (locates the venv python, then runs this)
  or: backend/.venv/Scripts/python.exe backend/tests/test_api.py
"""

import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
sys.path.insert(0, BACKEND)

import app as flask_app          # noqa: E402
import deployer                  # noqa: E402
import paramiko                  # noqa: E402
import threading                 # noqa: E402

_failures = []
_count = 0


def check(cond, msg):
    global _count
    _count += 1
    if not cond:
        _failures.append(msg)
        print(f"  FAIL: {msg}")
    else:
        print(f"  ok: {msg}")


def body(resp):
    return json.loads(resp.data.decode())


# --------------------------------------------------------------------------- #
def test_script_categories():
    print("\n[script categories]")
    c = flask_app.app.test_client()
    tmp = tempfile.mkdtemp(prefix="bsm_test_scripts_")

    check(body(c.post("/api/scripts/category", data={"name": "RouterOS", "dir": tmp}))["category"] == "RouterOS",
          "create category RouterOS")
    check(body(c.post("/api/scripts", data={"name": "a", "content": "/system print\n",
                                            "category": "RouterOS", "dir": tmp}))["category"] == "RouterOS",
          "save into category")
    check(body(c.post("/api/scripts", data={"name": "hello", "content": "echo hi\n", "dir": tmp}))["category"] == "",
          "save into default category")

    lst = body(c.get(f"/api/scripts?dir={tmp}"))
    check("RouterOS" in lst["categories"], "category listed")
    names = {(s["name"], s["category"]) for s in lst["scripts"]}
    check(("a.sh", "RouterOS") in names and ("hello.sh", "") in names, "scripts carry their category")

    got = body(c.get(f"/api/scripts/a.sh?dir={tmp}&category=RouterOS"))
    check("system print" in got["content"], "get from category")

    mv = body(c.post("/api/scripts/move",
                     data={"name": "hello.sh", "from_category": "", "to_category": "RouterOS", "dir": tmp}))
    check(mv["category"] == "RouterOS", "move between categories")


def test_delete_category():
    print("\n[delete category]")
    c = flask_app.app.test_client()
    tmp = tempfile.mkdtemp(prefix="bsm_test_delcat_")
    c.post("/api/scripts/category", data={"name": "RouterOS", "dir": tmp})
    c.post("/api/scripts", data={"name": "a", "content": "x", "category": "RouterOS", "dir": tmp})
    c.post("/api/scripts", data={"name": "dup", "content": "in-cat", "category": "RouterOS", "dir": tmp})
    c.post("/api/scripts", data={"name": "dup", "content": "in-general", "dir": tmp})  # collision in General

    res = body(c.delete(f"/api/scripts/category?name=RouterOS&dir={tmp}"))
    check(res["ok"] and res["moved"] == 2, "delete category moves its scripts out")
    after = body(c.get(f"/api/scripts?dir={tmp}"))
    check(after["categories"] == [], "category folder removed")
    names = {s["name"] for s in after["scripts"]}
    check({"a.sh", "dup.sh", "dup-1.sh"} <= names, "scripts fell back to General, collision suffixed")

    check(c.delete(f"/api/scripts/category?name=&dir={tmp}").status_code == 400, "General cannot be deleted")


def test_path_traversal():
    print("\n[path traversal containment]")
    c = flask_app.app.test_client()
    tmp = tempfile.mkdtemp(prefix="bsm_test_trav_")
    res = body(c.post("/api/scripts/category", data={"name": "../evil", "dir": tmp}))
    check(res["category"] == "evil", "category basename'd, cannot escape")
    check(os.path.isdir(os.path.join(tmp, "evil")), "created inside scripts dir")
    check(not os.path.exists(os.path.join(os.path.dirname(tmp), "evil")), "nothing escaped the dir")
    check(c.post("/api/scripts/category", data={"name": "..", "dir": tmp}).status_code == 400,
          "dot-only name rejected")


def test_auth_check_stream():
    print("\n[auth-check streaming]")
    c = flask_app.app.test_client()
    r = c.post("/api/auth-check", data={"mode": "universal"})
    check(r.headers.get("Content-Type", "").startswith("application/x-ndjson"), "streams NDJSON")
    events = [json.loads(l) for l in r.data.decode().splitlines() if l.strip()]
    check(bool(events) and events[0]["type"] == "fatal", "emits a fatal event when no systems")


def test_delete_csv_guards():
    print("\n[delete-csv-file guards]")
    c = flask_app.app.test_client()
    tmp = tempfile.mkdtemp(prefix="bsm_test_csv_")
    # non-.csv rejected
    txt = os.path.join(tmp, "notes.txt")
    open(txt, "w").close()
    check(c.post("/api/delete-csv-file", json={"path": txt}).status_code == 400, "refuses non-.csv")
    check(os.path.exists(txt), "non-.csv left intact")
    # missing rejected
    check(c.post("/api/delete-csv-file", json={"path": os.path.join(tmp, "gone.csv")}).status_code == 404,
          "404 on missing file")
    # real .csv deleted
    csv = os.path.join(tmp, "fleet.csv")
    open(csv, "w").close()
    check(body(c.post("/api/delete-csv-file", json={"path": csv}))["ok"], "deletes a real .csv")
    check(not os.path.exists(csv), "csv removed")


def test_known_hosts_scrub():
    print("\n[known_hosts scrub + self-heal]")
    tmp = tempfile.mkdtemp(prefix="bsm_test_kh_")
    kh = os.path.join(tmp, "known_hosts")
    deployer.KNOWN_HOSTS_PATH = kh

    key = paramiko.RSAKey.generate(2048)
    good = f"good.example.com {key.get_name()} {key.get_base64()}"
    # corrupt: truncated/concatenated base64 blob (raises InvalidHostKey in paramiko)
    corrupt = ("10.192.64.12 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7e4p83SMzwf9e6HcT6"
               "abYEHOl2826IDSRwxgE5NnxPxo1GTbN+sX")
    with open(kh, "w") as f:
        f.write(good + "\n" + corrupt + "\n")

    # paramiko's own loader chokes on the corrupt line...
    raised = False
    try:
        paramiko.HostKeys().load(kh)
    except Exception:
        raised = True
    check(raised, "paramiko's own load raises on the corrupt line")

    # ...but our scrubbed reader skips it and keeps the good key.
    hk, had_bad = deployer._read_known_hosts_scrubbed()
    check(had_bad, "scrub flags corruption")
    check(hk.lookup("good.example.com") is not None, "valid key retained")

    # _make_client must not raise, and must self-heal the file.
    deployer._make_client(strict=False)
    _, had_bad2 = deployer._read_known_hosts_scrubbed()
    check(not had_bad2, "file self-healed (corrupt line dropped)")
    with open(kh) as f:
        content = f.read()
    check("nxPxo1GTbN" not in content, "corrupt data gone from disk")
    check("good.example.com" in content, "good entry preserved on disk")


def test_exec_timeout_bounds():
    print("\n[exec timeout bound]")
    v = deployer._EXEC_NO_TIMEOUT
    check(0 < v < threading.TIMEOUT_MAX,
          f"_EXEC_NO_TIMEOUT ({v}) is positive and under threading.TIMEOUT_MAX ({threading.TIMEOUT_MAX})")


def main():
    for fn in (
        test_script_categories,
        test_delete_category,
        test_path_traversal,
        test_auth_check_stream,
        test_delete_csv_guards,
        test_known_hosts_scrub,
        test_exec_timeout_bounds,
    ):
        fn()
    print(f"\n{_count - len(_failures)}/{_count} checks passed.")
    if _failures:
        print("FAILURES:")
        for f in _failures:
            print("  -", f)
        sys.exit(1)
    print("ALL BACKEND TESTS PASSED")


if __name__ == "__main__":
    main()
