// One summary for both arms. Input: a frame log (when each frame started and
// whether the camera moved in it), the gesture script, the time it started,
// and per-second process samples. A "move" is a frame that showed the canvas
// somewhere new; moves per second during a gesture is the number to compare.
//
// Run directly on a raw JSON file to print its summary.

const fs = require("node:fs");

const quantile = (list, q) => {
  if (!list.length) return null;
  const sorted = Float64Array.from(list).sort();
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(3));
};
const spread = (list) => ({ n: list.length, p50: quantile(list, 0.5), p90: quantile(list, 0.9), p99: quantile(list, 0.99), max: quantile(list, 1) });
const round = (value) => Number(value.toFixed(1));

function summarize({ log, script, start, samples, pids, options }) {
  const windows = script.gestures.map((g) => ({ kind: g.kind, from: start + g.start, to: start + g.end + 40 }));
  const byKind = {};
  for (const w of windows) {
    const k = (byKind[w.kind] ??= { seconds: 0, frames: 0, moves: 0, gaps: [] });
    k.seconds += (w.to - w.from) / 1000;
    let last = null;
    for (let i = 0; i < log.n; i++) {
      const t = log.t[i];
      if (t < w.from || t > w.to) continue;
      k.frames++;
      if (!log.moved[i]) continue;
      k.moves++;
      if (last !== null) k.gaps.push(t - last);
      last = t;
    }
  }
  const gesture = {};
  const all = { seconds: 0, frames: 0, moves: 0, gaps: [] };
  for (const [kind, k] of Object.entries(byKind)) {
    gesture[kind] = { movesPerSecond: round(k.moves / k.seconds), framesPerSecond: round(k.frames / k.seconds), gapMs: spread(k.gaps) };
    all.seconds += k.seconds;
    all.frames += k.frames;
    all.moves += k.moves;
    all.gaps.push(...k.gaps);
  }
  const intervals = [];
  for (let i = 1; i < log.n; i++) intervals.push(log.t[i] - log.t[i - 1]);

  // Process cost: CPU seconds each role used between the first and the last
  // sample, per second of wall time. Processes that share a role are summed.
  const processes = {};
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first && last && last.t > first.t) {
    const seconds = (last.t - first.t) / 1000;
    const before = new Map(first.procs.map((p) => [p.pid, p.cpuS]));
    const total = { cpuMsPerSecond: 0, mb: 0 };
    for (const p of last.procs) {
      const role = p.pid === pids.canvas ? "canvas" : p.pid === pids.host ? "window" : p.type;
      const entry = (processes[role] ??= { cpuMsPerSecond: 0, mb: 0 });
      const used = ((p.cpuS - (before.get(p.pid) ?? p.cpuS)) * 1000) / seconds;
      entry.cpuMsPerSecond += used;
      entry.mb += p.mb;
      total.cpuMsPerSecond += used;
      total.mb += p.mb;
    }
    processes.total = total;
    for (const entry of Object.values(processes)) {
      entry.cpuMsPerSecond = Math.round(entry.cpuMsPerSecond);
      entry.mb = Math.round(entry.mb);
    }
  }

  // Input delivery: how often a wheel event reached the canvas during the
  // gestures, and how long each took to get there from the moment it was made.
  let inputDelivery = null;
  if (log.wheel?.at.length) {
    const delays = [];
    const gaps = [];
    for (const w of windows) {
      let last = null;
      for (let i = 0; i < log.wheel.at.length; i++) {
        const at = log.wheel.at[i];
        if (at < w.from || at > w.to) continue;
        delays.push(at - log.wheel.stamp[i]);
        if (last !== null) gaps.push(at - last);
        last = at;
      }
    }
    inputDelivery = { sent: script.steps.length, deliveredPerSecond: round(delays.length / all.seconds), delayMs: spread(delays), gapMs: spread(gaps) };
  }

  return {
    options,
    board: log.info ?? null,
    errors: log.errors ?? [],
    duringGestures: {
      seconds: Number(all.seconds.toFixed(2)),
      movesPerSecond: round(all.moves / all.seconds),
      framesPerSecond: round(all.frames / all.seconds),
      gapBetweenMovesMs: spread(all.gaps),
      gapsOver17ms: all.gaps.filter((v) => v > 17).length,
      gapsOver34ms: all.gaps.filter((v) => v > 34).length,
      gapsOver100ms: all.gaps.filter((v) => v > 100).length,
    },
    gesture,
    frames: {
      n: log.n,
      perSecond: round((log.n - 1) / ((log.t[log.n - 1] - log.t[0]) / 1000)),
      intervalMs: spread(intervals),
      over20ms: intervals.filter((v) => v > 20).length,
      over34ms: intervals.filter((v) => v > 34).length,
      over100ms: intervals.filter((v) => v > 100).length,
    },
    scriptMsPerFrame: spread(log.cpu ?? []),
    gpuMsPerFrame: spread((log.gpu ?? []).filter((v) => v >= 0)),
    inputToFrameStartMs: spread((log.lat ?? []).filter((v) => v >= 0)),
    inputDelivery,
    reportsApplied: (log.reports ?? []).reduce((a, b) => a + b, 0),
    processes,
  };
}

module.exports = { summarize };

if (require.main === module) process.stdout.write(JSON.stringify(summarize(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))), null, 2));
