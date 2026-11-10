"""Where a canvas frame waits between the display's tick and the screen.

Reads one Chromium trace (the lab's --tracefile, or the zoom probe's) and, for
the renderer that showed the most main thread updates, prints:

  - how long each stage of a frame took, from the tick to the screen
  - how many refreshes passed between one new picture and the next
  - what differed for the frames that arrived a refresh late
  - when in the refresh each frame was handed to macOS, and which refresh
    macOS was then expected to show it in

usage: python3 -I trace-pace.py <trace.json> [renderer pid]
"""
import collections
import json
import sys

path = sys.argv[1]
with open(path, "rb") as f:
    data = json.load(f)
ev = data["traceEvents"] if isinstance(data, dict) else data
pname = {e["pid"]: e["args"].get("name") for e in ev if e.get("ph") == "M" and e.get("name") == "process_name"}

STAGES = [
    "BeginImplFrameToSendBeginMainFrame",
    "SendBeginMainFrameToCommit",
    "Commit",
    "EndCommitToActivation",
    "Activation",
    "EndActivateToSubmitCompositorFrame",
    "SubmitToReceiveCompositorFrame",
    "ReceiveCompositorFrameToStartDraw",
    "StartDrawToSwapStart",
    "LatchToSwapEnd",
    "SwapEndToPresentationCompositorFrame",
]
names = set(STAGES) | {"PipelineReporter"}
stages = sorted((e for e in ev if e.get("ph") in ("b", "e") and e.get("name") in names), key=lambda e: e["ts"])
# The ids are reused, so a record is the stretch from one begin to its end.
running, recs = {}, collections.defaultdict(list)
for e in stages:
    key = (e["pid"], e.get("id2", {}).get("local", e.get("id")))
    if e["name"] == "PipelineReporter":
        if e["ph"] == "b":
            running[key] = {"start": e["ts"], "state": e.get("args", {}).get("frame_reporter", {}).get("state"), "st": {}}
        elif key in running:
            r = running.pop(key)
            r["end"] = e["ts"]
            recs[e["pid"]].append(r)
    elif key in running:
        s = running[key]["st"].setdefault(e["name"], [None, None])
        s[0 if e["ph"] == "b" else 1] = e["ts"]

shown = {pid: sorted((r for r in rs if "Commit" in r["st"] and r["state"] == "STATE_PRESENTED_ALL"), key=lambda r: r["end"]) for pid, rs in recs.items()}
pid = int(sys.argv[2]) if len(sys.argv) > 2 else max(shown, key=lambda p: len(shown[p]))
main = shown[pid]
ticks = sorted(e["ts"] for e in ev if e.get("name") == "ExternalBeginFrameSourceMac::OnDisplayLinkCallback" and "ts" in e)
tick_gaps = sorted(y - x for x, y in zip(ticks, ticks[1:]))
interval = tick_gaps[len(tick_gaps) // 2] if tick_gaps else 16_667


def spread(v):
    v = sorted(v)
    q = lambda p: v[min(len(v) - 1, int(len(v) * p))]
    return f"p10 {q(.1):6.2f}  p50 {q(.5):6.2f}  p90 {q(.9):6.2f}  p99 {q(.99):6.2f}  max {v[-1]:7.2f}" if v else "none"


def took(rs, s):
    return [(r["st"][s][1] - r["st"][s][0]) / 1e3 for r in rs if s in r["st"] and None not in r["st"][s]]


print(f"renderer pid {pid} ({pname.get(pid)}): {len(main)} main thread updates shown; one refresh is {interval / 1e3:.2f} ms")
print(f"all its frame records: {collections.Counter(r['state'] for r in recs[pid]).most_common()}")
print("\nstage of a frame, ms:")
for s in STAGES:
    print(f"  {s:40s} {spread(took(main, s))}")
print(f"  {'tick to screen, the whole frame':40s} {spread([(r['end'] - r['start']) / 1e3 for r in main])}")

gaps = [b["end"] - a["end"] for a, b in zip(main, main[1:])]
steps = collections.Counter(min(round(g / interval), 9) for g in gaps)
print("\nrefreshes from one new picture to the next (1 is smooth, 0 and 2 come in pairs: two pictures in one refresh, then none):")
print("  " + "  ".join(f"{k}: {n} ({100 * n / len(gaps):.1f}%)" for k, n in sorted(steps.items())))

late = [b for a, b in zip(main, main[1:]) if 1.5 * interval < b["end"] - a["end"] < 2.5 * interval]
ontime = [b for a, b in zip(main, main[1:]) if 0.75 * interval < b["end"] - a["end"] < 1.25 * interval]
print(f"\nframes a refresh late: {len(late)}, on time: {len(ontime)}. Stage medians, late against on time, ms:")
for s in STAGES:
    x, y = sorted(took(late, s)), sorted(took(ontime, s))
    if x and y:
        print(f"  {s:40s} late {x[len(x) // 2]:6.2f}   on time {y[len(y) // 2]:6.2f}")

# The hand-off to macOS: how long after the display's tick it happened, and
# how far ahead Chromium then expected the frame on screen.
commits = sorted((e for e in ev if e.get("name") == "CommitPresentedFrameToCA" and "ts" in e), key=lambda e: e["ts"])
if commits and ticks:
    import bisect

    rows = []
    for e in commits:
        i = bisect.bisect_right(ticks, e["ts"]) - 1
        if i >= 0:
            rows.append(((e["ts"] - ticks[i]) / 1e3, e.get("args", {}).get("now_to_display", 0) / 1e3))
    print(f"\nhand-off to macOS, {len(rows)} frames: ms after the tick {spread([p for p, _ in rows])}")
    print("  by time after the tick: frames, and how far ahead the frame was expected on screen (ms, median)")
    edges = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 17]
    for lo, hi in zip(edges, edges[1:]):
        ahead = sorted(d for p, d in rows if lo <= p < hi)
        if ahead:
            print(f"  {lo:5.2f} to {hi:5.2f} ms  {len(ahead):5d}  {ahead[len(ahead) // 2]:6.2f}")
