/**
 * What the activity rings cost. One repeatable command, run on a build before
 * and after a ring change, so the two result sets compare.
 *
 *   bun scripts/probe-ring-cost.ts --app-root DIR [--label baseline]
 *     [--seats 24] [--seconds 6] [--port 9341] [--hold 0] [--out FILE]
 *
 * DIR is a checkout whose `out/` is a PRODUCTION build (electron-vite build,
 * not `bun run dev`: React dev and StrictMode skew every number). The script
 * runs from any checkout; it never builds and never touches ~/.junto.
 *
 * The app boots on a throwaway HOME and JUNTO_HOME (short /tmp path, see
 * sandbox.ts), JUNTO_PERF=1, --remote-debugging-port=PORT and a main-process
 * --inspect port. Many seats are injected as "working", so their rings move.
 * Three scenarios of --seconds each:
 *   idle    nothing touches the canvas
 *   pan     wheel events every 16 ms, back and forth
 *   stream  a shell terminal prints in a tight loop while the rings stay up
 * Per scenario: renderer main-thread busy ms per second, frames presented and
 * dropped, GPU / browser / renderer process CPU %, and the rings on screen.
 *
 * Invalid runs are reported, never repaired (PERF_LEDGER.md): an occluded
 * window gives 0 frames, and a live accessibility tree doubles main-thread
 * cost. Either marks the run `valid: false` and exits 2.
 *
 * --hold N keeps the app up N seconds after the scenarios so another capture
 * (a Chrome trace, screenshots) can attach to the same instance on PORT.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createSandbox, destroySandbox, writeFixtureModel } from "../e2e/harness/sandbox";
import { modelFixture, modelSeat, modelTerminal } from "../e2e/harness/model";
import { startRendererServer } from "../e2e/harness/renderer-server";

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
};
const appRoot = resolve(arg("app-root", ""));
const label = arg("label", "run");
const seatCount = Number(arg("seats", "24"));
const seconds = Number(arg("seconds", "6"));
const port = Number(arg("port", "9341"));
const holdSeconds = Number(arg("hold", "0"));
const outPath = arg("out", "");
const CANVAS = "ring-cost";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

if (arg("app-root", "") === "") {
  console.error("usage: bun scripts/probe-ring-cost.ts --app-root DIR [--label L] [--seats N] [--seconds S] [--port P] [--hold S] [--out FILE]");
  process.exit(64);
}
for (const path of ["out/main/index.js", "out/renderer/index.html"]) {
  if (!existsSync(join(appRoot, path))) {
    console.error(`ring cost: ${join(appRoot, path)} is missing; build ${appRoot} first (electron-vite build)`);
    process.exit(64);
  }
}
const provenancePath = join(appRoot, "out/package-runtime-provenance.json");
const sourceCommit: string | null = existsSync(provenancePath)
  ? (JSON.parse(readFileSync(provenancePath, "utf8")).sourceCommit ?? null)
  : null;

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
  const send = async (method: string, params: Record<string, Json> = {}): Promise<any> => {
    const id = next++;
    const reply = await new Promise<{ result?: Json; error?: unknown }>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`CDP timeout: ${method}`)), 60_000);
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
const flagDir = join(sandbox.root, "flags");
const goFile = join(flagDir, "go");
const stopFile = join(flagDir, "stop");
await Bun.write(join(flagDir, ".keep"), "");
writeFileSync(join(sandbox.root, "probe-hook.cjs"), HOOK);

const cols = 6;
const seats = Array.from({ length: seatCount }, (_, i) =>
  modelSeat({ id: `ring-seat-${String(i + 1).padStart(2, "0")}`, x: 40 + (i % cols) * 260, y: 40 + Math.floor(i / cols) * 150 }),
);
// A shell that waits for `go`, prints in a tight loop until `stop`.
const stream = modelTerminal({
  id: "ring-stream",
  bindingId: "local:ring-stream",
  label: "stream",
  x: 40,
  y: 40 + Math.ceil(seatCount / cols) * 150,
  launch: {
    kind: "command",
    argv: [
      "/bin/sh",
      "-c",
      `until [ -e "${goFile}" ]; do sleep 0.05; done; while [ ! -e "${stopFile}" ]; do i=0; while [ $i -lt 400 ]; do echo "tick $i the quick brown fox jumps over the lazy dog 0123456789"; i=$((i+1)); done; done`,
    ],
  },
});
await writeFixtureModel(sandbox, CANVAS, modelFixture([...seats, stream]));

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
  rafFrames: number;
  rafDropped: number;
  framesPresented: number | null;
  framesDropped: number | null;
  cpuPercent: Record<string, number>;
  ringsVisible: { moving: number; marks: number };
};

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
  await sendWorking();
  await sleep(1_500);

  const environment = await main.evaluate<{ accessibility: boolean; electron: string; chrome: string; displays: number }>(`({
    accessibility: __probe.app.accessibilitySupportEnabled,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    displays: __probe.screen.getAllDisplays().length,
  })`);
  const checks = async (): Promise<string[]> => {
    const problems: string[] = [];
    const visible = await page!.evaluate<string>(`document.visibilityState`);
    if (visible !== "visible") problems.push(`window not visible (${visible}): an occluded window gives 0 frames`);
    const ax = await main!.evaluate<boolean>(`__probe.app.accessibilitySupportEnabled`);
    if (ax) problems.push("renderer accessibility tree is on");
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

  // Frames presented / dropped come from the compositor's own PipelineReporter
  // events (browser-wide trace); rAF deltas in the page are the fallback.
  const startFrameTrace = async () => {
    const states: string[] = [];
    browser!.on("Tracing.dataCollected", (params: { value: Array<any> }) => {
      for (const event of params.value) {
        if (event.name !== "PipelineReporter" || event.ph !== "e") continue;
        const state = event.args?.chrome_frame_reporter?.state;
        if (typeof state === "string") states.push(state);
      }
    });
    const complete = new Promise<void>((done) => browser!.on("Tracing.tracingComplete", () => done()));
    await browser!.send("Tracing.start", {
      traceConfig: { includedCategories: ["benchmark", "cc", "viz", "disabled-by-default-cc.debug.display_stats"] },
      transferMode: "ReportEvents",
    } as never);
    return async () => {
      await browser!.send("Tracing.end");
      await complete;
      return states;
    };
  };

  const measure = async (name: string, drive: (windowMs: number) => Promise<void>, before?: () => Promise<void>): Promise<Scenario> => {
    await sendWorking();
    await before?.();
    const rings = await ringsNow();
    await page!.evaluate(`(() => {
      const p = (window.__ringProbe = { deltas: [], on: true });
      let last = performance.now();
      const tick = (now) => { p.deltas.push(now - last); last = now; if (p.on) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    })()`);
    const stopTrace = await startFrameTrace();
    const metricsBefore = await metrics();
    const cpuBefore = await processCpu();
    const t0 = performance.now();
    await drive(seconds * 1000);
    const elapsed = (performance.now() - t0) / 1000;
    const metricsAfter = await metrics();
    const cpuAfter = await processCpu();
    const states = await stopTrace();
    const deltas = await page!.evaluate<number[]>(`(() => { window.__ringProbe.on = false; return window.__ringProbe.deltas; })()`);

    const perSecond = (key: string) =>
      metricsAfter[key] !== undefined && metricsBefore[key] !== undefined
        ? Math.round(((metricsAfter[key]! - metricsBefore[key]!) / elapsed) * 1000 * 10) / 10
        : null;
    const sorted = [...deltas].sort((a, b) => a - b);
    const interval = Math.min(17.5, Math.max(6, sorted[0] ?? 16.7));
    const rafDropped = deltas.reduce((sum, d) => (d > interval * 1.5 ? sum + Math.round(d / interval) - 1 : sum), 0);
    const cpuPercent: Record<string, number> = {};
    for (const type of Object.keys(cpuAfter)) {
      cpuPercent[type] = Math.round((((cpuAfter[type]! - (cpuBefore[type] ?? 0)) / elapsed) * 100) * 10) / 10;
    }
    const problems = await checks();
    if (deltas.length === 0) problems.push("0 frames: the window did not paint");
    return {
      name,
      valid: problems.length === 0,
      problems,
      seconds: Math.round(elapsed * 10) / 10,
      rendererBusyMsPerSecond: perSecond("TaskDuration"),
      scriptMsPerSecond: perSecond("ScriptDuration"),
      layoutMsPerSecond: perSecond("LayoutDuration"),
      styleMsPerSecond: perSecond("RecalcStyleDuration"),
      rafFrames: deltas.length,
      rafDropped,
      framesPresented: states.length === 0 ? null : states.filter((s) => s.startsWith("STATE_PRESENTED")).length,
      framesDropped: states.length === 0 ? null : states.filter((s) => s === "STATE_DROPPED").length,
      cpuPercent,
      ringsVisible: rings,
    };
  };

  const preflight = await checks();
  const results: Scenario[] = [];
  results.push(await measure("idle", async (ms) => { await sleep(ms); }));
  results.push(
    await measure("pan", async (ms) => {
      const until = performance.now() + ms;
      for (let i = 0; performance.now() < until; i += 1) {
        await page!.evaluate(`(() => {
          const el = document.querySelector(".react-flow__pane") || document.body;
          el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: ${i % 2 ? -90 : 90}, deltaY: ${i % 2 ? -120 : 120} }));
        })()`);
        await sleep(16);
      }
    }),
  );
  results.push(
    await measure(
      "stream",
      async (ms) => {
        writeFileSync(goFile, "");
        await sleep(ms);
        writeFileSync(stopFile, "");
      },
      async () => {
        // Open the stream terminal the way a double click does.
        await page!.evaluate(`(() => {
          const node = document.querySelector('.react-flow__node[data-id="ring-stream"]');
          node?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
        })()`);
        await waitFor("the stream terminal surface", 20_000, async () =>
          page!.evaluate<boolean>(`Boolean(document.querySelector(".native-terminal-surface"))`),
        );
      },
    ),
  );
  const streamed = await page.evaluate<number>(
    `(() => { const m = window.__juntoTermScreenText; const read = m && m.values().next().value; return read ? read().split("tick").length - 1 : -1; })()`,
  );
  if (streamed < 1) results[2]!.problems.push(`stream terminal showed no output (ticks seen: ${streamed})`);
  results[2]!.valid = results[2]!.problems.length === 0;

  const report = {
    label,
    sourceCommit,
    appRoot,
    command: `bun scripts/probe-ring-cost.ts --app-root ${appRoot} --label ${label} --seats ${seatCount} --seconds ${seconds} --port ${port}`,
    when: new Date().toISOString(),
    environment: { ...environment, seats: seatCount, preflightProblems: preflight },
    valid: results.every((row) => row.valid),
    scenarios: results,
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (outPath !== "") writeFileSync(outPath, json);
  console.log(
    `${label} ${sourceCommit?.slice(0, 9) ?? "?"} ` +
      results
        .map((row) => `${row.name}: busy ${row.rendererBusyMsPerSecond} ms/s, frames ${row.framesPresented ?? `~${row.rafFrames}`}/${row.framesDropped ?? `~${row.rafDropped}`} dropped, gpu ${row.cpuPercent.GPU ?? "?"}% browser ${row.cpuPercent.Browser ?? row.cpuPercent.browser ?? "?"}%, rings ${row.ringsVisible.moving}`)
        .join(" | ") +
      (report.valid ? "" : " | INVALID"),
  );

  if (holdSeconds > 0) {
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
