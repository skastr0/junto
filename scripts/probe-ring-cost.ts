/**
 * What the activity rings cost. One repeatable command, run on a build before
 * and after a ring change, so the two result sets compare.
 *
 *   bun scripts/probe-ring-cost.ts --app-root DIR [--label L] [--seconds 6]
 *     [--port 9341] [--hold 0] [--out FILE] [--force-ax-off]
 *   bun scripts/probe-ring-cost.ts --compare before=DIR,after=DIR
 *     [--repeats 3] [--out FILE]      (interleaved: before, after, before, ...)
 *
 * DIR is a checkout whose `out/` is a PRODUCTION build (electron-vite build,
 * not `bun run dev`: React dev and StrictMode skew every number). The script
 * runs from any checkout; it never builds and never touches ~/.junto.
 *
 * Each run boots the app on a throwaway HOME and JUNTO_HOME (short /tmp path,
 * see sandbox.ts) with JUNTO_PERF=1, --remote-debugging-port=PORT and a
 * main-process --inspect port, dark theme, first-run tour marked seen,
 * accessibility as found. The canvas is one fixed fixture (FIXTURE below):
 * loose seats, seats in regions, seats in regions nested four deep, large
 * regions with many seats and small ones with one or two. Every seat is
 * injected as "working", so its ring moves. Three scenarios of --seconds:
 *   idle    nothing touches the canvas; no page script runs
 *   pan     wheel events every 16 ms sweeping across the nested regions
 *   stream  a shell terminal receives a fixed rate of output (LINES_PER_TICK
 *           lines every TICK_MS), so every build processes the same bytes
 * Per scenario: renderer main-thread busy ms per second (Blink task time),
 * script / layout / style ms per second, GPU / browser / renderer process CPU
 * %, the rings on screen and the load average. Pan alone also counts rAF
 * frames and dropped frames: a page rAF loop forces a main frame every vsync
 * and would hide what compositor-only rings save in idle and stream.
 *
 * Invalid runs are reported, never repaired (PERF_LEDGER.md): an occluded
 * window gives 0 frames, a dialog over the canvas blurs it, a light theme or
 * fewer than MIN_RINGS moving rings is not the fixture. Any of these marks the
 * scenario `valid: false` and the run exits 2.
 *

 * --hide-ring-parts is a probe-only diagnostic: it hides .junto-mark__part so
 * the layer cost of the rings shows. Its JSON carries diagnostic.comparable
 * ToProduct=false; it is never a product option (motion law).
 *
 * --hold N keeps the app up N seconds after the scenarios so another capture
 * (a Chrome trace, screenshots) can attach to the same instance on PORT.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createSandbox, destroySandbox, writeFixtureModel } from "../e2e/harness/sandbox";
import { modelFixture, modelRegion, modelSeat, modelTerminal } from "../e2e/harness/model";
import { startRendererServer } from "../e2e/harness/renderer-server";

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const round1 = (value: number) => Math.round(value * 10) / 10;
const medianOf = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return round1(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
};

// Interleaved repeats: before, after, before, after, ... one app at a time, so
// load drift hits both builds alike. Each run is this same script in a child.
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
      const scratch = mkdtempSync(join(tmpdir(), "ring-cost-run-"));
      const file = join(scratch, "run.json");
      const child = spawnSync(
        process.execPath,
        [import.meta.path, "--app-root", build.root, "--label", `${build.name}-${repeat}`, "--out", file, "--seconds", arg("seconds", "6"), "--port", arg("port", "9341"), "--fixture", arg("fixture", "small"), "--scenarios", arg("scenarios", "idle,pan-outside,pan-hover,stream"), ...(process.argv.includes("--hide-ring-parts") ? ["--hide-ring-parts"] : [])],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      const report = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
      rmSync(scratch, { recursive: true, force: true });
      runs.push({ build: build.name, repeat, exit: child.status ?? -1, report });
      console.error(`ring cost: ${build.name} #${repeat} exit ${child.status}`);
      // Never two apps at once: wait for this build's Electron to be gone.
      for (let wait = 0; wait < 40 && spawnSync("pgrep", ["-f", `${build.root}/node_modules/electron/dist`]).status === 0; wait += 1) await sleep(500);
      await sleep(3_000);
    }
  }
  const metricKeys = ["rendererBusyMsPerSecond", "scriptMsPerSecond", "layoutMsPerSecond", "styleMsPerSecond", "rafDropped", "rafFrames", "bytesWritten"] as const;
  const frameKeys = ["p50", "p95", "p99", "max", "over8_3", "over16_7", "droppedAtDisplayRate"] as const;
  const summary = builds.map((build) => ({
    build: build.name,
    sourceCommit: runs.find((run) => run.build === build.name && run.report)?.report.sourceCommit ?? null,
    scenarios: arg("scenarios", "idle,pan-outside,pan-hover,stream").split(",").map((scenario) => {
      const rows = runs
        .filter((run) => run.build === build.name)
        .flatMap((run) => (run.report?.scenarios ?? []).filter((row: any) => row.name === scenario).map((row: any) => ({ ...row, repeat: run.repeat })));
      const valid = rows.filter((row: any) => row.valid);
      const med = (read: (row: any) => number | null | undefined) =>
        medianOf(valid.map(read).filter((value: any): value is number => typeof value === "number"));
      return {
        scenario,
        runs: rows.length,
        validRuns: valid.length,
        median: {
          ...(Object.fromEntries(metricKeys.map((key) => [key, med((row) => row[key])])) as Record<(typeof metricKeys)[number], number | null>),
          ...(Object.fromEntries(frameKeys.map((key) => [`frame_${key}`, med((row) => row.frameMs?.[key])])) as Record<string, number | null>),
          loafMaxMs: med((row) => row.longAnimationFrames?.maxMs),
          layers: med((row) => row.layers?.count),
          layerizeMsPerUpdate: med((row) => row.layers?.layerizeMsPerUpdate),
          layerizeMsPerSecond: med((row) => row.layers?.layerizeMsPerSecond),
          gpuCpuPercent: med((row) => row.cpuPercent?.GPU),
          rendererCpuPercent: med((row) => row.cpuPercent?.renderer),
          browserCpuPercent: med((row) => row.cpuPercent?.browser),
          movingRings: med((row) => row.ringsVisible?.moving),
        },
        values: Object.fromEntries(
          [...metricKeys, "gpu"].map((key) => [
            key,
            rows.map((row: any) => (key === "gpu" ? row.cpuPercent?.GPU : row[key]) ?? null),
          ]),
        ),
        problems: rows.flatMap((row: any) => row.problems.map((problem: string) => `#${row.repeat}: ${problem}`)),
      };
    }),
  }));
  const out = {
    command: `bun scripts/probe-ring-cost.ts --compare ${compareArg} --repeats ${repeats}`,
    when: new Date().toISOString(),
    order: runs.map((run) => `${run.build}#${run.repeat}`),
    summary,
    runs: runs.map((run) => run.report),
  };
  const json = JSON.stringify(out, null, 2);
  if (compareOut !== "") writeFileSync(compareOut, json);
  console.log(json);
  for (const entry of summary) {
    console.log(
      `${entry.build} ${entry.sourceCommit?.slice(0, 9) ?? "?"} ` +
        entry.scenarios.map((row) => `${row.scenario}: busy ${row.median.rendererBusyMsPerSecond} ms/s, gpu ${row.median.gpuCpuPercent}%, renderer ${row.median.rendererCpuPercent}%, valid ${row.validRuns}/${row.runs}`).join(" | "),
    );
  }
  process.exit(0);
}

const appRoot = resolve(arg("app-root", ""));
const label = arg("label", "run");
const seconds = Number(arg("seconds", "6"));
const port = Number(arg("port", "9341"));
const holdSeconds = Number(arg("hold", "0"));
const outPath = arg("out", "");
const forceAxOff = process.argv.includes("--force-ax-off");
/** Diagnostic only: hide the ring parts to see what they cost in layers. Never a product option. */
const hideRingParts = process.argv.includes("--hide-ring-parts");
const CANVAS = "ring-cost";
/** The stream scenario: this many lines every TICK_MS for the whole window. */
const LINES_PER_TICK = 20;
const TICK_MS = 16;
const MIN_RINGS = 30;
const traceBase = arg("trace", "");
const WHEEL_MS = 1000 / 120;
/** small: the 29-seat fixture; large: four copies of its units, 101 seats. */
const fixtureName = arg("fixture", "small");
if (fixtureName !== "small" && fixtureName !== "large") {
  console.error("ring cost: --fixture is small or large");
  process.exit(64);
}
const SCENARIOS = ["idle", "pan-outside", "pan-hover", "stream"] as const;
const wantedScenarios = arg("scenarios", SCENARIOS.join(",")).split(",");
for (const name of wantedScenarios) {
  if (!(SCENARIOS as readonly string[]).includes(name)) {
    console.error(`ring cost: unknown scenario ${name}; choose from ${SCENARIOS.join(", ")}`);
    process.exit(64);
  }
}

