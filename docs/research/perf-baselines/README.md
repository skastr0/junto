# Terminal performance baselines

What scrolling, typing in and watching a seat terminal costs on a board the
operator's size (358 nodes, 841 wires, geometry from the operator's board).
Each file is one build, measured on one machine, three runs per condition.

Measure the build in `out/`:

```sh
bun scripts/perf-terminal-baseline.ts run --label <name>
```

Compare a build to a baseline (exits 1 on a headline regression):

```sh
bun scripts/perf-terminal-baseline.ts compare docs/research/perf-baselines/terminal-<base>.json terminal-<head>.json
```

Conditions, each a 12 s traced window (`e2e/scenarios/perf-terminal-baseline.spec.ts`):

- `scroll`: trackpad wheel at 120 Hz over the lead's terminal, nothing streams
- `scroll-stream`: the same while the lead streams 12 KB/s
- `type`: 60 presses of Shift+Z, one each 200 ms
- `watch`: no input while the lead streams 12 KB/s

Headline metrics are frame cadence (frames presented per second, frame gap p95,
frames over 16.7 ms) and renderer main-thread cost (busy ms per second, task
p95, Paint ms per second), plus key-to-screen latency for `type`. Wheel latency
is reported but does not gate: it includes the rig's CDP input injection.

Numbers only compare on the same machine. Each run waits for the one-minute
load to fall to the core count and records it; seats running on the machine
move every number.
