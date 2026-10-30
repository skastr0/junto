/**
 * Terminal performance baseline: run it against a build, keep the summary,
 * compare any later build to it.
 *
 *   bun scripts/perf-terminal-baseline.ts run --label <name> [--runs 3]
 *       [--conditions scroll,scroll-stream,type,watch] [--max-load <load1>]
 *       [--out <file>] [--keep-traces]
 *   bun scripts/perf-terminal-baseline.ts compare <base.json> <head.json> [--tolerance 0.15]
 *
 * run measures whatever out/ holds (the build stamp names the commit), one
 * app launch per condition per run, interleaved so drift spreads across
 * conditions, each under the app-run lock. Before each launch it waits for
 * the one-minute load to fall to --max-load (default: the core count), up to
 * ten minutes, and records the load either way. The summary holds the median,
 * min and max of every metric, and lands in docs/research/perf-baselines/.
 *
 * compare prints every metric and exits 1 when a headline metric is worse by
 * more than the tolerance and outside the base's own run spread.
 *
 * Frame cadence, renderer main-thread cost, key-to-echo latency and the main
 * process's event-loop stalls are the headline: they are what the operator
 * feels. Wheel latency includes the
 * rig's CDP injection, so it is reported but never fails a compare.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SPEC = "e2e/scenarios/perf-terminal-baseline.spec.ts";
const CONDITIONS = ["scroll", "scroll-stream", "type", "type-busy", "watch"] as const;
type Condition = (typeof CONDITIONS)[number];

type RunResult = Record<string, any>;
type Metric = {
  readonly name: string;
  readonly better: "lower" | "higher";
  readonly headline: boolean;
  readonly conditions: readonly Condition[];
  readonly read: (run: RunResult) => number | null | undefined;
};

const perS = (ms: number | undefined, run: RunResult): number | null => (ms === undefined ? 0 : Math.round((ms / run.windowS) * 10) / 10);
const ALL = CONDITIONS;
const MOVING: readonly Condition[] = ["scroll", "scroll-stream", "watch"];
const SCROLLING: readonly Condition[] = ["scroll", "scroll-stream"];
const TYPING: readonly Condition[] = ["type", "type-busy"];

const METRICS: readonly Metric[] = [
  { name: "framesPresentedPerS", better: "higher", headline: true, conditions: MOVING, read: (r) => r.frames.presentedPerS },
  { name: "frameGapP50Ms", better: "lower", headline: false, conditions: SCROLLING, read: (r) => r.frames.gapMs.p50 },
  { name: "frameGapP95Ms", better: "lower", headline: true, conditions: SCROLLING, read: (r) => r.frames.gapMs.p95 },
  { name: "frameGapMaxMs", better: "lower", headline: false, conditions: SCROLLING, read: (r) => r.frames.gapMs.max },
  { name: "frameGapsOver16_7", better: "lower", headline: true, conditions: SCROLLING, read: (r) => r.frames.gapsOver16_7 },
  { name: "rafGapsOver16_7", better: "lower", headline: true, conditions: ALL, read: (r) => r.raf.gapsOver16_7 },
  { name: "rendererMainMsPerS", better: "lower", headline: true, conditions: ALL, read: (r) => r.main.busyMsPerS },
  { name: "mainTaskP95Ms", better: "lower", headline: true, conditions: ALL, read: (r) => r.main.taskMs.p95 },
  { name: "mainTasksOver50ms", better: "lower", headline: false, conditions: ALL, read: (r) => r.main.tasksOver50ms },
  { name: "paintMsPerS", better: "lower", headline: true, conditions: ALL, read: (r) => perS(r.main.events.Paint?.ms, r) },
  { name: "compositorUpdateMsPerS", better: "lower", headline: false, conditions: ALL, read: (r) => perS(r.main.events["PaintArtifactCompositor::Update"]?.ms, r) },
  { name: "layoutMsPerS", better: "lower", headline: false, conditions: ALL, read: (r) => perS(r.main.events.Layout?.ms, r) },
  { name: "keyToEchoDrawnP50Ms", better: "lower", headline: true, conditions: TYPING, read: (r) => r.echoMs?.drawn.p50 },
  { name: "keyToEchoDrawnP95Ms", better: "lower", headline: true, conditions: TYPING, read: (r) => r.echoMs?.drawn.p95 },
  { name: "keyToEchoDrawnMaxMs", better: "lower", headline: false, conditions: TYPING, read: (r) => r.echoMs?.drawn.max },
  { name: "keyToEchoParsedP95Ms", better: "lower", headline: false, conditions: TYPING, read: (r) => r.echoMs?.parsed.p95 },
  { name: "mainLoopRttP99Ms", better: "lower", headline: true, conditions: ALL, read: (r) => r.mainLoop?.rttMs.p99 },
  { name: "mainLoopStalledMsPerS", better: "lower", headline: false, conditions: ALL, read: (r) => r.mainLoop?.stalledMsPerS },
  { name: "wheelToScreenP95Ms", better: "lower", headline: false, conditions: SCROLLING, read: (r) => r.inputLatencyMs.MOUSE_WHEEL?.p95 },
  { name: "viewportMovedFrames", better: "higher", headline: false, conditions: SCROLLING, read: (r) => r.framesViewportMoved },
];

type Stat = { median: number; min: number; max: number; runs: number[] };
type Summary = {
  schema: 1;
  label: string;
  build: { commit: string; version: string };
  recordedAt: string;
  machine: { model: string; cpu: string; cores: number; os: string };
  runsPerCondition: number;
  conditions: Record<string, { metrics: Record<string, Stat>; loadAtStart: number[]; topPaint: Array<{ node: string; msPerS: number }> }>;
};

const sh = (cmd: string, args: string[]): string => spawnSync(cmd, args, { encoding: "utf8" }).stdout?.trim() ?? "";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : Math.round(((s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) * 100) / 100;
};

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const waitForLoad = async (maxLoad: number): Promise<number> => {
  const deadline = Date.now() + 10 * 60_000;
  while (loadavg()[0]! > maxLoad && Date.now() < deadline) {
    console.log(`load ${loadavg()[0]!.toFixed(1)} over ${String(maxLoad)}, waiting`);
    await sleep(15_000);
  }
  return Math.round(loadavg()[0]! * 10) / 10;
};

const run = async (args: string[]): Promise<void> => {
  const label = flag(args, "label");
  if (!label) throw new Error("run needs --label <name>");
  const runs = Number(flag(args, "runs") ?? 3);
  const conditions = (flag(args, "conditions")?.split(",") ?? [...CONDITIONS]) as Condition[];
  for (const c of conditions) if (!CONDITIONS.includes(c)) throw new Error(`unknown condition ${c}`);
  const maxLoad = Number(flag(args, "max-load") ?? cpus().length);
  const out = flag(args, "out") ?? join(ROOT, "docs/research/perf-baselines", `terminal-${label}.json`);
  const stampPath = join(ROOT, "out/build-source.json");
  if (!existsSync(stampPath)) throw new Error("out/ has no build stamp: build first (electron-vite build)");
  const commit = String(JSON.parse(readFileSync(stampPath, "utf8")).sourceCommit);
  const version = sh("git", ["-C", ROOT, "describe", "--tags", "--always", commit]);
  const work = mkdtempSync(join(tmpdir(), "perf-terminal-"));
  console.log(`measuring ${version} (${commit.slice(0, 9)}), ${String(runs)} runs of ${conditions.join(", ")}, results in ${work}`);

  const results = new Map<Condition, Array<{ run: RunResult; load: number }>>();
  for (let r = 1; r <= runs; r++) {
    for (const condition of conditions) {
      const load = await waitForLoad(maxLoad);
      const file = join(work, `${condition}-${String(r)}.json`);
      console.log(`run ${String(r)}/${String(runs)} ${condition} (load ${String(load)})`);
      const e2e = spawnSync(join(ROOT, "scripts/run-e2e.sh"), [SPEC], {
        cwd: ROOT,
        stdio: ["ignore", "inherit", "inherit"],
        env: {
          ...process.env,
          PERF_TERMINAL_COND: condition,
          PERF_TERMINAL_OUT: file,
          PERF_TERMINAL_KEEP_TRACE: args.includes("--keep-traces") ? "1" : "0",
          JUNTO_E2E_EXPECT_COMMIT: commit,
          JUNTO_E2E_SHOW: "1",
          JUNTO_APP_RUN_LOCK_WAIT: process.env.JUNTO_APP_RUN_LOCK_WAIT ?? "1800",
        },
      });
      if (e2e.status !== 0 || !existsSync(file)) {
        console.error(`run ${String(r)} ${condition} failed (exit ${String(e2e.status)}); it is left out`);
        continue;
      }
      const list = results.get(condition) ?? [];
      list.push({ run: JSON.parse(readFileSync(file, "utf8")) as RunResult, load });
      results.set(condition, list);
    }
  }

  const summary: Summary = {
    schema: 1,
    label,
    build: { commit, version },
    recordedAt: new Date().toISOString(),
    machine: {
      model: sh("sysctl", ["-n", "hw.model"]),
      cpu: sh("sysctl", ["-n", "machdep.cpu.brand_string"]),
      cores: cpus().length,
      os: `macOS ${sh("sw_vers", ["-productVersion"])}`,
    },
    runsPerCondition: runs,
    conditions: {},
  };
  for (const [condition, list] of results) {
    const metrics: Record<string, Stat> = {};
    for (const metric of METRICS) {
      if (!metric.conditions.includes(condition)) continue;
      const values = list.map(({ run: r }) => metric.read(r)).filter((v): v is number => typeof v === "number");
      if (values.length) metrics[metric.name] = { median: median(values), min: Math.min(...values), max: Math.max(...values), runs: values };
    }
    // What repaints, from the median run by renderer main cost.
    const byMain = [...list].sort((a, b) => a.run.main.busyMsPerS - b.run.main.busyMsPerS);
    const mid = byMain[Math.floor(byMain.length / 2)]!.run;
    summary.conditions[condition] = {
      metrics,
      loadAtStart: list.map(({ load }) => load),
      topPaint: (mid.paintByNode as Array<{ node: string; ms: number }>).slice(0, 3).map((p) => ({ node: p.node, msPerS: Math.round((p.ms / mid.windowS) * 10) / 10 })),
    };
  }
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`wrote ${out}`);
  printTable(summary);
};

const printTable = (summary: Summary, base?: Summary, tolerance = 0.15): boolean => {
  let regressed = false;
  const rows: string[][] = [["condition", "metric", ...(base ? ["base", "head", "change", ""] : ["median", "min", "max"])]];
  for (const [condition, { metrics }] of Object.entries(summary.conditions)) {
    for (const metric of METRICS) {
      const head = metrics[metric.name];
      if (!head) continue;
      if (!base) {
        rows.push([condition, metric.name, String(head.median), String(head.min), String(head.max)]);
        continue;
      }
      const was = base.conditions[condition]?.metrics[metric.name];
      if (!was) {
        rows.push([condition, metric.name, "-", String(head.median), "", "new"]);
        continue;
      }
      const delta = head.median - was.median;
      const rel = was.median === 0 ? (delta === 0 ? 0 : Infinity) : delta / Math.abs(was.median);
      const worse = metric.better === "lower" ? delta > 0 : delta < 0;
      // Worse only when beyond the tolerance and outside the base's own run spread.
      const outside = metric.better === "lower" ? head.median > was.max : head.median < was.min;
      const flagged = worse && Math.abs(rel) > tolerance && outside;
      if (flagged && metric.headline) regressed = true;
      const verdict = flagged ? (metric.headline ? "WORSE" : "worse (not gating)") : !worse && Math.abs(rel) > tolerance ? "better" : "";
      rows.push([condition, metric.name, String(was.median), String(head.median), Number.isFinite(rel) ? `${rel > 0 ? "+" : ""}${Math.round(rel * 100)}%` : "new cost", verdict]);
    }
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  for (const row of rows) console.log(row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd());
  return regressed;
};

const compare = (args: string[]): void => {
  const [basePath, headPath] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!basePath || !headPath) throw new Error("compare needs <base.json> <head.json>");
  const base = JSON.parse(readFileSync(basePath, "utf8")) as Summary;
  const head = JSON.parse(readFileSync(headPath, "utf8")) as Summary;
  console.log(`base ${base.label} ${base.build.version}, head ${head.label} ${head.build.version}`);
  if (base.machine.model !== head.machine.model) console.log(`note: different machines (${base.machine.model}, ${head.machine.model}); compare with care`);
  const regressed = printTable(head, base, Number(flag(args, "tolerance") ?? 0.15));
  if (regressed) {
    console.log("headline regression");
    process.exit(1);
  }
};

const [command, ...rest] = process.argv.slice(2);
if (command === "run") await run(rest);
else if (command === "compare") compare(rest);
else throw new Error("usage: bun scripts/perf-terminal-baseline.ts run --label <name> | compare <base.json> <head.json>");