if (arg("app-root", "") === "") {
  console.error("usage: bun scripts/probe-ring-cost.ts --app-root DIR [--label L] [--seconds S] [--port P] [--hold S] [--out FILE]\n       bun scripts/probe-ring-cost.ts --compare before=DIR,after=DIR [--repeats 3] [--out FILE]");
  process.exit(64);
}
for (const path of ["out/main/index.js", "out/renderer/index.html"]) {
  if (!existsSync(join(appRoot, path))) {
    console.error(`ring cost: ${join(appRoot, path)} is missing; build ${appRoot} first (electron-vite build)`);
    process.exit(64);
  }
}
if (!existsSync(join(appRoot, "node_modules/electron/package.json"))) {
  // createRequire would otherwise auto-install some other Electron from the bun cache.
  console.error(`ring cost: ${appRoot}/node_modules/electron is missing; install the checkout's dependencies first`);
  process.exit(64);
}
const provenancePath = join(appRoot, "out/package-runtime-provenance.json");
const sourceCommit: string | null = existsSync(provenancePath)
  ? (JSON.parse(readFileSync(provenancePath, "utf8")).sourceCommit ?? null)
  : null;

// The fixture. Boxes are world coordinates; a seat is 240x96. A seat or region
// belongs to a region when it lies fully inside its rect (shared/graph.ts
// regionStack), so each region lists only the seats it holds directly and
// nests the rest. Same fixture for every build; nothing here is random.
type Spot = readonly [number, number];
type RegionSpec = {
  readonly id: string;
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly seats: ReadonlyArray<Spot>;
  readonly children?: ReadonlyArray<RegionSpec>;
};
const SEAT_W = 240;
const SEAT_H = 96;
const LOOSE: ReadonlyArray<Spot> = [0, 1, 2, 3, 4].map((i): Spot => [340 + i * 260, 40]);
const UNIT: ReadonlyArray<RegionSpec> = [
  {
    id: "big",
    box: { x: 20, y: 180, w: 1040, h: 820 },
    seats: [0, 1, 2, 3, 4, 5].map((i): Spot => [50 + (i % 3) * 260, 230 + Math.floor(i / 3) * 130]),
    children: [
      {
        id: "big-a",
        box: { x: 50, y: 480, w: 600, h: 500 },
        seats: [[70, 530], [330, 530], [70, 660], [330, 660]],
        children: [
          {
            id: "big-a-1",
            box: { x: 70, y: 790, w: 560, h: 170 },
            seats: [[80, 830]],
            children: [{ id: "big-a-1-a", box: { x: 340, y: 810, w: 270, h: 140 }, seats: [[355, 840]] }],
          },
        ],
      },
      {
        id: "big-b",
        box: { x: 680, y: 480, w: 360, h: 500 },
        seats: [[700, 530], [700, 660]],
        children: [{ id: "big-b-1", box: { x: 700, y: 790, w: 320, h: 170 }, seats: [[720, 830]] }],
      },
    ],
  },
  {
    id: "mid",
    box: { x: 1100, y: 180, w: 640, h: 500 },
    seats: [0, 1, 2, 3].map((i): Spot => [1120 + (i % 2) * 260, 230 + Math.floor(i / 2) * 130]),
    children: [
      { id: "mid-a", box: { x: 1120, y: 480, w: 300, h: 180 }, seats: [[1140, 520]] },
      { id: "mid-b", box: { x: 1440, y: 480, w: 280, h: 180 }, seats: [[1450, 520]] },
    ],
  },
  { id: "small-one", box: { x: 1100, y: 720, w: 300, h: 150 }, seats: [[1115, 750]] },
  { id: "small-two", box: { x: 1430, y: 720, w: 310, h: 300 }, seats: [[1445, 750], [1445, 880]] },
];
// The large fixture tiles the unit above 2 x 2 (1800 across, 900 down), each
// copy with its own ids; the loose seats stay once, along the top.
const shifted = (region: RegionSpec, dx: number, dy: number, tag: string): RegionSpec => ({
  id: `${tag}${region.id}`,
  box: { ...region.box, x: region.box.x + dx, y: region.box.y + dy },
  seats: region.seats.map(([x, y]): Spot => [x + dx, y + dy]),
  ...(region.children ? { children: region.children.map((child) => shifted(child, dx, dy, tag)) } : {}),
});
const TREE: ReadonlyArray<RegionSpec> =
  fixtureName === "small"
    ? UNIT
    : [0, 1].flatMap((row) => [0, 1].flatMap((col) => UNIT.map((region) => shifted(region, col * 1800, row * 900, `u${row}${col}-`))));
