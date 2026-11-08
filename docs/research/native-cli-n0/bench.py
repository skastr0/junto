import os, socket, subprocess, time, json, sys
J = "/Applications/Junto.app/Contents/Resources/bin/junto"
SOCK = os.path.expanduser("~/.junto/work/control.sock")
TOK = os.environ["JUNTO_WORK_TOKEN"]
N, W = int(sys.argv[1]), 3
cases = [("--version", ["--version"], None), ("ping", ["ping"], "ping"), ("since", ["since"], "since"),
         ("msg list", ["msg","list"], "msg.list"), ("signal list", ["signal","list"], "signal.list"),
         ("capabilities", ["capabilities"], "capabilities"), ("onboard", ["onboard"], "onboard")]
def cli(argv):
    t = time.perf_counter(); subprocess.run([J]+argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); return time.perf_counter()-t
def floor():
    t = time.perf_counter(); subprocess.run(["/usr/bin/true"]); return time.perf_counter()-t
def direct(op):
    t0 = time.perf_counter(); s = socket.socket(socket.AF_UNIX); s.connect(SOCK); t1 = time.perf_counter()
    s.sendall((json.dumps({"token": TOK, "op": op, "args": {}})+"\n").encode())
    buf = s.recv(1 << 20); t2 = time.perf_counter(); n = len(buf)
    while b"\n" not in buf:
        d = s.recv(1 << 20)
        if not d: break
        buf += d
    t3 = time.perf_counter(); s.close()
    ok = buf.startswith(b'{"ok":true')
    return t1-t0, t2-t1, t3-t1, len(buf), ok
def gate():
    while os.getloadavg()[0] >= 40: time.sleep(15)
def spcpu():
    out = subprocess.run(["ps","-Ao","time=,comm="], capture_output=True, text=True).stdout
    t = 0.0
    for l in out.splitlines():
        if l.strip().endswith("syspolicyd"):
            v = l.split()[0]; p = v.split(":"); t += float(p[-1]) + 60*float(p[-2]) + (3600*float(p[-3]) if len(p) > 2 else 0)
    return t
res = {}; meta = {"load": []}
for name, argv, op in cases:
    gate(); meta["load"].append((name, os.getloadavg()[0]))
    for _ in range(W): cli(argv); op and direct(op)
    r = {"cli": [], "conn": [], "ttfb": [], "resp": [], "bytes": 0, "ok": True}
    for _ in range(N):
        r["cli"].append(cli(argv))
        if op:
            c, f, a, b, ok = direct(op); r["conn"].append(c); r["ttfb"].append(f); r["resp"].append(a); r["bytes"] = b; r["ok"] &= ok
    res[name] = r
    r0 = spcpu(); [cli(argv) for _ in range(20)]; r["syspolicyd_cpu_s_per_20"] = spcpu() - r0
res["floor /usr/bin/true"] = {"cli": [floor() for _ in range(N)], "conn": [], "ttfb": [], "resp": [], "bytes": 0, "ok": True}
res["_meta"] = meta
json.dump(res, open(sys.argv[2], "w"))
print("load at each case start", meta["load"])
res.pop("_meta")
def q(a, p): a = sorted(a); return a[min(len(a)-1, int(p*len(a)))]*1000 if a else float("nan")
print(f"{'call':22} {'cli p50':>8} {'p90':>7} {'conn':>6} {'server p50':>10} {'p90':>7} {'start=cli-server':>16} {'bytes':>7}")
for k, r in res.items():
    srv = q(r["conn"],.5)+q(r["resp"],.5) if r["resp"] else 0
    print(f"{k:22} {q(r['cli'],.5):8.1f} {q(r['cli'],.9):7.1f} {q(r['conn'],.5):6.2f} {q(r['resp'],.5):10.1f} {q(r['resp'],.9):7.1f} {q(r['cli'],.5)-srv:16.1f} {r['bytes']:7d} {'' if r['ok'] else 'NOT OK'} sp={r.get('syspolicyd_cpu_s_per_20','')}")
