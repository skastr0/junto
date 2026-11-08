/**
 * What zooming costs, on a factory-size board, before and after a change.
 *
 *   bun scripts/probe-zoom-sweep.ts --app-root DIR [--label L] [--seconds 8]
 *     [--port 9345] [--fixture factory|large|small] [--out FILE]
 *   bun scripts/probe-zoom-sweep.ts --compare before=DIR,after=DIR
 *     [--repeats 3] [--out FILE]
 *
 * DIR is a checkout whose `out/` is a PRODUCTION build (electron-vite build,
 * not `bun run dev`: React dev and StrictMode skew every number). The script
 * runs from any checkout; it never builds and never touches ~/.junto.
 *
 * Each run boots the app on a throwaway HOME with JUNTO_PERF=1,
 * --remote-debugging-port=PORT and a main-process --inspect port, dark theme,
 * first-run tour marked seen. The canvas is one fixed fixture built from world
 * coordinates (no randomness), every seat injected as "working" so its ring
 * moves. The camera starts at fit view and a scripted zoom sweeps the whole
 * range, alternating direction every ZOOM_PHASE_MS with trusted ctrl+wheel
 * (the trackpad pinch path), crossing all four tiers several times.
 *
 * The report names each cost separately, because they have different fixes:
 *   style     UpdateLayoutTree on the renderer main thread
 *   layout    Layout
 *   paint     Paint / PaintImage
 *   layerize  PaintArtifactCompositor::Update
 *   raster    RasterTask and friends (raster workers)
 *   gpu       the GPU process's own trace time, and ioreg accumulatedGPUTime
 *   script    FunctionCall / EventDispatch (React and store work)
 *   react     react-dom profiling commits (root, canvas, per surface)
 *   dom       nodes added or removed inside the viewport (a remount is a cost)
 *
 * Invalid runs are reported, never repaired (PERF_LEDGER.md): an occluded
 * window gives 0 frames, a light theme or a sweep that never left one tier is
 * not the scenario. Any of these marks the run `valid: false` and exits 2.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  modelFixture, modelMessagesWire, modelNote, modelRegion, modelSeat, placeOnMachine,
} from "../e2e/harness/model";
import { defaultMachineName } from "../src/shared/machine-name";
import { startRendererServer } from "../e2e/harness/renderer-server";

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const round1 = (value: number) => Math.round(value * 10) / 10;
const medianOf = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return round1(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
};

// Interleaved repeats: before, after, before, after, one app at a time, so load
// drift hits both builds alike. Each run is this same script in a child.
const compareArg = arg("compare", "");
if (compareArg !== "") {
  const builds = compareArg.split(",").map((entry) => {
    const [name, root] = entry.split("=");
    return { name: name!, root: resolve(root!) };
  });
  const repeats = Number(arg("repeats", "3"));
  const compareOut = arg("out", "");
  const runs: Array<{ build: string; repeat: number; exit: number; report: any }> = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const build of builds) {
      const scratch = mkdtempSync(join(tmpdir(), "zoom-sweep-run-"));
      const file = join(scratch, "run.json");
      const child = spawnSync(
        process.execPath,
        [import.meta.path, "--app-root", build.root, "--label", `${build.name}-${repeat}`, "--out", file, "--seconds", arg("seconds", "8"), "--port", arg("port", "9345"), "--fixture", arg("fixture", "factory")],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      const report = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
      rmSync(scratch, { recursive: true, force: true });
      runs.push({ build: build.name, repeat, exit: child.status ?? -1, report });
      console.error(`zoom sweep: ${build.name} #${repeat} exit ${child.status}`);
      for (let wait = 0; wait < 40 && spawnSync("pgrep", ["-f", `${build.root}/node_modules/electron/dist`]).status === 0; wait += 1) await sleep(500);
      await sleep(3_000);
    }
  }
  const keys = ["rendererBusyMsPerSecond", "scriptMsPerSecond", "layoutMsPerSecond", "styleMsPerSecond", "reactCommitsPerSecond", "reactCommitMsPerSecond", "domAddedPerSecond", "partsAddedPerSecond", "gpuAccumMsPerSecond"] as const;
  const summary = builds.map((build) => {
    const rows = runs
      .filter((run) => run.build === build.name && run.report)
      .map((run) => ({ repeat: run.repeat, report: run.report }));
    const valid = rows.filter((row) => row.report.valid);
    const med = (read: (report: any) => number | null | undefined) =>
      medianOf(valid.map((row) => read(row.report)).filter((value): value is number => typeof value === "number"));
    return {
      build: build.name,
      sourceCommit: rows[0]?.report.sourceCommit ?? null,
      validRuns: valid.length,
      runs: rows.length,
      median: {
        ...(Object.fromEntries(keys.map((key) => [key, med((report) => report.zoom[key])])) as Record<(typeof keys)[number], number | null>),
        frameP50: med((report) => report.zoom.frameMs?.p50),
        frameP99: med((report) => report.zoom.frameMs?.p99),
        frameMax: med((report) => report.zoom.frameMs?.max),
        droppedAtDisplayRate: med((report) => report.zoom.frameMs?.droppedAtDisplayRate),
        tierFlips: med((report) => report.events.tierFlips),
        markRemounts: med((report) => report.events.markRemounts),
      },
      traced: {
        styleMs: med((report) => report.trace?.renderer.styleMs),
        layoutMs: med((report) => report.trace?.renderer.layoutMs),
        paintMs: med((report) => report.trace?.renderer.paintMs),
        layerizeMs: med((report) => report.trace?.renderer.layerizeMs),
        scriptMs: med((report) => report.trace?.renderer.scriptMs),
        rasterMs: med((report) => report.trace?.rasterMs),
        gpuMs: med((report) => report.trace?.gpuMs),
      },
      problems: valid.length < rows.length ? rows.flatMap((row) => row.report.zoom.problems.map((problem: string) => `#${row.repeat}: ${problem}`)) : [],
    };
  });
  const out = {
    command: `bun scripts/probe-zoom-sweep.ts --compare ${compareArg} --repeats ${repeats}`,
    when: new Date().toISOString(),
    order: runs.map((run) => `${run.build}#${run.repeat}`),
    summary,
    runs: runs.map((run) => run.report),
  };
  const json = JSON.stringify(out, null, 2);
  if (compareOut !== "") writeFileSync(compareOut, json);
  for (const entry of summary) {
    console.log(
      `${entry.build} ${entry.sourceCommit?.slice(0, 9) ?? "?"} ` +
        `busy ${entry.median.rendererBusyMsPerSecond} ms/s, style ${entry.median.styleMsPerSecond}, layout ${entry.median.layoutMsPerSecond}, ` +
        `react ${entry.median.reactCommitsPerSecond} commits/s, gpu ${entry.median.gpuAccumMsPerSecond} ms/s, ` +
        `frame p99 ${entry.median.frameP99} ms, dropped ${entry.median.droppedAtDisplayRate}, remounts ${entry.median.markRemounts}, valid ${entry.validRuns}/${entry.runs}`,
    );
  }
  process.exit(0);
}

const appRoot = resolve(arg("app-root", ""));
const label = arg("label", "run");
const seconds = Number(arg("seconds", "8"));
const port = Number(arg("port", "9345"));
const outPath = arg("out", "");
/** Where to write one screenshot per phase end (the zoom reached, for ring sharpness). */
const shotsDir = arg("shots", "");
/** Zooms to settle at and capture after the sweep, for a sharpness comparison. */
const shotZooms = arg("shot-zooms", "").split(",").filter(Boolean).map(Number);
const fixtureName = arg("fixture", "factory");
/**
 * Which cost the sweep isolates: `cross` crosses every tier (the operator's
 * zoom in and out); `within` stays inside the overview (same camera work, no
 * tier change, no ring remount) so the per-frame cost shows on its own.
 */