type Placed = { id: string; regionId: string | null; depth: number; spot: Spot };
const regionRows: Array<{ id: string; parent: string | null; depth: number; seatsDirect: number; seatsInside: number; box: RegionSpec["box"] }> = [];
const placed: Placed[] = LOOSE.map((spot, i) => ({ id: "", regionId: null, depth: 0, spot }));
const inside = (outer: RegionSpec["box"], x: number, y: number, w: number, h: number) =>
  x >= outer.x && y >= outer.y && x + w <= outer.x + outer.w && y + h <= outer.y + outer.h;
const walk = (region: RegionSpec, parent: RegionSpec | null, depth: number): number => {
  if (parent && !inside(parent.box, region.box.x, region.box.y, region.box.w, region.box.h)) throw new Error(`fixture: region ${region.id} is not inside ${parent.id}`);
  for (const [x, y] of region.seats) {
    if (!inside(region.box, x, y, SEAT_W, SEAT_H)) throw new Error(`fixture: seat at ${x},${y} is not inside ${region.id}`);
    placed.push({ id: "", regionId: region.id, depth, spot: [x, y] });
  }
  const row = { id: region.id, parent: parent?.id ?? null, depth, seatsDirect: region.seats.length, seatsInside: region.seats.length, box: region.box };
  regionRows.push(row);
  for (const child of region.children ?? []) row.seatsInside += walk(child, region, depth + 1);
  return row.seatsInside;
};
for (const region of TREE) walk(region, null, 1);
placed.forEach((seat, i) => { seat.id = `ring-seat-${String(i + 1).padStart(2, "0")}`; });
const seatCount = placed.length;
const maxDepth = Math.max(...regionRows.map((row) => row.depth));
if (maxDepth < 3) throw new Error("fixture: nesting is shallower than 3 levels");
const fixtureSummary = {
  name: fixtureName,
  seats: seatCount,
  looseSeats: LOOSE.length,
  regions: regionRows.length,
  maxNestingDepth: maxDepth,
  regionTable: regionRows.map((row) => ({ id: row.id, parent: row.parent, depth: row.depth, seatsDirect: row.seatsDirect, seatsInside: row.seatsInside, size: `${row.box.w}x${row.box.h}` })),
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Target = { type: string; title?: string; url: string; webSocketDebuggerUrl: string };

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

const waitFor = async <T>(what: string, ms: number, probe: () => Promise<T | undefined | false>): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const found = await probe().catch(() => undefined);
    if (found) return found;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
};

// The Electron main process loads this before the product: it only hands the
// electron module to the inspector, so seat events can be sent to the window.
const HOOK = `globalThis.__probe = require("electron");\n`;

const sandbox = await createSandbox();
const fifo = join(sandbox.root, "stream.fifo");
if (spawnSync("mkfifo", [fifo]).status !== 0) throw new Error("mkfifo failed");
writeFileSync(join(sandbox.root, "probe-hook.cjs"), HOOK);

const regions = (() => {
  const rows: ReturnType<typeof modelRegion>[] = [];
  const add = (region: RegionSpec) => {
    rows.push(modelRegion({ id: `ring-region-${region.id}`, label: region.id, x: region.box.x, y: region.box.y, width: region.box.w, height: region.box.h, hold: false }));
    for (const child of region.children ?? []) add(child);
  };
  for (const region of TREE) add(region);
  return rows;
})();
const seats = placed.map((seat) => modelSeat({ id: seat.id, x: seat.spot[0], y: seat.spot[1] }));
// The terminal only reads the fifo; the probe writes it at a fixed rate.
const stream = modelTerminal({
  id: "ring-stream",
  bindingId: "local:ring-stream",
  label: "stream",
  x: 40,
  y: 40,
  launch: { kind: "command", argv: ["/bin/sh", "-c", `exec cat "${fifo}"`] },
});
// Regions first so they paint underneath the seats they hold.
await writeFixtureModel(sandbox, CANVAS, modelFixture([...regions, ...seats, stream]));

