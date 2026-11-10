"""What a Chromium trace says happened while the user zoomed and panned.

Reads one trace (the installed app's View > Record Performance Trace, the
zoom probe's, or the lab's --tracefile) and reports, for the stretches where
wheel input was arriving:

  - per process: how busy it was, all threads together
  - per renderer: main frames started and committed, the gap between commits,
    long tasks, and where the main thread's time went
  - on the GPU side: frames presented, and render passes per frame

A commit is the browser's word for "this process handed new content to the
screen". For a DOM canvas the camera only moves on a commit.

usage: python3 -I trace-nav.py <trace.json> [top N rows, default 14]
"""
import collections
import json
import re
import sys

path = sys.argv[1]
TOP = int(sys.argv[2]) if len(sys.argv) > 2 else 14
INPUT = re.compile(r"ForwardWheelEvent|ForwardGestureEvent|ForwardTouch")

with open(path, "rb") as f:
    data = json.load(f)
events = data["traceEvents"] if isinstance(data, dict) else data

pname, tname = {}, {}
for e in events:
    if e.get("ph") == "M":
        a = e.get("args", {})
        if e.get("name") == "process_name":
            pname[e["pid"]] = a.get("name", "?")
        elif e.get("name") == "thread_name":
            tname[(e["pid"], e["tid"])] = a.get("name", "?")

inputs = sorted(e["ts"] for e in events if "ts" in e and INPUT.search(e.get("name", "")))
if not inputs:
    print("no wheel input in this trace")
    sys.exit()
wins = []
a = b = inputs[0]
for t in inputs[1:]:
    if t - b > 150_000:
        wins.append((a, b + 100_000))
        a = t
    b = t
wins.append((a, b + 100_000))
wins = [(a, b) for a, b in wins if b - a > 300_000]
active = sum(b - a for a, b in wins) / 1e6


def window(ts):
    return next((i for i, (a, b) in enumerate(wins) if a <= ts <= b), -1)


def inwin(ts):
    return window(ts) >= 0


def spread(values):
    v = sorted(values)
    if not v:
        return "none"
    q = lambda p: v[min(len(v) - 1, int(len(v) * p))]
    return f"n {len(v)}  p50 {q(.5):.1f}  p90 {q(.9):.1f}  p99 {q(.99):.1f}  max {v[-1]:.1f} ms"


xs = [e for e in events if e.get("ph") == "X" and "dur" in e]
print(f"{len(inputs)} wheel events, {len(wins)} gestures, {active:.1f} s of movement")

# Busy time per process during gestures: the union of top-level slices per thread.
by_thread = collections.defaultdict(list)
for e in xs:
    if inwin(e["ts"]):
        by_thread[(e["pid"], e["tid"])].append(e)
proc_busy = collections.Counter()
thread_busy = {}
for key, evs in by_thread.items():
    evs.sort(key=lambda e: (e["ts"], -e["dur"]))
    total, end = 0, -1
    for e in evs:
        if e["ts"] >= end:
            total += e["dur"]
            end = e["ts"] + e["dur"]
    thread_busy[key] = total
    proc_busy[key[0]] += total
print("\n== busy per process during gestures, all threads (ms per second)")
for pid, us in proc_busy.most_common(6):
    print(f"  {us / 1e3 / active:8.1f}  pid {pid:6d}  {pname.get(pid, '?')}")