const sweepArm = arg("arm", "cross");
/**
 * A page-side variant that turns one mechanism off, to name what it costs.
 * Any variant other than `product` makes the run a diagnostic: it is never a
 * shipping configuration, and its numbers never stand in for the product's.
 *   no-rest-scale  the camera-rest publish of --far-seat-scale,
 *                  --seat-floor-scale and --node-s, and its FLIP ease, are
 *                  dropped: the ring size never changes after a zoom.
 *   no-tier-css    the canvas never carries data-canvas-tier, so no tier rule
 *                  applies (the ring still remounts, the clusters still run).
 */
const variant = arg("variant", "product");
/** The operator's Mac runs with the accessibility tree off (PERF_LEDGER F2); force that for an A/B. */
const forceAxOff = !flag("keep-accessibility");
const CANVAS = "zoom-sweep";
/** ctrl+wheel is d3's pinch path; deltaY 12 is about 18% per event, so ten cross every tier. */
const ZOOM_DELTA = 12;
/** Every phase is exactly this many wheel events, so both builds get the same script. */
const ZOOM_EVENTS_PER_PHASE = 10;
/** A phase end is held this long, so rest work (scale publish, FLIP ease) lands inside the window. */
const ZOOM_HOLD_MS = 600;
const WHEEL_MS = 1000 / 120;

if (appRoot === "") {
  console.error("usage: bun scripts/probe-zoom-sweep.ts --app-root DIR [--label L] [--seconds S] [--port P] [--fixture NAME] [--out FILE]\n       bun scripts/probe-zoom-sweep.ts --compare before=DIR,after=DIR [--repeats 3]");
  process.exit(64);
}
if (!["product", "no-rest-scale", "no-tier-css", "coarse-rest", "integer-rest", "static-visibility"].includes(variant)) {
  console.error("zoom sweep: --variant is product, no-rest-scale, no-tier-css, coarse-rest, integer-rest or static-visibility");
  process.exit(64);
}
if (sweepArm !== "cross" && sweepArm !== "within") {
  console.error("zoom sweep: --arm is cross or within");
  process.exit(64);
}
if (!["small", "large", "factory"].includes(fixtureName)) {
  console.error("zoom sweep: --fixture is small, large or factory");
  process.exit(64);
}
for (const path of ["out/main/index.js", "out/renderer/index.html"]) {
  if (!existsSync(join(appRoot, path))) {
    console.error(`zoom sweep: ${join(appRoot, path)} is missing; build ${appRoot} first (electron-vite build)`);
    process.exit(64);
  }
}
if (!existsSync(join(appRoot, "node_modules/electron/package.json"))) {
  console.error(`zoom sweep: ${appRoot}/node_modules/electron is missing; install the checkout's dependencies first`);
  process.exit(64);
}
const repoHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: appRoot, encoding: "utf8" }).stdout?.trim() || null;
const repoDirty = (spawnSync("git", ["status", "--porcelain"], { cwd: appRoot, encoding: "utf8" }).stdout ?? "").trim().split("\n").filter(Boolean).length > 0;
const provenancePath = join(appRoot, "out/package-runtime-provenance.json");
const sourceCommit: string | null = existsSync(provenancePath)
  ? (JSON.parse(readFileSync(provenancePath, "utf8")).sourceCommit ?? null)
  : null;

// --- the fixture -----------------------------------------------------------
// A ward is a region holding a 4 x 4 seat block, with two notes beside it.
// Wards tile 6 x 4. Seats message the next seat along their row, so the board
// carries the wire count a factory board has. Nothing here is random.
const WARDS_X = fixtureName === "small" ? 1 : 6;
const WARDS_Y = fixtureName === "small" ? 1 : fixtureName === "large" ? 2 : 4;
const SEAT_W = 240;
const SEAT_H = 96;
const WARD_W = 1560;
const WARD_H = 1040;
const nodes: ReturnType<typeof modelSeat>[] = [];
const regions: ReturnType<typeof modelRegion>[] = [];
const notes: ReturnType<typeof modelNote>[] = [];
const seatIds: string[] = [];
let order = 1;
for (let wardY = 0; wardY < WARDS_Y; wardY += 1) {
  for (let wardX = 0; wardX < WARDS_X; wardX += 1) {
    const wx = wardX * WARD_W;
    const wy = wardY * WARD_H;
    const ward = `ward-${String(order).padStart(2, "0")}`;
    regions.push(modelRegion({ id: region(ward), label: ward, x: wx, y: wy, width: WARD_W - 40, height: WARD_H - 40 }));
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 4; col += 1) {
        const id = `zoom-seat-${String(order).padStart(2, "0")}-${String(row)}${String(col)}`;
        seatIds.push(id);
        nodes.push(modelSeat({ id, x: wx + 40 + col * 340, y: wy + 60 + row * 210, label: `${ward} ${row}${col}` }));
      }
    }
    notes.push(modelNote(`zoom-note-${String(order).padStart(2, "0")}-a`, `Ward ${ward} notes`, wx + 40, wy + 920, ));
    notes.push(modelNote(`zoom-note-${String(order).padStart(2, "0")}-b`, `Ward ${ward} tasks`, wx + 720, wy + 920));
    order += 1;
  }
}
const wires = seatIds.flatMap((id, index) =>
  index % 4 === 3 || index + 1 >= seatIds.length
    ? []
    : [modelMessagesWire(`zoom-wire-${String(index).padStart(3, "0")}`, id, seatIds[index + 1]!, nodes)]);
const fixtureRows = [...regions, ...nodes, ...notes];
const seatCount = seatIds.length;

function region(ward: string): string {
  return `zoom-region-${ward}`;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Target = { type: string; url: string; webSocketDebuggerUrl: string };

const listTargets = async (at: number): Promise<Target[]> =>
  (await (await fetch(`http://127.0.0.1:${at}/json/list`)).json()) as Target[];

const connect = async (url: string) => {
  const ws = new WebSocket(url);
  await new Promise<void>((ok, fail) => {
    ws.onopen = () => ok();
    ws.onerror = () => fail(new Error(`cannot connect to ${url}`));
  });
  let next = 1;
  const waiting = new Map<number, (message: { result?: Json; error?: unknown }) => void>();
  const listeners = new Map<string, Array<(params: any) => void>>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    } else if (typeof message.method === "string") {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params);
    }
  };
  const send = async (method: string, params: Record<string, Json> = {}, timeoutMs = 60_000): Promise<any> => {
    const id = next++;
    const reply = await new Promise<{ result?: Json; error?: unknown }>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`CDP timeout: ${method}`)), timeoutMs);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        done(message);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
    if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
    return reply.result;
  };
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value as T;
  };
  const on = (method: string, listener: (params: any) => void) => {
    listeners.set(method, [...(listeners.get(method) ?? []), listener]);
  };
  return { send, evaluate, on, close: () => ws.close() };
};
type Cdp = Awaited<ReturnType<typeof connect>>;

