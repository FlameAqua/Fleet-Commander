"""
Backend regression tests for Fleet Commander.

Dependency-free: a tiny assert harness (no pytest needed) so it runs with just
the backend venv. Covers the endpoints and helpers that have bitten us before —
script categories, the streaming auth-check, CSV deletion guards, and the
known_hosts corruption handling.

Run:  node tools/run-tests.mjs      (locates the venv python, then runs this)
  or: backend/.venv/Scripts/python.exe backend/tests/test_api.py
"""

import io
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


def _capture_deploy_host(monkey_target=deployer):
    """Stub deployer.deploy_host, recording the kwargs each host was run with."""
    calls = []
    real = monkey_target.deploy_host

    def fake(target, password, script, cfg, **kw):
        calls.append({"target": target, "password": password, "script": script, **kw})
        return deployer.HostResult(
            target=target.label, ok=True, stage="done", message="stubbed",
            exit_status=0, output="", duration_s=0.0,
        )

    monkey_target.deploy_host = fake
    return calls, (lambda: setattr(monkey_target, "deploy_host", real))


def test_password_var_for_test_and_manual():
    print("\n[$Password exposed for Test Host / Manual]")
    c = flask_app.app.test_client()
    calls, restore = _capture_deploy_host()
    try:
        # --- Test Host: password is typed by the operator, no CSV exists.
        r = c.post("/api/deploy", data={
            "mode": "test",
            "action": "custom_script",
            "test_password": "hunter2",
            "custom_script": (io.BytesIO(b'echo "$Password"\n'), "s.sh"),
        })
        r.data  # drain the stream so the generator runs
        check(len(calls) == 1, "test mode ran one host")
        hv = calls[0].get("host_vars") or {}
        check(hv.get("Password") == "hunter2",
              f"test host gets $Password from the typed password (got {hv.get('Password')!r})")

        # The prelude is what actually makes $Password resolve in the script.
        prelude = deployer._build_host_vars_prelude(hv)
        check("export Password='hunter2'" in prelude, "prelude exports Password")

        # --- Manual rows: password comes from the typed-in row.
        calls.clear()
        r = c.post("/api/deploy", data={
            "mode": "universal",
            "action": "custom_script",
            "ssh_csv": (io.BytesIO(b"url\nssh://root@10.0.0.9\n"), "u.csv"),
            "pass_csv": (io.BytesIO(b"host,password\n10.0.0.9,manualpw\n"), "p.csv"),
            "custom_script": (io.BytesIO(b'echo "$Password"\n'), "s.sh"),
        })
        r.data
        check(len(calls) == 1, "manual mode ran one host")
        check((calls[0].get("host_vars") or {}).get("Password") == "manualpw",
              "manual host gets $Password from its row")
    finally:
        restore()


def test_password_var_compound_not_clobbered():
    print("\n[compound CSV keeps its own Password column]")
    c = flask_app.app.test_client()
    calls, restore = _capture_deploy_host()
    try:
        # host_vars from the browser already carries Password; the SSH cred
        # differs. The operator's value must win (setdefault, not overwrite).
        kp = b"Account,Login Name,Password,Web Site,Comments\nBox,root,sshpw,ssh://root@10.0.0.7,\n"
        r = c.post("/api/deploy", data={
            "mode": "universal",
            "action": "custom_script",
            "keepass_csv": (io.BytesIO(kp), "fleet.csv"),
            "host_vars": json.dumps({"ssh://root@10.0.0.7:22": {"Password": "csvpw", "Site": "ALPHA"}}),
            "custom_script": (io.BytesIO(b'echo "$Password"\n'), "s.sh"),
        })
        r.data
        check(len(calls) == 1, "compound mode ran one host")
        hv = calls[0].get("host_vars") or {}
        check(hv.get("Password") == "csvpw", f"CSV's Password column preserved (got {hv.get('Password')!r})")
        check(hv.get("Site") == "ALPHA", "other CSV columns still exposed")
    finally:
        restore()


def test_root_password_column_still_stripped():
    print("\n[root-password column never reaches the script env]")
    c = flask_app.app.test_client()
    calls, restore = _capture_deploy_host()
    try:
        kp = b"Account,Login Name,Password,Web Site,Comments\nBox,root,sshpw,ssh://root@10.0.0.8,\n"
        r = c.post("/api/deploy", data={
            "mode": "universal",
            "action": "custom_script",
            "keepass_csv": (io.BytesIO(kp), "fleet.csv"),
            "host_vars": json.dumps({"ssh://root@10.0.0.8:22": {"RootPassword": "rootpw"}}),
            "root_password_column": "RootPassword",
            "custom_script": (io.BytesIO(b"id -u\n"), "s.sh"),
        })
        r.data
        check(len(calls) == 1, "ran one host")
        hv = calls[0].get("host_vars") or {}
        check("RootPassword" not in hv, "root-password column popped out of host_vars")
        check(calls[0].get("root_password") == "rootpw", "root password routed to su escalation")
    finally:
        restore()


def test_classify_os():
    print("\n[OS classification for mixed-fleet check]")
    check(deployer._classify_os("Linux\n") == "linux", "Linux -> linux")
    check(deployer._classify_os("OpenBSD\n") == "openbsd", "OpenBSD -> openbsd")
    check(deployer._classify_os("Darwin") == "", "unknown OS -> ''")
    check(deployer._classify_os("") == "", "empty -> ''")


def main():
    for fn in (
        test_script_categories,
        test_delete_category,
        test_path_traversal,
        test_auth_check_stream,
        test_delete_csv_guards,
        test_known_hosts_scrub,
        test_exec_timeout_bounds,
        test_password_var_for_test_and_manual,
        test_password_var_compound_not_clobbered,
        test_root_password_column_still_stripped,
        test_classify_os,
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