mains = sorted((k for k in thread_busy if tname.get(k) == "CrRendererMain"), key=lambda k: -thread_busy[k])
for main in mains:
    if thread_busy[main] / 1e3 / active < 2:
        continue
    mx = sorted((e for e in xs if (e["pid"], e["tid"]) == main), key=lambda e: (e["ts"], -e["dur"]))
    during = [e for e in mx if inwin(e["ts"])]
    frames = [e for e in during if e["name"] == "ProxyMain::BeginMainFrame"]
    commits = sorted(e["ts"] for e in during if e["name"] == "ProxyMain::BeginMainFrame::commit")
    # A gap counts only inside one gesture: the pause between two gestures is not a stall.
    gaps = [(y - x) / 1e3 for x, y in zip(commits, commits[1:]) if window(x) == window(y)]
    tasks = [e["dur"] / 1e3 for e in during if e["name"] == "RunTask"]
    print(f"\n== renderer pid {main[0]} main thread during gestures")
    print(f"  main frames started {len(frames) / active:.1f}/s, committed {len(commits) / active:.1f}/s")
    print(f"  main frame work: {spread([e['dur'] / 1e3 for e in frames])}")
    print(f"  gap between commits: {spread(gaps)};  over 16.7 ms: {sum(1 for g in gaps if g > 16.7)}  over 33 ms: {sum(1 for g in gaps if g > 33.4)}  over 100 ms: {sum(1 for g in gaps if g > 100)}")
    print(f"  busy {sum(tasks) / active:.0f} ms/s;  tasks over 8.3 ms {sum(1 for t in tasks if t > 8.3) / active:.1f}/s, over 16.7 ms {sum(1 for t in tasks if t > 16.7) / active:.1f}/s, over 50 ms {sum(1 for t in tasks if t > 50) / active:.1f}/s")
    self_us, count, stack = collections.Counter(), collections.Counter(), []
    for e in mx:
        while stack and stack[-1][1] <= e["ts"]:
            stack.pop()
        if inwin(e["ts"]):
            if stack and stack[-1][2]:
                self_us[stack[-1][0]] -= e["dur"]
            self_us[e["name"]] += e["dur"]
            count[e["name"]] += 1
        stack.append((e["name"], e["ts"] + e["dur"], inwin(e["ts"])))
    for name, v in self_us.most_common(TOP):
        print(f"  {v / 1e3 / active:8.2f} ms/s {count[name] / active:7.1f}/s  {v / 1e3 / max(count[name], 1):6.2f} ms each  {name[:64]}")

draws = [e for e in xs if e["name"] == "Display::DrawAndSwap" and inwin(e["ts"])]
passes = [e for e in xs if e["name"] == "SkiaOutputSurfaceImplOnGpu::FinishPaintRenderPass" and inwin(e["ts"])]
activations = collections.Counter(e["pid"] for e in xs if e["name"] == "LayerTreeHostImpl::ActivateSyncTree" and inwin(e["ts"]))
print(f"\n== screen during gestures: {len(draws) / active:.1f} frames presented per second, {len(passes) / max(len(draws), 1):.1f} render passes per frame")
for pid, n in activations.most_common(4):
    print(f"  new content from pid {pid} ({pname.get(pid, '?')}): {n / active:.1f} per second")

gpu = collections.Counter()
gpu_n = collections.Counter()
for (pid, tid), evs in by_thread.items():
    if "GPU" not in pname.get(pid, "") or tname.get((pid, tid)) != "CrGpuMain":
        continue
    stack = []
    for e in evs:
        while stack and stack[-1][1] <= e["ts"]:
            stack.pop()
        if stack:
            gpu[stack[-1][0]] -= e["dur"]
        gpu[e["name"]] += e["dur"]
        gpu_n[e["name"]] += 1
        stack.append((e["name"], e["ts"] + e["dur"]))
if gpu:
    print("\n== GPU process main thread during gestures (self time)")
    for name, v in gpu.most_common(10):
        print(f"  {v / 1e3 / active:8.2f} ms/s {gpu_n[name] / active:7.1f}/s  {name[:70]}")