const waitFor = async <T,>(what: string, ms: number, probe: () => Promise<T | undefined | false>): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const found = await probe().catch(() => undefined);
    if (found) return found;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
};

/** accumulatedGPUTime per process pid, from the GPU driver's AppUsage records. */
const gpuTimeByPid = (): Map<number, number> => {
  const out = new Map<number, number>();
  const text = spawnSync("ioreg", ["-l", "-w", "0"], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }).stdout ?? "";
  for (const block of text.split(/\n(?=[^\n]*-o AGXDeviceUserClient)/u)) {
    const creator = /"IOUserClientCreator"\s*=\s*"pid (\d+),/u.exec(block);
    const usage = /"AppUsage"\s*=\s*\(([^)]*)\)/u.exec(block);
    if (!creator || !usage) continue;
    const ns = [...usage[1]!.matchAll(/"accumulatedGPUTime"\s*=\s*(\d+)/gu)].reduce((sum, match) => sum + Number(match[1]), 0);
    const pid = Number(creator[1]);
    out.set(pid, (out.get(pid) ?? 0) + ns);
  }
  return out;
};

const HOOK = `globalThis.__probe = require("electron");\n`;

// A throwaway HOME and user-data dir, the same shape the e2e sandbox makes
// (sandbox.ts): macOS caps AF_UNIX socket paths near 104 bytes, so the temp
// root must leave room for <home>/.junto/<plane>/control.sock.
const controlSocketFits = (root: string): boolean =>
  Buffer.byteLength(join(root, "junto-zoom-abcdef", "home", ".junto", "operator", "control.sock")) <= 103;
const sandbox = (() => {
  const root = mkdtempSync(join(controlSocketFits(tmpdir()) ? tmpdir() : "/tmp", "junto-zoom-"));
  const userDataDir = join(root, "user-data");
  const homeDir = join(root, "home");
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(join(homeDir, ".junto", "state"), { recursive: true });
  return { root, userDataDir, homeDir };
})();
const destroySandbox = (root: string) => rmSync(root, { recursive: true, force: true });
writeFileSync(join(sandbox.root, "probe-hook.cjs"), HOOK);

