#!/usr/bin/env bash
# Seed review tasks with hard dependsOn after implement packs are *tasks*
# (approved proposals), not merely pending proposals.
#
# Usage:
#   export PATH="/Applications/Vellum Command.app/Contents/Resources/bin:$PATH"
#   # optional: override sinks
#   PARALLEL_SINK=task-... DEEP_SINK=task-... bash scripts/seed-effect-foundation-reviews.sh
#
# Requires: vellum process-bound, grants tasks.create + tasks.list on both sinks.
set -euo pipefail

PARALLEL_SINK="${PARALLEL_SINK:-task-01KZ210AXM2WAC3W7XA69BVE3D}"
DEEP_SINK="${DEEP_SINK:-task-01KZ212Q9DC84S8SM0N16ENV5A}"
VELLUM_BIN="${VELLUM_BIN:-vellum}"

log() { printf 'effect-foundation-reviews: %s\n' "$*" >&2; }

if ! command -v "$VELLUM_BIN" >/dev/null 2>&1; then
  log "vellum CLI not found"
  exit 1
fi

python3 - "$PARALLEL_SINK" "$DEEP_SINK" "$VELLUM_BIN" <<'PY'
import json, subprocess, sys

parallel_sink, deep_sink, vellum = sys.argv[1], sys.argv[2], sys.argv[3]