# What reached the screen. Chromium keeps one record for every frame a process
# tried to show (PipelineReporter): shown or dropped, and when it was shown. A
# record with a commit carried a main thread update, the only way either
# canvas moves its camera. A display refresh that passes between two of those
# with no new picture is a dropped frame.
KINDS = ["zoom in", "zoom out"] * 4 + ["zoom in"] + ["small zoom in", "small zoom out"] * 3 + ["pan"] * 6
ticks = sorted(e["ts"] for e in events if e.get("name") == "ExternalBeginFrameSourceMac::OnDisplayLinkCallback" and "ts" in e and inwin(e["ts"]))
# Each window has a display compositor of its own and each gets the tick.
ticks = [t for i, t in enumerate(ticks) if i == 0 or t - ticks[i - 1] > 2000]
tick_gaps = sorted(y - x for x, y in zip(ticks, ticks[1:]) if window(x) == window(y))
interval = tick_gaps[len(tick_gaps) // 2] if tick_gaps else 16_667
# The ids are reused, so a record is the stretch from one begin to its end.
stages = sorted((e for e in events if e.get("ph") in ("b", "e") and e.get("name") in ("PipelineReporter", "Commit")), key=lambda e: e["ts"])
running = {}
shown = collections.defaultdict(list)
lost = collections.Counter()
for e in stages:
    key = (e["pid"], e.get("id2", {}).get("local", e.get("id")))
    if e["name"] == "Commit":
        if key in running:
            running[key]["main"] = True
    elif e["ph"] == "b":
        running[key] = {"state": e.get("args", {}).get("frame_reporter", {}).get("state"), "main": False}
    elif key in running:
        r = running.pop(key)
        if not r["main"] or not inwin(e["ts"]):
            continue
        if r["state"] == "STATE_PRESENTED_ALL":
            shown[e["pid"]].append(e["ts"])
        elif r["state"] == "STATE_DROPPED":
            lost[e["pid"]] += 1
for pid, times in sorted(shown.items(), key=lambda kv: -len(kv[1])):
    if len(times) / active < 2:
        continue
    times.sort()
    print(f"\n== frames on screen from pid {pid} ({pname.get(pid, '?')}), one display refresh is {interval / 1e3:.2f} ms ({1e6 / interval:.0f} Hz)")
    by_kind = collections.defaultdict(lambda: [0, 0, 0, 0.0])
    rows = []
    for i, (a, b) in enumerate(wins):
        ts = [t for t in times if a <= t <= b]
        gaps = [y - x for x, y in zip(ts, ts[1:])]
        if len(ts) > 1:
            refreshes = round((ts[-1] - ts[0]) / interval) + 1
            dropped = sum(max(0, round(g / interval) - 1) for g in gaps)
        else:
            refreshes = round((b - a) / interval)
            dropped = refreshes - len(ts)
        longest = max(gaps) / 1e3 if gaps else (b - a) / 1e3
        kind = KINDS[i] if len(wins) == len(KINDS) else f"gesture {i + 1}"
        rows.append((kind, refreshes, len(ts), dropped, longest))
        k = by_kind[kind]
        k[0] += refreshes
        k[1] += len(ts)
        k[2] += dropped
        k[3] = max(k[3], longest)
    for kind, refreshes, new, dropped, longest in rows:
        print(f"  {kind:14s} {refreshes:4d} refreshes  {new:4d} new pictures  {dropped:4d} dropped  longest wait {longest:6.1f} ms")
    print("  -- by kind")
    for kind, (refreshes, new, dropped, longest) in by_kind.items():
        print(f"  {kind:14s} {refreshes:4d} refreshes  {new:4d} new pictures  {dropped:4d} dropped ({100 * dropped / max(refreshes, 1):.1f}%)  longest wait {longest:6.1f} ms")
    total = [sum(r[j] for r in rows) for j in (1, 2, 3)]
    print(f"  all gestures   {total[0]:4d} refreshes  {total[1]:4d} new pictures  {total[2]:4d} dropped ({100 * total[2] / max(total[0], 1):.1f}%)  longest wait {max(r[4] for r in rows):6.1f} ms;  updates Chromium itself counted as dropped: {lost[pid]}")
    all_gaps = [(y - x) / 1e3 for x, y in zip(times, times[1:]) if window(x) == window(y)]
    print(f"  wait between new pictures: {spread(all_gaps)}")