// Arm the renderer's own performance harness: it reads JUNTO_PERF from
// globalThis (perf-flag.ts), which a sandboxed renderer cannot get from the
// main process environment, and a reload would cost the CDP session. Serve a
// copy of the built renderer whose index.html sets it before the bundle loads.
const rendererDir = join(sandbox.root, "renderer");
cpSync(join(appRoot, "out/renderer"), rendererDir, { recursive: true });
const indexHtml = readFileSync(join(rendererDir, "index.html"), "utf8");
writeFileSync(
  join(rendererDir, "index.html"),
  indexHtml.replace(/<head[^>]*>/iu, (head) => `${head}<script>globalThis.JUNTO_PERF = "1";</script>${
    variant === "static-visibility"
      ? `<script>
          window.IntersectionObserver = class {
            constructor(callback) { this.callback = callback; this.targets = new Set(); }
            observe(target) {
              if (this.targets.has(target)) return;
              this.targets.add(target);
              const entry = { target, isIntersecting: true, intersectionRatio: 1, boundingClientRect: target.getBoundingClientRect?.() ?? null, intersectionRect: target.getBoundingClientRect?.() ?? null, rootBounds: null, time: performance.now() };
              this.callback([entry], this);
            }
            unobserve(target) { this.targets.delete(target); }
            disconnect() { this.targets.clear(); }
            takeRecords() { return []; }
          };
        </script>`
      : ""
  }`),
);
const server = await startRendererServer(rendererDir);
const electronBinary = createRequire(join(appRoot, "package.json"))("electron") as string;
const inherited = { ...(process.env as Record<string, string>) };
for (const name of ["JUNTO_HOME", "JUNTO_WORK_HOME", "JUNTO_WORK_SOCKET", "JUNTO_SOCKET", "JUNTO_NODE_REF", "JUNTO_SEAT", "JUNTO_TOKEN", "JUNTO_WORK_TOKEN"]) {
  delete inherited[name];
}
const inspectPort = port + 1;
const appLogPath = join(sandbox.root, "app.log");
const appLog = openSync(appLogPath, "a");
const child: ChildProcess = spawn(
  electronBinary,
  [
    "-r", join(sandbox.root, "probe-hook.cjs"),
    appRoot,
    `--user-data-dir=${sandbox.userDataDir}`,
    `--remote-debugging-port=${port}`,
    `--inspect=${inspectPort}`,
    "--mute-audio",
    ...(forceAxOff ? ["--disable-renderer-accessibility"] : []),
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
  {
    stdio: ["ignore", appLog, appLog],
    env: {
      ...inherited,
      HOME: sandbox.homeDir,
      JUNTO_HOME: sandbox.homeDir,
      TMPDIR: sandbox.root,
      SHELL: "/bin/sh",
      JUNTO_E2E: "1",
      JUNTO_E2E_SHOW: "1",
      JUNTO_PERF: "1",
      JUNTO_SECRET_STORE: "file",
      ELECTRON_RENDERER_URL: server.url.replace(/\/$/u, ""),
      PATH: `${join(process.cwd(), "e2e/fakes/bin")}:${dirname(Bun.which("node") ?? process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
  },
);

let page: Cdp | undefined;
let browser: Cdp | undefined;
let main: Cdp | undefined;
const teardown = async () => {
  for (const session of [page, browser, main]) session?.close();
  child.kill("SIGTERM");
  await Promise.race([new Promise((done) => child.once("exit", done)), sleep(15_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await server.close().catch(() => undefined);
  closeSync(appLog);
  if (process.env.JUNTO_KEEP_SANDBOX === "1") console.error(`zoom sweep: sandbox kept at ${sandbox.root}`);
  else destroySandbox(sandbox.root);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child.kill("SIGKILL");
    process.exit(130);
  });
}

/** Self time by function, from a CDP CPU profile. */
const summarizeProfile = (profile: any) => {
  if (!profile || !Array.isArray(profile.nodes)) return [];
  const byNode = new Map<number, { fn: string; url: string; line: number }>();
  for (const node of profile.nodes) {
    const frame = node.callFrame ?? {};
    byNode.set(node.id, { fn: frame.functionName || "(anonymous)", url: String(frame.url ?? ""), line: Number(frame.lineNumber ?? -1) + 1 });
  }
  const selfUs = new Map<number, number>();
  const samples: number[] = profile.samples ?? [];
  const deltas: number[] = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i += 1) {
    const id = samples[i]!;
    const us = deltas[i] ?? 0;
    selfUs.set(id, (selfUs.get(id) ?? 0) + us);
  }
  const byFunction = new Map<string, number>();
  for (const [id, us] of selfUs) {
    const info = byNode.get(id);
    if (!info) continue;
    const url = info.url.replace(/^.*\//u, "");
    const key = `${info.fn} @ ${url}:${String(info.line)}`;
    byFunction.set(key, (byFunction.get(key) ?? 0) + us);
  }
  return [...byFunction]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([fn, us]) => ({ fn, ms: Math.round(us / 100) / 10 }));
};

/** Trace event bookkeeping: sum durations by name, per process, plus 100 ms buckets of the renderer main thread. */
const summarizeTrace = (events: any[], rendererPid: number, gpuPid: number) => {
  const byName = new Map<string, number>();
  const styleRecalcs: number[] = [];
  const invalidations: Array<{ reason: string; node: string; extra: string }> = [];
  const mouseMoves = { count: 0, us: 0 };
  const rendererByName = new Map<string, number>();
  const gpuByName = new Map<string, number>();
  const buckets = new Map<number, Map<string, number>>();
  let rasterUs = 0;
  let gpuUs = 0;
  const add = (name: string, us: number, pid: number, event?: any) => {
    byName.set(name, (byName.get(name) ?? 0) + us);
    if (pid === rendererPid) {
      rendererByName.set(name, (rendererByName.get(name) ?? 0) + us);
      if (/Raster/u.test(name)) rasterUs += us;
      if (name === "UpdateLayoutTree") {
        const count = Number(event?.args?.beginData?.elementCount);
        styleRecalcs.push(Number.isFinite(count) ? count : -1);
      }
      if (name === "EventHandler::handleMouseMoveEvent") {
        mouseMoves.count += 1;
        mouseMoves.us += us;
      }
    }
    if (pid === gpuPid) gpuUs += us;
  };
  const open = new Map<string, number>();
  let firstTs = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (typeof event.name !== "string" || event.ph !== "X" || typeof event.ts !== "number" || event.ts <= 0) continue;
    firstTs = Math.min(firstTs, event.ts);
  }
  for (const event of events) {
    if (typeof event.name !== "string") continue;
    if (event.name === "StyleRecalcInvalidationTracking" || event.name === "StyleInvalidatorInvalidationTracking") {
      const data = event.args?.data ?? {};
      invalidations.push({
        reason: String(data.reason ?? "?"),
        node: String(data.nodeName ?? "").slice(0, 40),
        extra: String(data.extraData ?? "").slice(0, 80),
      });
    }
    const key = `${String(event.pid)}:${String(event.tid)}`;
    if (event.ph === "X" && typeof event.dur === "number") {
      add(event.name, event.dur, event.pid, event);
      if (event.pid === rendererPid && typeof event.ts === "number") {
        const bucket = Math.floor((event.ts - firstTs) / 100_000);
        const row = buckets.get(bucket) ?? new Map<string, number>();
        row.set(event.name, (row.get(event.name) ?? 0) + event.dur / 1000);
        buckets.set(bucket, row);
      }
    } else if (event.ph === "B") {
      open.set(`${key}:${event.name}`, event.ts);
    } else if (event.ph === "E") {
      const begin = open.get(`${key}:${event.name}`);
      if (begin === undefined) continue;
      open.delete(`${key}:${event.name}`);
      const us = event.ts - begin;
      add(event.name, us, event.pid, event);
      if (event.pid === rendererPid) {
        const bucket = Math.floor((begin - firstTs) / 100_000);
        const row = buckets.get(bucket) ?? new Map<string, number>();
        row.set(event.name, (row.get(event.name) ?? 0) + us / 1000);
        buckets.set(bucket, row);
      }
    }
  }
  const sumMatching = (map: Map<string, number>, pattern: RegExp) =>
    Math.round([...map].filter(([name]) => pattern.test(name)).reduce((sum, [, us]) => sum + us, 0) / 100) / 10;
  const top = (map: Map<string, number>, limit: number) =>
    [...map].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, us]) => [name, Math.round(us / 100) / 10] as const);
  const bucketRows = [...buckets].map(([bucket, row]) => ({
    atMs: bucket * 100,
    totalMs: Math.round([...row.values()].reduce((a, b) => a + b, 0) * 10) / 10,
    top: [...row].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, ms]) => [name, Math.round(ms * 10) / 10] as const),
  })).sort((a, b) => b.totalMs - a.totalMs);
  return {
    events: events.length,
    renderer: {
      styleMs: sumMatching(rendererByName, /^(UpdateLayoutTree|RecalculateStyles)$/u),
      layoutMs: sumMatching(rendererByName, /^(Layout|Resize)$/u),
      paintMs: sumMatching(rendererByName, /^(Paint|PaintImage|PrePaint)$/u),
      layerizeMs: sumMatching(rendererByName, /^PaintArtifactCompositor::Update$/u),
      scriptMs: sumMatching(rendererByName, /^(FunctionCall|EventDispatch|TimerFire|v8\.run)$/u),
      styleRecalcs: {
        count: styleRecalcs.length,
        elementCounts: {
          min: styleRecalcs.length === 0 ? null : Math.min(...styleRecalcs.filter((count) => count >= 0)),
          median: medianOf(styleRecalcs.filter((count) => count >= 0)),
          max: styleRecalcs.length === 0 ? null : Math.max(...styleRecalcs.filter((count) => count >= 0)),
        },
      },
      mouseMoves: { count: mouseMoves.count, ms: Math.round(mouseMoves.us / 100) / 10 },
      invalidations: (() => {
        const counts = new Map<string, number>();
        for (const row of invalidations) {
          const key = `${row.reason} :: ${row.node} :: ${row.extra}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([key, count]) => ({ key, count }));
      })(),
      rasterMs: Math.round(rasterUs / 100) / 10,
      top: top(rendererByName, 16),
    },
    gpuMs: Math.round(gpuUs / 100) / 10,
    gpuTop: top(gpuByName, 8),
    top: top(byName, 20),
    busiest100ms: bucketRows.slice(0, 8),
    quietestMedian100ms: medianOf(bucketRows.map((row) => row.totalMs)),
  };
};