const server = await startRendererServer(join(appRoot, "out/renderer"));
const electronBinary = createRequire(join(appRoot, "package.json"))("electron") as string;
const inherited = { ...(process.env as Record<string, string>) };
for (const name of ["JUNTO_HOME", "JUNTO_WORK_HOME", "JUNTO_WORK_SOCKET", "JUNTO_SOCKET", "JUNTO_NODE_REF", "JUNTO_SEAT", "JUNTO_TOKEN", "JUNTO_WORK_TOKEN"]) {
  delete inherited[name];
}
const inspectPort = port + 1;
const child: ChildProcess = spawn(
  electronBinary,
  [
    "-r", join(sandbox.root, "probe-hook.cjs"),
    appRoot,
    `--user-data-dir=${sandbox.userDataDir}`,
    `--remote-debugging-port=${port}`,
    `--inspect=${inspectPort}`,
    "--mute-audio",
    // Accessibility is measured as found by default: once an assistive client
    // has asked, the OS keeps the tree on and the app cannot switch it off,
    // and that is how the operator runs. --force-ax-off turns the renderer
    // side off for a clean A/B; either way it is recorded in the report.
    ...(forceAxOff ? ["--disable-renderer-accessibility"] : []),
    // Keep a window behind other windows painting (PERF_LEDGER.md); the
    // visibility check below still refuses a hidden page.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
  {
    stdio: "ignore",
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
  await destroySandbox(sandbox);
};

type Scenario = {
  name: string;
  valid: boolean;
  problems: string[];
  seconds: number;
  rendererBusyMsPerSecond: number | null;
  scriptMsPerSecond: number | null;
  layoutMsPerSecond: number | null;
  styleMsPerSecond: number | null;
  /** Pan only: a page rAF loop would force frames in the other scenarios. */
  rafFrames: number | null;
  rafDropped: number | null;
  /** Pan: frame-time distribution from page rAF deltas, dropped at the display rate. */
  frameMs: { source: string; displayHz: number; p50: number; p95: number; p99: number; max: number; over8_3: number; over16_7: number; droppedAtDisplayRate: number } | null;
  longAnimationFrames: { count: number; maxMs: number; totalMs: number } | null;
  bytesWritten: number | null;
  cpuPercent: Record<string, number>;
  ringsVisible: { moving: number; marks: number };
  loadAverage1m: { before: number; after: number };
  accessibilityOn: boolean;
  viewport: string[] | null;
  pointer: string | null;
  /**
   * Compositor layers after the scenario (LayerTree.layerTreeDidChange), and for
   * pan the cost of building them: PaintArtifactCompositor::Update time in a
   * separate traced sample pan after the measured window, so the trace never
   * perturbs the measured numbers.
   */
  layers: {
    count: number | null;
    countSource: string;
    layerizeUpdates: number | null;
    layerizeMsPerUpdate: number | null;
    layerizeMsPerSecond: number | null;
    sampleSeconds: number | null;
    traceSource: string | null;
  } | null;
  wheel: { mode: string; events: number; eventsPerSecond: number; ackLagMs: { p50: number; max: number } | null; tracePath: string | null } | null;
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child.kill("SIGKILL");
    process.exit(130);
  });
}

