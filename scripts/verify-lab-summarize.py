"""Summarise one-mail runs: per stage, the range and median across runs."""
import json, statistics, sys
from collections import defaultdict
from pathlib import Path

out = Path(sys.argv[1])
stages = defaultdict(lambda: defaultdict(list))
order = []
for result in sorted(out.glob("run-*/result.json")):
    data = json.loads(result.read_text())
    print(result.parent.name, data["canvas"], "load", [round(x, 1) for x in data["loadAverage"]])
    for row in data["rows"]:
        label = row["label"]
        if label not in order:
            order.append(label)
        s = stages[label]
        s["gap"].append(row["maxFrameGapMs"])
        s["read"].append(row["readCanvas"]["ms"] / max(1, row["readCanvas"]["count"]))
        s["reads"].append(row["readCanvas"]["count"])
        s["cmp"].append(row["stringifyCompare"]["ms"] / max(1, row["stringifyCompare"]["count"]))
        s["apply"].append(row["applyDoc"]["ms"] / max(1, row["applyDoc"]["count"]))
        s["rebuild"].append(row["structuralRebuild"]["count"])
        s["commits"].append(row["reactRoot"]["count"] + row["reactCanvas"]["count"])
        s["cc"].append(row["canvasChanged"])
        s["remount"].append(row["cardsAdded"] + row["cardsRemoved"])
        if "docBytes" in row:
            s["doc"].append(row["docBytes"])

def rng(values, digits=0):
    f = (lambda v: f"{v:.{digits}f}")
    return f"{f(min(values))}-{f(max(values))} (med {f(statistics.median(values))})"

print()
for label in order:
    s = stages[label]
    doc = f" doc={max(s['doc'])/1e6:.2f}MB" if s["doc"] else ""
    print(f"{label}{doc}  n={len(s['gap'])}")
    print(f"   frame gap ms {rng(s['gap'])} | canvasChanged {rng(s['cc'])} | reads {rng(s['reads'])}")
    print(f"   per read ms: readCanvas {rng(s['read'],1)} compare {rng(s['cmp'],1)} apply {rng(s['apply'],1)} | rebuilds {rng(s['rebuild'])} commits {rng(s['commits'])} remounts {max(s['remount'])}")