try {
  const pageTarget = await waitFor("the renderer page", 90_000, async () =>
    (await listTargets(port)).find((target) => target.type === "page" && target.url.startsWith(server.url)),
  ).catch((error: unknown) => {
    const log = readFileSync(appLogPath, "utf8").split("\n").slice(-40).join("\n");
    throw new Error(`${String(error)}\n--- app log ---\n${log}`);
  });
  const mainTarget = await waitFor("the main inspector", 30_000, async () => (await listTargets(inspectPort))[0]);
  page = await connect(pageTarget.webSocketDebuggerUrl);
  main = await connect(mainTarget.webSocketDebuggerUrl);
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  browser = await connect(version.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Performance.enable");

  // The served index.html armed the renderer harness (see rendererDir above);
  // refuse to measure if it did not, because a silent miss would read as
  // "no React commits", the most misleading number in the report.
  await waitFor("the perf harness", 30_000, () => page!.evaluate<boolean>(`Boolean(window.juntoPerf)`));

  await waitFor("the settings bridge", 30_000, () => page!.evaluate<boolean>(`Boolean(window.junto?.settingsPatch)`));
  await page.evaluate(`window.junto.settingsPatch({ advanced: { onboardingSeen: true }, appearance: { theme: "dark" } })`);

  // The fixture goes in through the window's own command API: this probe never
  // opens a product database, so it needs no core imports (probe-ring-cost's
  // seeded sandbox does, and the core bundle's ?nodeWorker import stopped it
  // loading under bun on 2026-11-08).
  const canvasName = await installCanvas(modelFixture(fixtureRows, wires));
  await page.evaluate(`window.junto.modelOpen(${JSON.stringify({ canvas: canvasName })})`);

  await waitFor("the seat cards", 120_000, async () =>
    (await page!.evaluate<number>(`document.querySelectorAll('.react-flow__node[data-id^="zoom-seat-"]').length`)) >= seatCount,
  );
  await page.evaluate(`document.querySelector(".react-flow__controls-fitview")?.click()`);
  await sleep(1_000);

  /** Replace the boot canvas's rows with `fixture`, on this app's own machine name. */
  async function installCanvas(fixture: ReturnType<typeof modelFixture>): Promise<string> {
    const names = await page!.evaluate<Array<{ name: string }>>(`window.junto.modelCanvases()`);
    const name = names[0]?.name ?? CANVAS;
    if (names.length === 0) {
      await page!.evaluate(`window.junto.modelCommand(${JSON.stringify({ _tag: "CreateCanvas", canvas: name })})`);
    }
    const opened = await page!.evaluate<{ nodes: Array<{ id: string }> }>(`window.junto.modelOpen(${JSON.stringify({ canvas: name })})`);
    const batch = (placed: ReturnType<typeof modelFixture>) => ({
      _tag: "Batch",
      canvas: name,
      steps: [
        ...(opened.nodes.length > 0 ? [{ _tag: "Remove", canvas: name, nodes: opened.nodes.map((node) => node.id), wires: [] }] : []),
        { _tag: "Add", canvas: name, nodes: placed.nodes, wires: placed.wires },
      ],
    });
    const send = (placed: ReturnType<typeof modelFixture>) =>
      page!.evaluate(`window.junto.modelCommand(${JSON.stringify(batch(placed))})`);
    try {
      await send(fixture);
    } catch (error) {
      const unresolved = String(error).includes("unresolved host");
      if (!unresolved) throw error;
      await send(placeOnMachine(fixture, defaultMachineName()));
    }
    return name;
  }

  const environment = await main.evaluate<{ accessibility: boolean; electron: string; chrome: string; displays: number; darkOs: boolean; displayHz: number; window: string }>(`({
    accessibility: __probe.app.accessibilitySupportEnabled,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    displays: __probe.screen.getAllDisplays().length,
    darkOs: __probe.nativeTheme.shouldUseDarkColors,
    displayHz: __probe.screen.getPrimaryDisplay().displayFrequency || 60,
    window: JSON.stringify(__probe.BrowserWindow.getAllWindows()[0]?.getBounds()),
  })`);

  const sendWorking = () =>
    main!.evaluate(`(() => {
      const at = Date.now();
      for (const window of __probe.BrowserWindow.getAllWindows())
        for (let i = 1; i <= ${seatCount}; i += 1) {
          const ward = Math.floor((i - 1) / 16) + 1;
          const within = (i - 1) % 16;
          const id = "zoom-seat-" + String(ward).padStart(2, "0") + "-" + String(Math.floor(within / 4)) + String(within % 4);
          window.webContents.send("junto:agent-seat-state-changed", {
            bindingId: "local:" + id, epoch: "zoom-sweep", state: "working",
            reason: "rule:osc_title_working", confidence: "high", at,
          });
        }
      return true;
    })()`);

  const metrics = async (): Promise<Record<string, number>> => {
    const { metrics: rows } = await page!.send("Performance.getMetrics");
    return Object.fromEntries((rows as Array<{ name: string; value: number }>).map((row) => [row.name, row.value]));
  };
  const processInfo = async (): Promise<Array<{ type: string; id: number; cpuTime: number }>> => {
    const { processInfo: rows } = await browser!.send("SystemInfo.getProcessInfo");
    return rows as Array<{ type: string; id: number; cpuTime: number }>;
  };
  const processCpu = async (): Promise<Record<string, number>> => {
    const byType: Record<string, number> = {};
    for (const row of await processInfo()) byType[row.type] = (byType[row.type] ?? 0) + row.cpuTime;
    return byType;
  };
  const pids = async () => {
    const rows = await processInfo();
    return {
      renderer: rows.filter((row) => row.type === "renderer").map((row) => row.id),
      gpu: rows.filter((row) => row.type === "GPU").map((row) => row.id),
    };
  };
  const gpuAccum = (wanted: { renderer: number[]; gpu: number[] }) => {
    const byPid = gpuTimeByPid();
    const sum = (list: number[]) => list.reduce((total, pid) => total + (byPid.get(pid) ?? 0), 0);
    return { rendererNs: sum(wanted.renderer), gpuNs: sum(wanted.gpu), known: [...byPid.keys()] };
  };
  const reactSnapshot = () => page!.evaluate<any>(`window.juntoPerf?.snapshot?.() ?? null`);
  const surfaceSnapshot = () => page!.evaluate<any>(`window.juntoSurfaceCommits?.() ?? null`);

  /** Install the page-side observers (tier flips, DOM churn, mark remounts) and the rAF frame loop. */
  const installVariant = () =>
    variant === "product"
      ? Promise.resolve()
      : page!.evaluate(`(() => {
          const variant = ${JSON.stringify(variant)};
          if (variant === "no-rest-scale") {
            const setProperty = CSSStyleDeclaration.prototype.setProperty;
            CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
              if (/^--(node-s|far-seat-scale|seat-floor-scale)(-was)?$/.test(name)) return;
              return setProperty.call(this, name, value, priority);
            };
            const setAttribute = Element.prototype.setAttribute;
            Element.prototype.setAttribute = function (name, value) {
              if (name === "data-seat-ease") return;
              return setAttribute.call(this, name, value);
            };
          }
          if (variant === "coarse-rest" || variant === "integer-rest") {
            const step = variant === "integer-rest" ? 1 : 0.5;
            // Approximates a product change: the ring scale only moves in
            // half-step increments, so a rest that lands inside the same step
            // writes nothing and no ease runs.
            const quantize = (value) => String(Math.max(1, Math.round(Number.parseFloat(String(value)) / step) * step));
            const setProperty = CSSStyleDeclaration.prototype.setProperty;
            CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
              if (/^--(node-s|far-seat-scale|seat-floor-scale)(-was)?$/.test(name)) {
                const stepped = quantize(value);
                if (this.getPropertyValue(name) === stepped) return;
                return setProperty.call(this, name, stepped, priority);
              }
              return setProperty.call(this, name, value, priority);
            };
          }
          if (variant === "static-visibility") {
        // Diagnostic: every mark reports visible once and never again, so the
        // per-frame data-mark-visible churn (and the :has() invalidation it
        // causes) is gone while the rings still draw and turn.
        return true;
      }
      if (variant === "no-tier-css") {
            document.documentElement.removeAttribute("data-canvas-tier");
            const setAttribute = Element.prototype.setAttribute;
            Element.prototype.setAttribute = function (name, value) {
              if (name === "data-canvas-tier") return;
              return setAttribute.call(this, name, value);
            };
          }
          return true;
        })()`);

  const arm = () => page!.evaluate(`(() => {
    const probe = (window.__zoomProbe = {
      tiers: [], added: 0, removed: 0, markRemounts: 0, easeFlips: 0, on: true,
    });
    const tierObserver = new MutationObserver((records) => {
      for (const record of records) probe.tiers.push(document.documentElement.getAttribute("data-canvas-tier"));
    });
    tierObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-canvas-tier"] });
    const viewport = document.querySelector(".react-flow__viewport");
    const churn = new MutationObserver((records) => {
      for (const record of records) {
        probe.added += record.addedNodes.length;
        probe.removed += record.removedNodes.length;
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.(".junto-mark__part") || node.querySelector?.(".junto-mark__part")) probe.markRemounts += 1;
        }
      }
    });
    if (viewport) churn.observe(viewport, { childList: true, subtree: true });
    const flow = document.querySelector(".react-flow");
    const ease = new MutationObserver(() => { probe.easeFlips += 1; });
    if (flow) ease.observe(flow, { attributes: true, attributeFilter: ["data-seat-ease"] });
    // Who touches the DOM during the sweep: attribute writes, inline custom
    // properties and stylesheet rewrites are the inputs to a style recalc.
    const writers = (probe.writers = {});
    const bump = (key) => { writers[key] = (writers[key] ?? 0) + 1; };
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) { bump("attr:" + name); return setAttribute.call(this, name, value); };
    const removeAttribute = Element.prototype.removeAttribute;
    Element.prototype.removeAttribute = function (name) { bump("attr-:" + name); return removeAttribute.call(this, name); };
    const setProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) { bump("style:" + name); return setProperty.call(this, name, value, priority); };
    const cssText = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, "cssText");
    if (cssText?.set) Object.defineProperty(CSSStyleDeclaration.prototype, "cssText", { ...cssText, set(value) { bump("cssText"); return cssText.set.call(this, value); } });
    const textContent = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
    if (textContent?.set) Object.defineProperty(Node.prototype, "textContent", { ...textContent, set(value) {
      if (this.nodeType === 1 && this.tagName === "STYLE") bump("style-node-text");
      return textContent.set.call(this, value);
    } });
    const frames = (window.__zoomFrames = { deltas: [], on: true });
    let last = performance.now();
    const tick = (now) => { frames.deltas.push(now - last); last = now; if (frames.on) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    probe.stop = () => {
      probe.on = false;
      Element.prototype.setAttribute = setAttribute;
      Element.prototype.removeAttribute = removeAttribute;
      CSSStyleDeclaration.prototype.setProperty = setProperty;
      tierObserver.disconnect();
      churn.disconnect();
      ease.disconnect();
      frames.on = false;
    };
    return { marks: document.querySelectorAll(".junto-mark").length, viewportNodes: viewport ? viewport.querySelectorAll(".react-flow__node").length : 0 };
  })()`);
  const readProbe = () => page!.evaluate<{
    tiers: (string | null)[];
    added: number;
    removed: number;
    markRemounts: number;
    easeFlips: number;
    deltas: number[];
    writers: Record<string, number>;
  }>(`(() => {
    const probe = window.__zoomProbe;
    probe.stop();
    return { tiers: probe.tiers, added: probe.added, removed: probe.removed, markRemounts: probe.markRemounts, easeFlips: probe.easeFlips, deltas: window.__zoomFrames.deltas, writers: probe.writers };
  })()`);

  const parkPointerOutside = async () => {
    await page!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: -10_000, y: -10_000, button: "none" });
    await sleep(300);
  };

  /**
   * Drive a zoom sweep between the two ends of the useful range, by milestone
   * rather than by wall clock: each phase zooms toward its end until the camera
   * gets there, holds, and reverses. So every build follows the same camera
   * trajectory and crosses the same tiers the same number of times; a build
   * that saturates its main thread simply takes longer, and that is a result,
   * not an artifact of a timer that fires late.
   *
   * The pointer stays far outside the window and the wheel events are
   * dispatched on the pane: no hit-test pass follows the moving camera
   * (PERF_LEDGER: HitTest is a pointer artifact, not a zoom cost). ctrl+wheel
   * is the trackpad pinch path d3 reads. One in-page interval paces the sweep
   * at the display rate.
   */
  const driveZoom = async (phases: number, options: { trace?: any[]; shots?: string } = {}) => {
    let traceDone: Promise<void> | undefined;
    if (options.trace) {
      browser!.on("Tracing.dataCollected", (params: { value: any[] }) => { options.trace!.push(...params.value); });
      traceDone = new Promise<void>((done) => browser!.on("Tracing.tracingComplete", () => done()));
      await browser!.send("Tracing.start", {
        traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline.frame", "disabled-by-default-devtools.timeline.invalidationTracking", "blink", "cc", "viz", "gpu", "benchmark", "toplevel"] },
        transferMode: "ReportEvents",
      } as never);
    }
    if (options.shots !== undefined) {
      mkdirSync(options.shots, { recursive: true });
      await page!.evaluate(`window.__zoomShotsEnabled = true`);
    }
    const startedAt = performance.now();
    // The driver reports through a window global: CDP's awaitPromise would be
    // collected across a long busy window, and polling keeps the page-side
    // script identical for both builds.
    await page!.evaluate(`(() => {
      const pane = document.querySelector(".react-flow__pane") || document.body;
      const cx = Math.round(innerWidth / 2), cy = Math.round(innerHeight / 2);
      const viewport = document.querySelector(".react-flow__viewport");
      const scaleNow = () => {
        const match = /scale\\(([-0-9.]+)\\)/.exec(viewport?.style.transform ?? "");
        return match ? Number(match[1]) : null;
      };
      const state = (window.__zoomDrive = { done: false, events: 0, scales: [], elapsedSeconds: 0 });
      window.__zoomShot = window.__zoomShotsEnabled ? (phase, scale) => { window.__zoomShotRequest = { phase, scale }; } : undefined;
      const perPhase = ${ZOOM_EVENTS_PER_PHASE}, stepMs = ${WHEEL_MS};
      // within: a 1.4% step stays inside one tier over ten events; cross: 18%.
      const delta = ${sweepArm === "within" ? "1" : String(ZOOM_DELTA)};
      (async () => {
        const started = performance.now();
        for (let phase = 0; phase < ${phases}; phase += 1) {
          // Even phases zoom in, odd phases out: the same trajectory every run.
          const direction = phase % 2 === 0 ? -1 : 1;
          for (let step = 0; step < perPhase; step += 1) {
            const scale = scaleNow();
            if (scale !== null) state.scales.push(scale);
            pane.dispatchEvent(new WheelEvent("wheel", {
              bubbles: true, cancelable: true, ctrlKey: true,
              clientX: cx, clientY: cy, deltaX: 0, deltaY: direction * delta,
            }));
            state.events += 1;
            await new Promise((wait) => setTimeout(wait, stepMs));
          }
          await new Promise((hold) => setTimeout(hold, ${ZOOM_HOLD_MS}));
          const scale = scaleNow();
          if (scale !== null) state.scales.push(scale);
          if (window.__zoomShot) window.__zoomShot(phase, scale);
        }
        state.elapsedSeconds = (performance.now() - started) / 1000;
        state.done = true;
      })();
      return true;
    })()`);
    const shotTaken = new Set<number>();
    const driven = await waitFor("the zoom sweep to finish", 120_000, async () => {
      if (options.shots !== undefined) {
        const request = await page!.evaluate<{ phase: number; scale: number | null } | null>(`window.__zoomShotRequest ?? null`);
        if (request !== null && !shotTaken.has(request.phase)) {
          shotTaken.add(request.phase);
          const png = await page!.send("Page.captureScreenshot", { format: "png" }) as { data: string };
          const name = `phase-${String(request.phase)}-${String(request.scale ?? 0).replace(".", "_")}.png`;
          writeFileSync(join(options.shots, name), Buffer.from(png.data, "base64"));
        }
      }
      const state = await page!.evaluate<{ done: boolean; events: number; elapsedSeconds: number; scales: number[] }>(
        `({ done: window.__zoomDrive.done, events: window.__zoomDrive.events, elapsedSeconds: window.__zoomDrive.elapsedSeconds, scales: window.__zoomDrive.scales })`,
      );
      return state.done ? state : undefined;
    });
    if (traceDone) {
      await browser!.send("Tracing.end");
      await traceDone;
    }
    const ordered = [...driven.scales].sort((a, b) => a - b);
    return {
      events: driven.events,
      elapsedSeconds: driven.elapsedSeconds,
      seconds: (performance.now() - startedAt) / 1000,
      eventsPerSecond: round1(driven.events / driven.elapsedSeconds),
      scales: { samples: driven.scales.length, min: ordered[0] ?? null, max: ordered.at(-1) ?? null, first: driven.scales[0] ?? null, last: driven.scales.at(-1) ?? null },
    };
  };

  /** Settle the camera at `target` zoom and capture the window (ring sharpness at a tier). */
  const captureAt = async (target: number, path: string) => {
    for (let step = 0; step < 240; step += 1) {
      const scale = await page!.evaluate<number | null>(`(() => {
        const match = /scale\\(([-0-9.]+)\\)/.exec(document.querySelector(".react-flow__viewport")?.style.transform ?? "");
        return match ? Number(match[1]) : null;
      })()`);
      if (scale !== null && Math.abs(scale - target) / target < 0.02) break;
      const direction = scale === null || scale > target ? 1 : -1;
      await page!.evaluate(`(() => {
        const pane = document.querySelector(".react-flow__pane") || document.body;
        pane.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true, cancelable: true, ctrlKey: true,
          clientX: Math.round(innerWidth / 2), clientY: Math.round(innerHeight / 2),
          deltaX: 0, deltaY: ${String(direction)} * 2,
        }));
      })()`);
      await sleep(40);
    }
    await sleep(600);
    const png = await page!.send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(path, Buffer.from(png.data, "base64"));
  };

  /** Zoom once, clean, then zoom once more under a trace so the costs can be named. */
  const measureZoom = async () => {
    await sendWorking();
    await parkPointerOutside();
    await sleep(500);
    await installVariant();
    const armed = await arm() as { marks: number; viewportNodes: number };
    const reactBefore = await reactSnapshot();
    const surfacesBefore = await surfaceSnapshot();
    const pidsBefore = await pids();
    const gpuBefore = gpuAccum(pidsBefore);
    const metricsBefore = await metrics();
    const cpuBefore = await processCpu();
    const loadBefore = loadavg()[0]!;
    const clean = await driveZoom(4, shotsDir === "" ? {} : { shots: shotsDir });
    if (shotZooms.length > 0) {
      const dir = shotsDir === "" ? join(sandbox.root, "shots") : shotsDir;
      mkdirSync(dir, { recursive: true });
      for (const zoom of shotZooms) await captureAt(zoom, join(dir, `at-${String(zoom).replace(".", "_")}.png`));
    }
    const metricsAfter = await metrics();
    const cpuAfter = await processCpu();
    const gpuAfter = gpuAccum(pidsBefore);
    const reactAfter = await reactSnapshot();
    const surfacesAfter = await surfaceSnapshot();
    const probed = await readProbe();
    const problems: string[] = [];
    const visible = await page!.evaluate<string>(`document.visibilityState`);
    if (visible !== "visible") problems.push(`window not visible (${visible}): an occluded window gives 0 frames`);
    const theme = await page!.evaluate<{ dark: boolean; background: string }>(`(() => {
      const background = getComputedStyle(document.body).backgroundColor;
      const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return { dark: r + g + b < 300, background };
    })()`);
    if (!theme.dark) problems.push(`not the dark theme (body ${theme.background})`);
    if (probed.deltas.length === 0) problems.push("0 frames: the window did not paint");
    if (!clean.scales.min || !clean.scales.max || clean.scales.max - clean.scales.min < 0.4) {
      problems.push(`the sweep never moved the camera (scales ${String(clean.scales.min)} to ${String(clean.scales.max)})`);
    }
    const tiersSeen = [...new Set(probed.tiers.filter((tier): tier is string => typeof tier === "string"))];
    const missing = ["near", "mid", "far", "overview"].filter((tier) => !tiersSeen.includes(tier));
    if (missing.length > 0) problems.push(`the sweep did not reach ${missing.join(", ")} (saw ${tiersSeen.join(", ") || "none"})`);
    const accessibility = await main!.evaluate<boolean>(`__probe.app.accessibilitySupportEnabled`);
    if (accessibility && !forceAxOff) problems.push("accessibility tree is on: it re-serializes the moving camera (PERF_LEDGER F2); pass it as found or force it off");

    const deltas = probed.deltas.slice(1).sort((a, b) => a - b);
    const at = (q: number) => round1(deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * q))]!);
    const interval = 1000 / environment.displayHz;
    const frameMs = deltas.length === 0 ? null : {
      source: "page requestAnimationFrame deltas (main-thread frames)",
      displayHz: environment.displayHz,
      p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round1(deltas.at(-1)!),
      droppedAtDisplayRate: deltas.reduce((sum, d) => (d > interval * 1.5 ? sum + Math.round(d / interval) - 1 : sum), 0),
    };
    const perSecond = (key: string) =>
      metricsAfter[key] !== undefined && metricsBefore[key] !== undefined
        ? round1(((metricsAfter[key]! - metricsBefore[key]!) / clean.elapsedSeconds) * 1000)
        : null;
    const reactDelta = (before: any, after: any, key: string) =>
      before?.[key] !== undefined && after?.[key] !== undefined ? after[key] - before[key] : null;
    const surfaces: Record<string, number> = {};
    for (const [id, entry] of Object.entries((surfacesAfter ?? {}) as Record<string, { commits?: number }>)) {
      const prior = (surfacesBefore as any)?.[id]?.commits ?? 0;
      const now = (entry as any).commits ?? 0;
      if (now - prior !== 0) surfaces[id] = now - prior;
    }

    // The traced sweep: same drive, shorter, so the trace can name the costs;
    // sampled JS on top of it names the functions that hold the main thread.
    const traceEvents: any[] = [];
    const gpuTracedBefore = gpuAccum(pidsBefore);
    const tracedStart = performance.now();
    await page!.send("Profiler.enable");
    await page!.send("Profiler.setSamplingInterval", { interval: 200 });
    await page!.send("Profiler.start");
    const traced = await driveZoom(2, { trace: traceEvents });
    const profiled = await page!.send("Profiler.stop");
    await page!.send("Profiler.disable");
    const tracedSeconds = (performance.now() - tracedStart) / 1000;
    const gpuTracedAfter = gpuAccum(pidsBefore);
    const pidInfo = await pids();
    const trace = summarizeTrace(traceEvents, pidInfo.renderer[0] ?? -1, pidInfo.gpu[0] ?? -1);
    const gpuAccumMs = (after: { rendererNs: number; gpuNs: number }, before: { rendererNs: number; gpuNs: number }) => ({
      rendererMs: Math.round((after.rendererNs - before.rendererNs) / 1e6 * 10) / 10,
      gpuMs: Math.round((after.gpuNs - before.gpuNs) / 1e6 * 10) / 10,
    });
    const cleanGpu = gpuAccumMs(gpuAfter, gpuBefore);
    const tracedGpu = gpuAccumMs(gpuTracedAfter, gpuTracedBefore);

    return {
      valid: problems.length === 0,
      problems,
      seconds: round1(tracedSeconds),
      clean: { ...clean, gpuAccumMs: cleanGpu, gpuPids: pidsBefore },
      events: {
        tierFlips: probed.tiers.length,
        tiersSeen,
        markers: armed.marks,
        viewportNodes: armed.viewportNodes,
        domAdded: probed.added,
        domRemoved: probed.removed,
        markRemounts: probed.markRemounts,
        easeFlips: probed.easeFlips,
        writers: Object.fromEntries(Object.entries(probed.writers).sort((a, b) => b[1] - a[1]).slice(0, 16)),
      },
      ...(() => {
        // Per-second figures over the clean window, written after it closes.
        const secondsClean = clean.elapsedSeconds;
        const rate = (value: number | null) => (value === null ? null : round1(value / (secondsClean || 1)));
        const reactCommits = (reactDelta(reactBefore, reactAfter, "reactRootCommits") ?? 0) + (reactDelta(reactBefore, reactAfter, "reactCanvasCommits") ?? 0);
        return {
          rendererBusyMsPerSecond: perSecond("TaskDuration"),
          scriptMsPerSecond: perSecond("ScriptDuration"),
          layoutMsPerSecond: perSecond("LayoutDuration"),
          styleMsPerSecond: perSecond("RecalcStyleDuration"),
          reactCommitsPerSecond: rate(reactCommits),
          reactCommitMsPerSecond: rate((reactDelta(reactBefore, reactAfter, "reactCommitDurationMs") ?? 0)),
          domAddedPerSecond: rate(probed.added),
          partsAddedPerSecond: rate(probed.markRemounts),
          gpuAccumMsPerSecond: rate(cleanGpu.gpuMs + cleanGpu.rendererMs),
          frameMs,
          cpuPercent: Object.fromEntries(Object.keys(cpuAfter).map((type) => [type, round1(((cpuAfter[type]! - (cpuBefore[type] ?? 0)) / (secondsClean || 1)) * 100)])),
          react: {
            rootCommits: reactDelta(reactBefore, reactAfter, "reactRootCommits"),
            canvasCommits: reactDelta(reactBefore, reactAfter, "reactCanvasCommits"),
            commitMs: reactDelta(reactBefore, reactAfter, "reactCommitDurationMs"),
            activityMounts: reactDelta(reactBefore, reactAfter, "activityMarkMounts"),
            activityUnmounts: reactDelta(reactBefore, reactAfter, "activityMarkUnmounts"),
            surfaces,
          },
          gpuAccumMs: cleanGpu,
          trace,
          profileTop: summarizeProfile(profiled?.profile),
          tracedSeconds: round1(tracedSeconds),
          tracedGpuAccumMs: tracedGpu,
          tracedScales: traced.scales,
          loadAverage1m: { before: Math.round(loadBefore * 100) / 100, after: Math.round(loadavg()[0]! * 100) / 100 },
        };
      })(),
    };
  };

  const zoom = await measureZoom();

  const report = {
    label,
    sourceCommit,
    repoHead,
    repoDirty,
    appRoot,
    command: `bun scripts/probe-zoom-sweep.ts --app-root ${appRoot} --label ${label} --seconds ${seconds} --port ${port} --fixture ${fixtureName}`,
    when: new Date().toISOString(),
    environment: { ...environment, rendererAccessibilityForcedOff: forceAxOff },
    arm: sweepArm,
    variant,
    ...(variant === "product" ? {} : { diagnostic: { kind: variant, comparableToProduct: false } }),
    fixture: { name: fixtureName, seats: seatCount, regions: regions.length, notes: notes.length, wires: wires.length, nodes: fixtureRows.length },
    valid: zoom.valid,
    zoom,
    events: zoom.events,
    trace: zoom.trace,
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (outPath !== "") writeFileSync(outPath, json);
  console.log(
    `zoom ${label} ${sourceCommit?.slice(0, 9) ?? "?"} ` +
      `busy ${String(zoom.rendererBusyMsPerSecond)} ms/s, style ${String(zoom.styleMsPerSecond)}, layout ${String(zoom.layoutMsPerSecond)}, ` +
      `script ${String(zoom.scriptMsPerSecond)}, react ${String(zoom.reactCommitsPerSecond)} commits/s, gpu ${String(zoom.gpuAccumMsPerSecond)} ms/s, ` +
      `frame p50/p95/p99/max ${String(zoom.frameMs?.p50)}/${String(zoom.frameMs?.p95)}/${String(zoom.frameMs?.p99)}/${String(zoom.frameMs?.max)} ms, dropped ${String(zoom.frameMs?.droppedAtDisplayRate)}, ` +
      `remounts ${String(zoom.events.markRemounts)}, tier flips ${String(zoom.events.tierFlips)}` +
      (report.valid ? "" : ` | INVALID: ${zoom.problems.join("; ")}`),
  );
  await teardown();
  process.exit(report.valid ? 0 : 2);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await teardown().catch(() => undefined);
  process.exit(1);
}