try {
  // The inspector port and the debugging port come up after the window.
  const pageTarget = await waitFor("the renderer page", 90_000, async () =>
    (await listTargets(port)).find((t) => t.type === "page" && t.url.startsWith(server.url)),
  );
  const mainTarget = await waitFor("the main inspector", 30_000, async () => (await listTargets(inspectPort))[0]);
  page = await connect(pageTarget.webSocketDebuggerUrl);
  main = await connect(mainTarget.webSocketDebuggerUrl);
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  browser = await connect(version.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Performance.enable");

  // The first-run tour blurs the canvas behind it: mark it seen the way the
  // introduction itself does, through the settings IPC.
  await waitFor("the settings bridge", 30_000, () => page!.evaluate<boolean>(`Boolean(window.junto?.settingsPatch)`));
  await page.evaluate(`window.junto.settingsPatch({ advanced: { onboardingSeen: true }, appearance: { theme: "dark" } })`);

  await waitFor("the seat cards", 60_000, async () =>
    (await page!.evaluate<number>(`document.querySelectorAll('.react-flow__node[data-id^="ring-seat-"]').length`)) >= seatCount,
  );
  await page.evaluate(`document.querySelector(".react-flow__controls-fitview")?.click()`);

  const sendWorking = () =>
    main!.evaluate(`(() => {
      const at = Date.now();
      for (const window of __probe.BrowserWindow.getAllWindows())
        for (let i = 1; i <= ${seatCount}; i += 1) {
          const id = "ring-seat-" + String(i).padStart(2, "0");
          window.webContents.send("junto:agent-seat-state-changed", {
            bindingId: "local:" + id, epoch: "ring-cost", state: "working",
            reason: "rule:osc_title_working", confidence: "high", at,
          });
        }
      return true;
    })()`);
  // The rings start the moment the seats turn "working". Trace that moment,
  // so a launch where the animations are not composited shows up in the run.
  const animationEvents: Array<any> = [];
  browser.on("Tracing.dataCollected", (params: { value: Array<any> }) => {
    for (const event of params.value) if (event.name === "Animation") animationEvents.push(event);
  });
  const traceDone = new Promise<void>((done) => browser!.on("Tracing.tracingComplete", () => done()));
  await browser.send("Tracing.start", {
    traceConfig: { includedCategories: ["devtools.timeline", "blink.animations", "benchmark", "rail"] },
    transferMode: "ReportEvents",
  } as never);
  await sendWorking();
  await sleep(2_000);
  await browser.send("Tracing.end");
  await traceDone;
  const animations = await page.evaluate<{
    total: number;
    onMarkParts: number;
    states: Record<string, number>;
    properties: string[];
    nonCompositorProperties: string[];
  }>(`(() => {
    const all = document.getAnimations();
    const parts = all.filter((a) => a.effect?.target?.matches?.(".junto-mark__part, .junto-mark__part *"));
    const states = {};
    const props = new Set();
    for (const a of parts) {
      states[a.playState] = (states[a.playState] ?? 0) + 1;
      for (const k of a.effect.getKeyframes()) for (const name of Object.keys(k)) if (!["offset", "easing", "composite", "computedOffset"].includes(name)) props.add(name);
    }
    const compositor = new Set(["transform", "opacity", "translate", "rotate", "scale", "filter", "backdropFilter"]);
    return { total: all.length, onMarkParts: parts.length, states, properties: [...props], nonCompositorProperties: [...props].filter((name) => !compositor.has(name)) };
  })()`);
  const traced = animationEvents.map((event) => event.args?.data ?? {});
  const animationReport = {
    ...animations,
    trace: {
      source: "Tracing categories devtools.timeline,blink.animations: 'Animation' events from the moment the seats turn working",
      events: traced.length,
      compositeFailed: traced.filter((data) => Number(data.compositeFailed ?? 0) !== 0).length,
      compositeFailedValues: [...new Set(traced.map((data) => data.compositeFailed).filter((value) => value !== undefined))],
      unsupportedProperties: [...new Set(traced.flatMap((data) => (Array.isArray(data.unsupportedProperties) ? data.unsupportedProperties : [])))],
      // Who failed to composite: the rings, or something else (group chips, portraits).
      ringEvents: traced.filter((data) => String(data.nodeName ?? "").includes("junto-mark")).length,
      ringCompositeFailed: traced.filter((data) => String(data.nodeName ?? "").includes("junto-mark") && Number(data.compositeFailed ?? 0) !== 0).length,
      compositeFailedNodes: [...new Set(traced.filter((data) => Number(data.compositeFailed ?? 0) !== 0).map((data) => String(data.nodeName ?? "").slice(0, 60)))].slice(0, 6),
      sample: traced.slice(0, 3),
    },
    note:
      animations.onMarkParts === 0
        ? "no CSS animations on .junto-mark__part: rings are painted by script"
        : animations.nonCompositorProperties.length > 0
          ? "ring animations touch non-compositor properties"
          : "ring animations use compositor properties only",
  };

  const environment = await main.evaluate<{ accessibility: boolean; electron: string; chrome: string; displays: number; darkOs: boolean; displayHz: number }>(`({
    accessibility: __probe.app.accessibilitySupportEnabled,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    displays: __probe.screen.getAllDisplays().length,
    darkOs: __probe.nativeTheme.shouldUseDarkColors,
    displayHz: __probe.screen.getPrimaryDisplay().displayFrequency || 60,
  })`);
  const checks = async (): Promise<string[]> => {
    const problems: string[] = [];
    const visible = await page!.evaluate<string>(`document.visibilityState`);
    if (visible !== "visible") problems.push(`window not visible (${visible}): an occluded window gives 0 frames`);
    const overlay = await page!.evaluate<number>(`[...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter((el) => !el.querySelector(".native-terminal-surface")).length`);
    if (overlay > 0) problems.push(`${overlay} dialog(s) cover the canvas (first-run tour?)`);
    return problems;
  };

  const ringsNow = () =>
    page!.evaluate<{ moving: number; marks: number }>(`(() => {
      const inView = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      };
      const marks = [...document.querySelectorAll(".junto-mark")].filter(inView);
      const moving = marks.filter((el) => ["wave", "pulse", "loop"].includes(el.getAttribute("data-activity-mode") ?? ""));
      return { moving: moving.length, marks: marks.length };
    })()`);

  const metrics = async (): Promise<Record<string, number>> => {
    const { metrics: rows } = await page!.send("Performance.getMetrics");
    return Object.fromEntries((rows as Array<{ name: string; value: number }>).map((row) => [row.name, row.value]));
  };
  const processCpu = async (): Promise<Record<string, number>> => {
    const { processInfo } = await browser!.send("SystemInfo.getProcessInfo");
    const byType: Record<string, number> = {};
    for (const row of processInfo as Array<{ type: string; cpuTime: number }>) byType[row.type] = (byType[row.type] ?? 0) + row.cpuTime;
    return byType;
  };

  // The background may be written in any colour syntax (the app uses oklch):
  // paint it into a pixel and read the pixel back.
  const darkNow = () =>
    page!.evaluate<{ dark: boolean; background: string }>(`(() => {
      const background = getComputedStyle(document.body).backgroundColor;
      const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return { dark: r + g + b < 300, background };
    })()`);

  // Layer count: the page's compositor layer tree. Layerize cost: trace a short
  // extra pan and sum PaintArtifactCompositor::Update.
  const layerCount = async (): Promise<number | null> => {
    let layers: number | null = null;
    page!.on("LayerTree.layerTreeDidChange", (params: { layers?: unknown[] }) => {
      if (Array.isArray(params.layers)) layers = params.layers.length;
    });
    await page!.send("LayerTree.enable").catch(() => undefined);
    for (let waited = 0; layers === null && waited < 1_500; waited += 100) await sleep(100);
    await page!.send("LayerTree.disable").catch(() => undefined);
    return layers;
  };
  const layerize = async (drive: NonNullable<Parameters<typeof measure>[1]>) => {
    const events: Array<any> = [];
    browser!.on("Tracing.dataCollected", (params: { value: Array<any> }) => {
      for (const event of params.value) if (event.name === "PaintArtifactCompositor::Update") events.push(event);
    });
    const done = new Promise<void>((ok) => browser!.on("Tracing.tracingComplete", () => ok()));
    await browser!.send("Tracing.start", { traceConfig: { includedCategories: ["blink", "cc", "devtools.timeline"] }, transferMode: "ReportEvents" } as never);
    const t0 = performance.now();
    await drive(2_000, { sample: true });
    const sampleSeconds = (performance.now() - t0) / 1000;
    await browser!.send("Tracing.end");
    await done;
    let totalUs = 0;
    let updates = 0;
    const open = new Map<string, number[]>();
    for (const event of events) {
      if (event.ph === "X" && typeof event.dur === "number") {
        totalUs += event.dur;
        updates += 1;
      } else if (event.ph === "B") {
        const key = `${event.pid}:${event.tid}`;
        open.set(key, [...(open.get(key) ?? []), event.ts]);
      } else if (event.ph === "E") {
        const key = `${event.pid}:${event.tid}`;
        const stack = open.get(key) ?? [];
        const begin = stack.pop();
        if (begin !== undefined) {
          totalUs += event.ts - begin;
          updates += 1;
        }
      }
    }
    return { updates, totalMs: totalUs / 1000, sampleSeconds };
  };

  const measure = async (
    name: string,
    drive: (windowMs: number, run?: { sample: boolean }) => Promise<{ bytesWritten?: number; viewport?: string[]; wheel?: Scenario["wheel"] } | void>,
    options: { raf?: boolean; pointer?: string; layerSample?: boolean; before?: () => Promise<void> } = {},
  ): Promise<Scenario> => {
    await sendWorking();
    await options.before?.();
    const rings = await ringsNow();
    if (options.raf) {
      await page!.evaluate(`(() => {
        const p = (window.__ringProbe = { deltas: [], on: true, loaf: [] });
        try {
          new PerformanceObserver((list) => { for (const e of list.getEntries()) p.loaf.push(e.duration); }).observe({ type: "long-animation-frame", buffered: false });
        } catch {}
        let last = performance.now();
        const tick = (now) => { p.deltas.push(now - last); last = now; if (p.on) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      })()`);
    }
    const metricsBefore = await metrics();
    const cpuBefore = await processCpu();
    const loadBefore = loadavg()[0]!;
    const t0 = performance.now();
    const driven = await drive(seconds * 1000);
    const elapsed = (performance.now() - t0) / 1000;
    const metricsAfter = await metrics();
    const cpuAfter = await processCpu();
    const probed = options.raf
      ? await page!.evaluate<{ deltas: number[]; loaf: number[] }>(`(() => { window.__ringProbe.on = false; return { deltas: window.__ringProbe.deltas, loaf: window.__ringProbe.loaf }; })()`)
      : null;
    const deltas = probed ? probed.deltas : null;

    const perSecond = (key: string) =>
      metricsAfter[key] !== undefined && metricsBefore[key] !== undefined
        ? round1(((metricsAfter[key]! - metricsBefore[key]!) / elapsed) * 1000)
        : null;
    let rafDropped: number | null = null;
    if (deltas) {
      const interval = Math.min(17.5, Math.max(6, [...deltas].sort((x, y) => x - y)[0] ?? 16.7));
      rafDropped = deltas.reduce((sum, d) => (d > interval * 1.5 ? sum + Math.round(d / interval) - 1 : sum), 0);
    }
    let frameMs: Scenario["frameMs"] = null;
    if (deltas && deltas.length > 2) {
      const frames = deltas.slice(1).sort((x, y) => x - y);
      const at = (q: number) => round1(frames[Math.min(frames.length - 1, Math.floor(frames.length * q))]!);
      const hz = environment.displayHz;
      const interval = 1000 / hz;
      frameMs = {
        source: "page requestAnimationFrame deltas (main-thread frames); compositor-presented frames were not available",
        displayHz: hz,
        p50: at(0.5),
        p95: at(0.95),
        p99: at(0.99),
        max: round1(frames[frames.length - 1]!),
        over8_3: frames.filter((d) => d > 8.33).length,
        over16_7: frames.filter((d) => d > 16.7).length,
        droppedAtDisplayRate: frames.reduce((sum, d) => (d > interval * 1.5 ? sum + Math.round(d / interval) - 1 : sum), 0),
      };
    }
    const cpuPercent: Record<string, number> = {};
    for (const type of Object.keys(cpuAfter)) cpuPercent[type] = round1(((cpuAfter[type]! - (cpuBefore[type] ?? 0)) / elapsed) * 100);
    const problems = await checks();
    const theme = await darkNow();
    if (!theme.dark) problems.push(`not the dark theme (body ${theme.background})`);
    if (rings.moving < MIN_RINGS) problems.push(`only ${rings.moving} moving rings on screen (need ${MIN_RINGS})`);
    const accessibilityOn = await main!.evaluate<boolean>(`__probe.app.accessibilitySupportEnabled`);
    if (deltas && deltas.length === 0) problems.push("0 frames: the window did not paint");
    const count = await layerCount().catch(() => null);
    let layers: Scenario["layers"] = { count, countSource: "LayerTree.layerTreeDidChange", layerizeUpdates: null, layerizeMsPerUpdate: null, layerizeMsPerSecond: null, sampleSeconds: null, traceSource: null };
    if (options.layerSample) {
      const sampled = await layerize(drive).catch((error) => {
        problems.push(`layerize sample failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (sampled) {
        layers = {
          ...layers!,
          layerizeUpdates: sampled.updates,
          layerizeMsPerUpdate: sampled.updates === 0 ? null : Math.round((sampled.totalMs / sampled.updates) * 100) / 100,
          layerizeMsPerSecond: round1(sampled.totalMs / sampled.sampleSeconds),
          sampleSeconds: round1(sampled.sampleSeconds),
          traceSource: "Chrome trace categories blink,cc,devtools.timeline: PaintArtifactCompositor::Update, summed over a separate 2 s pan after the measured window",
        };
        if (sampled.updates === 0) problems.push("layerize sample saw no PaintArtifactCompositor::Update events (event name or category not found)");
      }
    }
    return {
      name,
      valid: problems.length === 0,
      problems,
      seconds: round1(elapsed),
      rendererBusyMsPerSecond: perSecond("TaskDuration"),
      scriptMsPerSecond: perSecond("ScriptDuration"),
      layoutMsPerSecond: perSecond("LayoutDuration"),
      styleMsPerSecond: perSecond("RecalcStyleDuration"),
      rafFrames: deltas ? deltas.length : null,
      rafDropped,
      frameMs,
      longAnimationFrames: probed
        ? { count: probed.loaf.length, maxMs: round1(Math.max(0, ...probed.loaf)), totalMs: round1(probed.loaf.reduce((a, b) => a + b, 0)) }
        : null,
      pointer: options.pointer ?? null,
      layers,
      wheel: driven?.wheel ?? null,
      bytesWritten: driven?.bytesWritten ?? null,
      cpuPercent,
      ringsVisible: rings,
      accessibilityOn,
      viewport: driven?.viewport ?? null,
      loadAverage1m: { before: Math.round(loadBefore * 100) / 100, after: Math.round(loadavg()[0]! * 100) / 100 },
    };
  };

  if (hideRingParts) {
    // The rings are the product's heartbeat and the motion law forbids stilling
    // them; this is a probe-only look at what their layers cost, in a throwaway
    // window, and the report says so.
    await page.evaluate(`(() => {
      const style = document.createElement("style");
      style.textContent = ".junto-mark__part { display: none !important; }";
      document.head.append(style);
    })()`);
    await sleep(500);
  }
  const preflight = await checks();
  const streamProblems: string[] = [];
  const results: Scenario[] = [];
  const want = (name: string) => wantedScenarios.includes(name);
  if (want("idle")) results.push(await measure("idle", async (ms) => { await sleep(ms); }));
  // The pointer is part of the scenario: parked over the canvas, hover work can
  // follow the pan; outside the window, none can.
  const parkPointer = async (where: "over" | "outside") => {
    const point = where === "over" ? await page!.evaluate<{ x: number; y: number }>(`({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) })`) : { x: -20, y: -20 };
    await page!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
    await sleep(400);
  };
  for (const where of ["outside", "over"] as const) {
    const scenarioName = where === "over" ? "pan-hover" : "pan-outside";
    if (!want(scenarioName)) continue;
    results.push(
    await measure(
      scenarioName,
      async (ms, run) => {
        // Sweep one way for half the window and back for the other half, so the
        // camera crosses the nested regions and ends where it began.
        const viewport = async () => page!.evaluate<string>(`document.querySelector(".react-flow__viewport")?.style.transform ?? ""`);
        const seen = [await viewport()];
        // pan-hover: trusted wheel through CDP at the parked pointer, paced at
        // the 120 Hz frame time on an absolute schedule. pan-outside: page
        // events with no pointer at all, the control. If a trusted wheel hangs
        // (it can in Electron) the run falls back and says so.
        const point = await page!.evaluate<{ x: number; y: number }>(`({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) })`);
        let mode = where === "over" ? "trusted" : "untrusted";
        const wheel = async (dx: number, dy: number) => {
          if (mode === "trusted") {
            const sentAt = performance.now();
            const call = page!.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: dx, deltaY: dy }, 20_000);
            const acked = call.then(() => { ackLag.push(performance.now() - sentAt); });
            if (events === 0) {
              // The first one is awaited: if a trusted wheel hangs, find out now.
              try {
                await Promise.race([acked, sleep(3_000).then(() => { throw new Error("no ack"); })]);
                return;
              } catch {
                mode = "untrusted (trusted mouseWheel did not answer)";
              }
            } else {
              // The ack only returns once the renderer has handled the event, so
              // awaiting each one would serialize pacing on round trips. Send on
              // the schedule and collect the acks after the loop; CDP keeps order.
              inFlight.push(acked);
              return;
            }
          }
          await page!.evaluate(`(document.querySelector(".react-flow__pane") || document.body).dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: ${dx}, deltaY: ${dy} }))`);
        };
        const step = where === "over" ? WHEEL_MS : 16;
        let events = 0;
        const ackLag: number[] = [];
        const inFlight: Promise<void>[] = [];
        let tracePath: string | null = null;
        const traced: Array<any> = [];
        let traceDone: Promise<void> | undefined;
        if (traceBase !== "" && !run?.sample) {
          browser!.on("Tracing.dataCollected", (params: { value: Array<any> }) => { traced.push(...params.value); });
          traceDone = new Promise<void>((done) => browser!.on("Tracing.tracingComplete", () => done()));
          await browser!.send("Tracing.start", {
            traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline.frame", "blink", "cc", "viz", "gpu", "benchmark"] },
            transferMode: "ReportEvents",
          } as never);
        }
        const started = performance.now();
        const half = started + ms / 2;
        let marked = false;
        const scale = step / 16;
        while (performance.now() < started + ms) {
          const sign = performance.now() < half ? 1 : -1;
          if (!marked && sign === -1) {
            seen.push(await viewport());
            marked = true;
          }
          await wheel(sign * 12 * scale, sign * 6 * scale);
          events += 1;
          const wait = started + events * step - performance.now();
          if (wait > 0) await sleep(wait);
        }
        await Promise.all(inFlight);
        if (traceDone) {
          await browser!.send("Tracing.end");
          await traceDone;
          tracePath = `${traceBase}.${scenarioName}.json`;
          writeFileSync(tracePath, JSON.stringify({ traceEvents: traced }));
        }
        seen.push(await viewport());
        return { viewport: seen, wheel: { mode, events, eventsPerSecond: round1(events / ((performance.now() - started) / 1000)), ackLagMs: ackLag.length === 0 ? null : { p50: round1([...ackLag].sort((a, b) => a - b)[Math.floor(ackLag.length / 2)]!), max: round1(Math.max(...ackLag)) }, tracePath } };
      },
      { raf: true, pointer: where, layerSample: true, before: () => parkPointer(where) },
    ),
    );
  }
  if (want("stream")) results.push(
    await measure(
      "stream",
      async (ms) => {
        // A fixed rate: LINES_PER_TICK lines every TICK_MS for the whole window,
        // written by this script, so every build processes the same bytes.
        const block = Array.from({ length: LINES_PER_TICK }, (_, i) => `tick ${String(i).padStart(2, "0")} the quick brown fox jumps over the lazy dog 0123456789\n`).join("");
        let fd = -1;
        for (let tries = 0; fd < 0 && tries < 100; tries += 1) {
          try {
            fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
          } catch {
            await sleep(100);
          }
        }
        if (fd < 0) {
          streamProblems.push("stream terminal never opened the fifo for reading");
          await sleep(ms);
          return { bytesWritten: 0 };
        }
        let bytesWritten = 0;
        let stalled = 0;
        const ticks = Math.round(ms / TICK_MS);
        const started = performance.now();
        for (let tick = 0; tick < ticks; tick += 1) {
          try {
            bytesWritten += writeSync(fd, block);
          } catch {
            stalled += 1;
          }
          const wait = started + (tick + 1) * TICK_MS - performance.now();
          if (wait > 0) await sleep(wait);
        }
        closeSync(fd);
        if (stalled > 0) streamProblems.push(`${stalled} of ${ticks} output ticks hit a full pipe`);
        return { bytesWritten };
      },
      {
        before: async () => {
          // Open the stream terminal the way an operator does: a trusted double
          // click on a point of the card that nothing covers (the station bar
          // can sit over the top row at fit-view); wheel-pan a little if none is.
          const findPoint = () => page!.evaluate<{ x: number; y: number } | null>(`(() => {
            const node = document.querySelector('.react-flow__node[data-id="ring-stream"]');
            if (!node) return null;
            const r = node.getBoundingClientRect();
            for (const fy of [0.5, 0.3, 0.7, 0.15, 0.85]) for (const fx of [0.5, 0.3, 0.7]) {
              const x = r.left + r.width * fx, y = r.top + r.height * fy;
              if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
              if (document.elementFromPoint(x, y)?.closest('.react-flow__node[data-id="ring-stream"]')) return { x, y };
            }
            return null;
          })()`);
          let rect = await findPoint();
          for (let tries = 0; !rect && tries < 4; tries += 1) {
            await page!.evaluate(`(document.querySelector(".react-flow__pane") || document.body).dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 }))`);
            await sleep(300);
            rect = await findPoint();
          }
          const opened = () => page!.evaluate<boolean>(`Boolean(document.querySelector(".native-terminal-surface, .xterm"))`);
          if (rect) {
            for (const clickCount of [1, 2]) {
              const at = { x: rect.x, y: rect.y, button: "left", clickCount };
              await page!.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at });
              await page!.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
            }
          }
          let surface = await waitFor("the stream terminal surface", 8_000, opened).catch(() => false);
          if (!surface) {
            await page!.evaluate(`document.querySelector('.react-flow__node[data-id="ring-stream"]')?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }))`);
            surface = await waitFor("the stream terminal surface", 8_000, opened).catch(() => false);
          }
          if (!surface) {
            const seen = await page!.evaluate<string>(`JSON.stringify({
              node: Boolean(document.querySelector('.react-flow__node[data-id="ring-stream"]')),
              rect: ${JSON.stringify(rect)},
              topElement: (() => { const el = document.elementFromPoint(${rect?.x ?? 0}, ${rect?.y ?? 0}); return el ? el.tagName + "." + String(el.className).slice(0, 80) : null; })(),
              classes: [...new Set([...document.querySelectorAll("[class]")].flatMap((el) => [...el.classList]).filter((c) => /term|xterm|surface|modal/i.test(c)))].slice(0, 40),
            })`);
            streamProblems.push(`stream terminal did not open: ${seen}`);
          }
        },
      },
    ),
  );
  const streamRow = results.find((row) => row.name === "stream");
  if (streamRow) {
    const streamed = await page.evaluate<number>(
      `(() => { const m = window.__juntoTermScreenText; const read = m && m.values().next().value; return read ? read().split("tick").length - 1 : -1; })()`,
    );
    streamRow.problems.push(...streamProblems);
    if (streamed < 1) streamRow.problems.push(`stream terminal showed no output (ticks seen: ${streamed})`);
    streamRow.valid = streamRow.problems.length === 0;
  }

  const report = {
    label,
    sourceCommit,
    appRoot,
    ...(hideRingParts
      ? { diagnostic: { kind: "hide-ring-parts", comparableToProduct: false, note: "DIAGNOSTIC, not a product configuration: .junto-mark__part is display:none for this run. Never compare these numbers with a product build and never read them as a shipping option; the motion law stands." } }
      : {}),
    command: `bun scripts/probe-ring-cost.ts --app-root ${appRoot} --label ${label}${hideRingParts ? " --hide-ring-parts" : ""} --seconds ${seconds} --port ${port} --fixture ${fixtureName} --scenarios ${wantedScenarios.join(",")}`,
    when: new Date().toISOString(),
    environment: { ...environment, rendererAccessibilityForcedOff: forceAxOff, streamLinesPerTick: LINES_PER_TICK, streamTickMs: TICK_MS, preflightProblems: preflight },
    fixture: fixtureSummary,
    animations: animationReport,
    valid: results.every((row) => row.valid),
    scenarios: results,
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (outPath !== "") writeFileSync(outPath, json);
  console.log(
    `${hideRingParts ? "DIAGNOSTIC (ring parts hidden, not comparable) " : ""}${label} ${sourceCommit?.slice(0, 9) ?? "?"} ` +
      results
        .map((row) => `${row.name}: busy ${row.rendererBusyMsPerSecond} ms/s${row.frameMs === null ? "" : `, frame p50/p95/p99/max ${row.frameMs.p50}/${row.frameMs.p95}/${row.frameMs.p99}/${row.frameMs.max} ms, dropped ${row.frameMs.droppedAtDisplayRate}`}, gpu ${row.cpuPercent.GPU ?? "?"}%, renderer ${row.cpuPercent.renderer ?? "?"}%, rings ${row.ringsVisible.moving}`)
        .join(" | ") +
      (report.valid ? "" : " | INVALID"),
  );

  if (holdSeconds > 0) {
    // For another capture sharing the instance: one seat done (a turn that
    // ended unread), one needing input, the rest still working.
    await main.evaluate(`(() => {
      const at = Date.now();
      const send = (n, state, offset) => {
        const id = "ring-seat-" + String(n).padStart(2, "0");
        for (const window of __probe.BrowserWindow.getAllWindows())
          window.webContents.send("junto:agent-seat-state-changed", {
            bindingId: "local:" + id, epoch: "ring-cost", state,
            reason: state === "attention" ? "rule:approval_prompt" : "rule:empty_prompt_idle",
            confidence: "high", at: at + offset,
          });
      };
      send(1, "idle", 1);
      send(2, "attention", 0);
      return true;
    })()`);
    console.error(`ring cost: holding the app for ${holdSeconds} s; renderer CDP on 127.0.0.1:${port}`);
    await sleep(holdSeconds * 1000);
  }
  await teardown();
  process.exit(report.valid ? 0 : 2);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await teardown().catch(() => undefined);
  process.exit(1);
}
