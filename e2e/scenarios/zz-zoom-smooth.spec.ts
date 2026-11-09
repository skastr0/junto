/**
 * Zoom smoothness probe (measurement only, never a gate): how often the
 * canvas moves on screen while one scripted zoom and pan is replayed through
 * Chromium's own input path, on the operator's factory board shape, with
 * seats reporting. The same script (lab/gpu-canvas/gesture.cjs) and the same
 * summary (lab/gpu-canvas/summarize.cjs) drive the GPU canvas lab, so the two
 * read line for line.
 *
 *   PROBE_RATE=30 PROBE_WORKING=30 scripts/run-e2e.sh e2e/scenarios/zz-zoom-smooth.spec.ts
 *
 * Writes test-results/zz-zoom-smooth.json, and the Chromium trace beside it
 * unless PROBE_TRACE=0.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { SeatStateMachine } from "../../src/core/term/agent-state";
import { OPERATOR_DISPLAY, type NestedCanvasFixture } from "../harness/nested-canvas-fixture";
import { expect, launchJunto, test } from "../harness/launch";

const CHANNEL = "junto:agent-seat-state-changed";
const RATE = Number(process.env["PROBE_RATE"] ?? 30);
const HZ = Number(process.env["PROBE_HZ"] ?? 120);
// How many seats work and report, spread over the board; unset means every seat, 0 none.
const WORKING = process.env["PROBE_WORKING"];
const TRACE = process.env["PROBE_TRACE"] !== "0";
// Extra Chromium switches, space separated, such as --disable-gpu for the no-GPU reading.
const ARGS = (process.env["PROBE_ARGS"] ?? "").split(" ").filter(Boolean);
const FIXTURE = "e2e/scenarios/zz-idle-probe.factory.json";
// The installed app's trace categories without the sampling profiler; the lab records the same list.
const CATEGORIES = ["toplevel", "blink", "cc", "viz", "gpu", "input", "benchmark", "latencyInfo", "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame"];

type Step = { at: number; dx: number; dy: number; ctrl: boolean };
type Script = { hz: number; steps: Step[]; gestures: { kind: string; start: number; end: number }[]; end: number };
type FrameLog = { n: number; t: number[]; moved: number[]; wheel: { at: number[]; stamp: number[] } };
type Sample = { t: number; procs: { type: string; pid: number; cpuS: number; mb: number }[] };

const epoch = (): number => performance.timeOrigin + performance.now();
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const send = (app: ElectronApplication, events: ReadonlyArray<unknown>) =>
  app.evaluate(({ BrowserWindow }, { channel, events }) => {
    for (const w of BrowserWindow.getAllWindows()) for (const e of events) w.webContents.send(channel, e);
  }, { channel: CHANNEL, events });

test("zoom smoothness probe: how often the canvas moves during a scripted zoom", async () => {
  test.setTimeout(900_000);
  test.skip(!existsSync(join(process.cwd(), FIXTURE)), `needs the operator factory capture ${FIXTURE} (not in git)`);
  const parsed = JSON.parse(await readFile(join(process.cwd(), FIXTURE), "utf8")) as Omit<NestedCanvasFixture, "signals"> & { signalRows: ReturnType<NestedCanvasFixture["signals"]> };
  const fixture: NestedCanvasFixture = { ...parsed, signals: () => parsed.signalRows };
  const nodes = parsed.model.nodes as ReadonlyArray<{ kind: string; id?: string; bindingId?: string; harness?: string; x: number; y: number; width: number; height: number }>;
  const seats = nodes.filter((n) => n.kind === "agent" && n.bindingId).map((n) => ({ bindingId: n.bindingId!, harness: n.harness ?? "codex" }));
  const centre = {
    x: (Math.min(...nodes.map((n) => n.x)) + Math.max(...nodes.map((n) => n.x + n.width))) / 2,
    y: (Math.min(...nodes.map((n) => n.y)) + Math.max(...nodes.map((n) => n.y + n.height))) / 2,
  };
  const script = JSON.parse(execFileSync("node", [join(process.cwd(), "lab/gpu-canvas/gesture.cjs"), String(HZ)], { encoding: "utf8" })) as Script;

  const count = WORKING === undefined ? seats.length : Number(WORKING);
  const every = Math.ceil(seats.length / Math.max(1, count));
  const active = count > 0 ? seats.filter((_, i) => i % every === 0) : [];
  const machine = new SeatStateMachine({ now: () => Date.now() });
  for (const s of seats) machine.bind(s.bindingId, { harness: s.harness, epoch: "probe" });
  const working = new Map<string, boolean>();
  let pick = 7;
  const next = () => {
    // Deterministic walk over the seats: half re-send, half turn.
    pick = (pick * 1103515245 + 12345) % 2147483648;
    const seat = active[pick % active.length]!;
    const now = working.get(seat.bindingId) ?? true;
    const state = (pick >> 8) % 2 === 0 ? !now : now;
    working.set(seat.bindingId, state);
    return machine.force(seat.bindingId, state ? "working" : "idle", state ? "probe:working" : "probe:idle");
  };

  const junto = await launchJunto({ ...OPERATOR_DISPLAY, electronArgs: [...OPERATOR_DISPLAY.electronArgs, ...ARGS], nestedCanvas: { fixture, name: "factory" } });
  try {
    const { app, page } = junto;
    await expect(page.locator(".react-flow__node-group")).toHaveCount(fixture.stats.regions, { timeout: 120_000 });
    await send(app, active.map((s) => { working.set(s.bindingId, true); return machine.force(s.bindingId, "working", "probe:working"); }));
    await page.waitForTimeout(4_000);

    const cdp = await page.context().newCDPSession(page);
    const box = (await page.locator(".react-flow__pane").boundingBox())!;
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const wheel = (dx: number, dy: number, ctrl: boolean) =>
      cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: dx, deltaY: dy, modifiers: ctrl ? 2 : 0 });
    const camera = () =>
      page.evaluate(() => {
        const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([-\d.e]+)\)/.exec(document.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform);
        return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : { x: 0, y: 0, z: 1 };
      });

    // Start where the lab starts: zoomed all the way out, the board's centre
    // under the pointer. A plain wheel pans the camera by 1.2 px per unit.
    for (let i = 0; i < 4; i++) {
      await wheel(0, 240, true);
      await page.waitForTimeout(250);
    }
    for (let i = 0; i < 40; i++) {
      const cam = await camera();
      const dx = cam.x - (box.width / 2 - centre.x * cam.z);
      const dy = cam.y - (box.height / 2 - centre.y * cam.z);
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) break;
      await wheel(Math.max(-300, Math.min(300, dx / 1.2)), Math.max(-300, Math.min(300, dy / 1.2)), false);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(1_500);
    const startCamera = await camera();

    // One row per animation frame: when it started, and whether the camera
    // had moved since the frame before.
    await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>(".react-flow__viewport")!;
      const log = { t: [] as number[], moved: [] as number[], wheel: { at: [] as number[], stamp: [] as number[] } };
      // A passive listener ahead of the canvas's own: when each wheel event
      // reached the page, and when it was made.
      window.addEventListener("wheel", (event) => {
        log.wheel.at.push(performance.timeOrigin + performance.now());
        log.wheel.stamp.push(performance.timeOrigin + event.timeStamp);
      }, { capture: true, passive: true });
      let last = viewport.style.transform;
      const tick = (): void => {
        const now = viewport.style.transform;
        log.t.push(performance.timeOrigin + performance.now());
        log.moved.push(now === last ? 0 : 1);
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      (window as unknown as { __zoomLog: typeof log }).__zoomLog = log;
    });
    const sample = (): Promise<Sample> =>
      app.evaluate(({ app }) => ({
        t: performance.timeOrigin + performance.now(),
        procs: app.getAppMetrics().map((p) => ({ type: p.type, pid: p.pid, cpuS: p.cpu.cumulativeCPUUsage ?? 0, mb: p.memory.workingSetSize / 1024 })),
      }));
    const windowPid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId() ?? -1);

    let stop = false;
    const reports = (async (): Promise<number> => {
      if (!(RATE > 0) || active.length === 0) return 0;
      const gap = 1000 / RATE;
      const t0 = Date.now();
      let sent = 0;
      while (!stop) {
        await send(app, [next()]);
        sent++;
        const wait = t0 + sent * gap - Date.now();
        if (wait > 0) await pause(wait);
      }
      return sent;
    })();

    const tracePath = join(process.cwd(), "test-results/zz-zoom-smooth-trace.json");
    if (TRACE) await app.evaluate(async ({ contentTracing }, categories) => contentTracing.startRecording({ included_categories: categories }), CATEGORIES);
    const samples = [await sample()];
    const start = epoch();
    let step = 0;
    for (;;) {
      const t = epoch() - start;
      while (step < script.steps.length && script.steps[step]!.at <= t) {
        const s = script.steps[step++]!;
        void wheel(s.dx, s.dy, s.ctrl).catch(() => undefined);
      }
      if (t >= script.end) break;
      await pause(2);
    }
    samples.push(await sample());
    stop = true;
    const sent = await reports;
    if (TRACE) await app.evaluate(async ({ contentTracing }, out) => contentTracing.stopRecording(out), tracePath);

    const frames = await page.evaluate(() => (window as unknown as { __zoomLog: Omit<FrameLog, "n"> }).__zoomLog);
    const log: FrameLog & { reports: number[] } = { n: frames.t.length, t: frames.t, moved: frames.moved, wheel: frames.wheel, reports: [sent] };
    const raw = {
      log,
      script,
      start,
      samples,
      pids: { host: windowPid, canvas: -1 },
      options: { arm: "dom", rate: RATE, working: active.length, seats: seats.length, hz: HZ, args: ARGS, size: [Math.round(box.width), Math.round(box.height)], startCamera, endCamera: await camera(), trace: TRACE ? tracePath : null },
    };
    const rawPath = join(process.cwd(), "test-results/zz-zoom-smooth-raw.json");
    await writeFile(rawPath, JSON.stringify(raw));
    const summary = execFileSync("node", [join(process.cwd(), "lab/gpu-canvas/summarize.cjs"), rawPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    await writeFile(join(process.cwd(), "test-results/zz-zoom-smooth.json"), summary);
    console.log(`ZOOM-SMOOTH ${JSON.stringify(JSON.parse(summary))}`);
  } finally {
    await junto.close();
  }
});