def list_tasks(target: str) -> dict[str, dict]:
    r = subprocess.run(
        [vellum, "tasks", "list", json.dumps({"target": target})],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(r.stdout)["data"]
    out: dict[str, dict] = {}
    for t in data.get("items") or []:
        if not isinstance(t, dict):
            continue
        tid = t.get("id") or t.get("taskId") or t.get("itemId")
        if tid:
            out[str(tid)] = t
    # Also index proposals by id for diagnostics
    for p in data.get("proposals") or []:
        pid = p.get("id")
        if pid and pid not in out:
            out[f"proposal:{pid}"] = p
    return out

def create(target: str, payload: dict) -> None:
    r = subprocess.run(
        [vellum, "tasks", "create", json.dumps(payload)],
        capture_output=True, text=True,
    )
    print(r.stdout)
    if r.returncode != 0:
        print(r.stderr, file=sys.stderr)
        raise SystemExit(r.returncode)
    body = json.loads(r.stdout)
    if not body.get("data", {}).get("results", [{}])[0].get("ok"):
        err = body["data"]["results"][0].get("error", {})
        raise SystemExit(f"create failed: {err}")

COMMON = """
---
END_STATE: docs/END_STATE-effect-foundation.md
Effect V4 reference (NOT V3 effect skill): /Users/developer/Playground/effect
Required skills: consolidation-engineering, pristine-components
ROLE: REVIEW (not implement). Prefer a different seat than the implementer.
Completion: git commits only. NO artifacts.
"""

parallel = list_tasks(parallel_sink)
deep = list_tasks(deep_sink)

# Known implement proposal/task ids from campaign seed (same id survives approve)
PACKS = [
    ("S4-work", "01KZ21BZCBV8V173EHBP556ZRB", "src/main/vellum/work/**", "R4-work"),
    ("S4-station", "01KZ21BZKTNGKDHFN58HW4PWZH", "src/main/vellum/station/**", "R4-station"),
    ("S4-state-content", "01KZ21BZV4EG17VFD7824APW02",
     "src/main/vellum/state/** src/main/vellum/content/** src/main/vellum/install-ops/**", "R4-state-content"),
    ("S4-hosts-ssh", "01KZ21C01WZPWXD3JJG6EKD1BW", "src/main/vellum/hosts/** src/main/vellum/ssh/**", "R4-hosts-ssh"),
    ("S4-browser-term", "01KZ21C092F8DB9P75WVSBYHFN", "src/main/vellum/browser/** src/main/vellum/term/**", "R4-browser-term"),
    ("S4-rest-main", "01KZ21C0GC3SJN45TCX0A16AM8",
     "src/main/vellum/{box,chat,demo,herdr,hermes,license,pause,scheduler,settings,update,usage}/** src/main/services/** src/cli/**",
     "R4-rest-main"),
    ("S5-fork-main", "01KZ21C0RNZ93AS5JFF9M3GD0Q", "src/main/** (fork renames only; avoid thrashing open packs)", "R5-fork"),
    ("S7-platform-imports", "01KZ21C10J8FCTQ236E9AATQ78", "src/main/vellum/ssh/** src/cli/** package.json", "R7-platform"),
]

DEEP_SLICES = [
    ("S0", "01KZ21AP6GB3ADAJQSMZMZ91W5", "R0"),
    ("S1", "01KZ21CTJTC6WJQJPEFS1G3XMV", "R1"),
    ("S2", "01KZ21CTT6E4C80EWFMFKDJMFB", "R2"),
    ("S3", "01KZ21CV1RKPJYFXD3XJBTXH4F", "R3"),
]

missing = []
for pack, tid, paths, rid in PACKS:
    if tid not in parallel:
        missing.append(f"parallel {pack}={tid}")
for slice_id, tid, rid in DEEP_SLICES:
    if tid not in deep:
        missing.append(f"deep {slice_id}={tid}")

if missing:
    print("Implement packs not yet tasks (approve proposals first):", file=sys.stderr)
    for m in missing:
        print(f"  - {m}", file=sys.stderr)
    print("Still seeding reviews only for packs that exist as tasks…", file=sys.stderr)

s4_task_ids = []
for pack, tid, paths, rid in PACKS:
    if tid not in parallel:
        continue
    if pack.startswith("S4-"):
        s4_task_ids.append(tid)
    brief = f"""{rid} · REVIEW of {pack}

LANE: Parallel · ROLE: review
SLICE: {rid}
IMPLEMENT_PACK: {pack} ({tid})
HARD dependsOn: [{tid}]  # claim-ready only after implement completed

GOAL
Independent review that {pack} matches docs/END_STATE-effect-foundation.md and consolidation-engineering (no dual paths).

DO
1. Skills: consolidation-engineering, pristine-components.
2. Effect V4: /Users/developer/Playground/effect (not V3 effect skill).
3. Review git history + working tree for PATH OWNERSHIP only.
4. Checklist: dual Tag/Service definitions? bare Effect.runPromise in product? thrash outside paths? typecheck.
5. Commit: docs/effect-foundation/reviews/{rid}.md (pass/fail + findings) and/or in-path nits only.

PATH OWNERSHIP (review may edit)
- {paths}
- docs/effect-foundation/reviews/{rid}.md (create)

OUT OF BOUNDS: other packs, kernel (unless R2), Schema mass rewrite
FINISH: END_STATE review slice {rid}; git minCommits ≥ 1; NO artifacts
""" + COMMON
    create(parallel_sink, {
        "target": parallel_sink,
        "brief": brief,
        "reason": f"Effect foundation review {rid}",
        "dependsOn": [tid],
        "metadata": {
            "campaign": "effect-foundation",
            "lane": "parallel",
            "role": "review",
            "slice": rid,
            "implementsPack": pack,
            "dependsOnPackId": tid,
        },
        "finishCriteria": {
            "description": f"END_STATE {rid} review of {pack}; commits only",
            "git": {"minCommits": 1},
        },
    })
    print(f"created review {rid} dependsOn {tid}")

# Integration review: depends on all S4 implement tasks that exist
if len(s4_task_ids) >= 1:
    brief = f"""R4-integrate · Cross-pack S4 coherence review

LANE: Parallel · ROLE: review
HARD dependsOn: all present S4 implement task ids

GOAL
After per-pack S4 work, verify no cross-pack dual services, conflicting Tag ids, or half-migrated shapes.

DO
1. Skills: consolidation-engineering, pristine-components.
2. Scan src/main for duplicate Context.Tag / Service definitions across packs.
3. Confirm kernel/** untouched by parallel packs.
4. Commit docs/effect-foundation/reviews/R4-integrate.md

PATH OWNERSHIP
- docs/effect-foundation/reviews/R4-integrate.md
- read-only elsewhere unless nits in already-touched S4 paths

FINISH: END_STATE R4-integrate; commits only
""" + COMMON
    create(parallel_sink, {
        "target": parallel_sink,
        "brief": brief,
        "reason": "Effect foundation R4-integrate",
        "dependsOn": s4_task_ids,
        "metadata": {
            "campaign": "effect-foundation",
            "lane": "parallel",
            "role": "review",
            "slice": "R4-integrate",
        },
        "finishCriteria": {
            "description": "END_STATE R4-integrate; commits only",
            "git": {"minCommits": 1},
        },
    })
    print(f"created R4-integrate dependsOn {s4_task_ids}")

for slice_id, tid, rid in DEEP_SLICES:
    if tid not in deep:
        continue
    brief = f"""{rid} · REVIEW of deep {slice_id}

LANE: Deep · ROLE: review
HARD dependsOn: [{tid}]

GOAL
Validate {slice_id} against docs/END_STATE-effect-foundation.md — foundation must not be theater.

DO
1. Skills: consolidation-engineering, pristine-components.
2. V4 reference: /Users/developer/Playground/effect
3. Verify commits for {slice_id} meet slice done-when; run relevant tests.
4. Commit docs/effect-foundation/reviews/{rid}.md

FINISH: END_STATE {rid}; commits only
""" + COMMON
    create(deep_sink, {
        "target": deep_sink,
        "brief": brief,
        "reason": f"Effect foundation review {rid}",
        "dependsOn": [tid],
        "metadata": {
            "campaign": "effect-foundation",
            "lane": "deep",
            "role": "review",
            "slice": rid,
            "dependsOnSlice": slice_id,
            "dependsOnPackId": tid,
        },
        "finishCriteria": {
            "description": f"END_STATE {rid}; commits only",
            "git": {"minCommits": 1},
        },
    })
    print(f"created deep review {rid} dependsOn {tid}")

print("done")
PY
