/**
 * Terminal performance baseline: what scrolling, typing in and watching a seat
 * terminal costs on a board the operator's size. One condition per launch;
 * scripts/perf-terminal-baseline.ts runs every condition several times, writes
 * the summary and compares builds. Skipped unless PERF_TERMINAL_COND is set.
 *
 * The board is the operator's board shape, geometry only (e2e/fixtures/
 * perf-board-layout.json: 358 nodes, 841 wires), plus sixteen seats whose
 * harness is e2e/fakes/perf-terminal-emitter.cjs. The lead's scrollback is
 * filled, then one 12 s window is traced:
 *
 *   scroll         trackpad wheel at 120 Hz, nothing streams
 *   scroll-stream  the same while the lead streams 12 KB/s
 *   type           plain text typed into the lead, one key each 200 ms, nothing streams
 *   type-busy      the same while the fifteen other seats stream 12 KB/s each
 *   type-stall     the same as type while main's event loop is held 300 ms of each second
 *   watch          no input while the lead streams 12 KB/s
 *
 * Every window also pings the app's work control socket at 20 Hz. The main
 * process owns every PTY, so a key and its echo wait out whatever holds that
 * process's event loop; the ping round trip measures exactly that wait.
 */
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { crewPlayFactory } from "../harness/crew-fixture";
import { seededHarnessBinDir } from "../harness/agent-harness-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNote, modelRegion, modelSeat, modelWire } from "../harness/model";
import type { Node as ModelNode, Wire as ModelWire } from "../../src/shared/model";
import { spread, summarizeTrace } from "../../scripts/perf-trace-summary";

const CONDITIONS = ["scroll", "scroll-stream", "type", "type-busy", "type-stall", "watch"] as const;
type Condition = (typeof CONDITIONS)[number];

const COND = process.env.PERF_TERMINAL_COND as Condition | undefined;
const OUT = process.env.PERF_TERMINAL_OUT ?? "/tmp/perf-terminal-baseline.json";
const KEEP_TRACE = process.env.PERF_TERMINAL_KEEP_TRACE === "1";
const CANVAS = "perf-terminal";
const PEERS = 15;
const FILL_MS = 4_000;
const FILL_BPS = 300_000;
const STREAM_BPS = 12_000;
const WARMUP_MS = 3_000;
const WINDOW_MS = 12_000;
// Plain keys, as typed: one capital, spaces, punctuation. The emitter never prints these, so its echo is the only write.
const TYPED = "Reading the board, typing a plain line: ok then more text.";

const ids = ["lead", ...Array.from({ length: PEERS }, (_, i) => `p${String(i).padStart(2, "0")}`)];
const seats = ids.map((id, i) =>
  modelSeat({ id, key: `local:perf-${id}`, label: id, x: (i % 4) * 300, y: Math.floor(i / 4) * 150 }),
);

const boardNodes: ModelNode[] = [];
type LaidOut = { kind: string; x: number; y: number; w: number; h: number; hold?: boolean };
const layout = JSON.parse(readFileSync(join(process.cwd(), "e2e/fixtures/perf-board-layout.json"), "utf8")) as {
  nodes: LaidOut[];
  wires: Array<[number, number]>;
};
layout.nodes.forEach((item, i) => {
  const id = `ly-${item.kind}-${String(i).padStart(3, "0")}`;
  if (item.kind === "agent") boardNodes.push({ ...modelSeat({ id, key: `local:${id}`, label: id, x: item.x, y: item.y }), width: item.w, height: item.h } as ModelNode);
  else if (item.kind === "region") boardNodes.push(modelRegion({ id, label: `region ${String(i)}`, x: item.x, y: item.y, width: item.w, height: item.h, hold: item.hold === true }));
  else boardNodes.push({ ...modelNote(id, `note ${String(i)}`, item.x, item.y), width: item.w, height: item.h } as ModelNode);
});
const pairs = new Set<string>();
const boardWires: ModelWire[] = layout.wires.flatMap(([from, to], i) => {
  const a = boardNodes[from]!;
  const b = boardNodes[to]!;
  const pair = `${a.id}>${b.id}`;
  if (a.id === b.id || a.kind !== "agent" || b.kind !== "agent" || pairs.has(pair)) return [];
  pairs.add(pair);
  return [modelWire(`ly-wire-${String(i).padStart(3, "0")}`, a.id, b.id, "messages", boardNodes)];
});
const fixture = modelFixture(
  [...boardNodes.filter((n) => n.kind === "region"), ...seats, ...boardNodes.filter((n) => n.kind !== "region")],
  [...ids.slice(1).map((id) => modelWire(`e-lead-${id}`, "lead", id, "messages", seats)), ...boardWires],
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const machine = (): { load1: number; idlePct: number } => {
  const top = spawnSync("top", ["-l", "2", "-n", "0", "-s", "1"], { encoding: "utf8" }).stdout ?? "";
  const line = top.split("\n").filter((l) => l.startsWith("CPU usage")).pop() ?? "";
  const idle = /([\d.]+)% idle/.exec(line);
  return { load1: loadavg()[0] ?? Number.NaN, idlePct: idle ? Number(idle[1]) : Number.NaN };
};

/** Ping the work control socket every 50 ms until stop(); round trips in ms. */
const pingMainLoop = (socketPath: string, token: string): { stop: () => Promise<number[]> } => {
  const rtts: number[] = [];
  const socket = createConnection(socketPath);
  socket.on("error", () => undefined);
  let buffered = "";
  let sentAt = 0;
  let running = true;
  const send = (): void => {
    if (!running) return;
    sentAt = performance.now();
    socket.write(`${JSON.stringify({ token, op: "ping" })}\n`);
  };
  socket.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    while (buffered.includes("\n")) {
      buffered = buffered.slice(buffered.indexOf("\n") + 1);
      rtts.push(performance.now() - sentAt);
      setTimeout(send, 50);
    }
  });
  socket.on("connect", send);
  return {
    stop: async () => {
      running = false;
      socket.destroy();
      return rtts;
    },
  };
};

const front = (page: Page) => page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");

/** Trackpad-like deltas: a flick that accelerates then decays, alternating direction. */
const trackpadDeltas = (events: number): number[] =>
  Array.from({ length: events }, (_, i) => {
    const k = i % 90; // 90 events per flick, about 0.75 s at 120 Hz
    const dir = Math.floor(i / 90) % 2 === 0 ? -1 : 1;
    const shape = k < 15 ? (k + 1) / 15 : Math.exp(-(k - 15) / 25);
    return dir * Math.max(1, Math.round(28 * shape));
  });

test.skip(COND === undefined, "run through scripts/perf-terminal-baseline.ts");

test(`terminal performance baseline, ${COND ?? "none"}`, async () => {
  test.setTimeout(10 * 60_000);
  if (!COND || !CONDITIONS.includes(COND)) throw new Error(`unknown condition ${String(COND)}`);

  const emitter = readFileSync(join(process.cwd(), "e2e/fakes/perf-terminal-emitter.cjs"), "utf8");
  let control = "";
  const junto = await launchJunto({
    seedModels: { [CANVAS]: fixture },
    windowContentSize: { width: 1440, height: 900 },
    afterSeed: async (sandbox) => {
      control = join(sandbox.homeDir, "perf-emit.json");
      const bin = seededHarnessBinDir(sandbox);
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "codex"), emitter.replace("__CONTROL__", control), { mode: 0o755 });
      writeFileSync(control, JSON.stringify({ bps: 0, seed: 1 }));
    },
  });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
    // JUNTO_PERF registers the terminal probe (src/renderer/lib/terminal-perf-probe.ts).
    await page.addInitScript(() => {
      (globalThis as Record<string, unknown>).JUNTO_PERF = true;
    });
    await page.reload();
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
    await crewPlayFactory(page);

    for (const id of ids) await page.evaluate(async ([c, s]) => { await window.junto!.modelStart({ canvas: c, id: s }); }, [CANVAS, id] as const);
    const started = (): string[] => readdirSync(sandbox.homeDir).filter((f) => f.startsWith("perf-emit.json.started."));
    const deadline = Date.now() + 180_000;
    while (started().length < ids.length && Date.now() < deadline) await sleep(500);
    expect(started().length, "emitters started").toBeGreaterThanOrEqual(ids.length);
    await sleep(2_000);
    const emitters = started().map((f) => JSON.parse(readFileSync(join(sandbox.homeDir, f), "utf8")) as { pid: number; env: Record<string, string> });
    const leadPid = emitters.find((s) => Object.values(s.env).some((v) => v === "lead" || v.includes(":lead") || v.endsWith("perf-lead")))?.pid;
    if (leadPid === undefined) throw new Error("lead emitter not identifiable");

    // On the full board the lead card can be out of view: open it from node search (Cmd+Enter opens the result).
    const leadCard = page.locator('.react-flow__node[data-id="lead"]');
    if (await leadCard.isVisible()) await leadCard.dblclick();
    else {
      await page.locator(".react-flow__pane").first().click({ position: { x: 5, y: 5 } }).catch(() => undefined);
      await page.keyboard.press("Meta+K");
      await sleep(600);
      await page.keyboard.type("lead");
      await sleep(600);
      await page.keyboard.press("Meta+Enter");
    }
    await expect(front(page).locator("header").first()).toContainText("lead", { timeout: 30_000 });

    // Fill the lead's scrollback, then settle to the condition's rate.
    const setLead = (bps: number): void => writeFileSync(`${control}.${String(leadPid)}`, JSON.stringify({ bps, seed: 1 }));
    const peerBps = COND === "type-busy" ? STREAM_BPS : 0;
    for (const s of emitters) if (s.pid !== leadPid) writeFileSync(`${control}.${String(s.pid)}`, JSON.stringify({ bps: peerBps, seed: 1 }));
    setLead(FILL_BPS);
    await sleep(FILL_MS);
    setLead(COND === "scroll-stream" || COND === "watch" ? STREAM_BPS : 0);
    await page.locator(".xterm-helper-textarea").first().focus().catch(() => undefined);
    await sleep(WARMUP_MS);

    const box = await front(page).locator(".xterm-screen").first().boundingBox();
    if (!box) throw new Error("no xterm screen box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);

    // In-page probes: every rAF's interval and whether the viewport moved, plus long tasks.
    // Builds without the terminal probe still measure; their viewport and render counts read null.
    const terminal = await page.evaluate(() => {
      type Probe = { visible(): boolean; viewportY(): number; lines(): number; rows(): number; renders(): number; parsedAt?(): number; renderedAt?(): number };
      const w = window as unknown as Record<string, any>;
      const probe = [...((w.__juntoTermPerf as Map<string, Probe> | undefined)?.values() ?? [])].find((p) => p.visible());
      const run = (w.__perfRun = {
        probe, frames: [] as Array<[number, number]>, longtasks: [] as number[], renders0: probe?.renders() ?? 0, stop: false,
        // Key to echo: keydown, then the first parsed write after it, then the first render after that.
        key: null as null | { at: number; parsed: number | null }, echoParsed: [] as number[], echoDrawn: [] as number[],
      });
      new PerformanceObserver((list) => { for (const e of list.getEntries()) run.longtasks.push(e.duration); }).observe({ type: "longtask", buffered: false });
      window.addEventListener("keydown", (e) => { if (e.key.length === 1) run.key = { at: performance.now(), parsed: null }; }, { capture: true });
      const tick = (t: number): void => {
        run.frames.push([t, probe?.viewportY() ?? -1]);
        const key = run.key;
        if (key && probe?.parsedAt && probe.renderedAt) {
          if (key.parsed === null && probe.parsedAt() > key.at) {
            key.parsed = probe.parsedAt();
            run.echoParsed.push(key.parsed - key.at);
          }
          if (key.parsed !== null && probe.renderedAt() >= key.parsed) {
            run.echoDrawn.push(probe.renderedAt() - key.at);
            run.key = null;
          }
        }
        if (!run.stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return {
        probe: probe !== undefined,
        renderer: document.querySelector("[data-terminal-renderer]")?.getAttribute("data-terminal-renderer") ?? null,
        lines: probe?.lines() ?? null,
        rows: probe?.rows() ?? null,
        dpr: window.devicePixelRatio,
        domNodes: document.querySelectorAll("*").length,
      };
    });

    const lead = emitters.find((s) => s.pid === leadPid)!;
    const socketPath = lead.env.JUNTO_WORK_SOCKET ?? lead.env.JUNTO_SOCKET;
    const token = lead.env.JUNTO_WORK_TOKEN;
    const m0 = machine();
    const pinger = socketPath && token ? pingMainLoop(socketPath, token) : null;
    const tracePath = OUT.replace(/\.json$/, ".trace.json");
    await junto.app.evaluate(({ contentTracing }) => contentTracing.startRecording({
      included_categories: ["toplevel", "devtools.timeline", "blink", "blink.user_timing", "cc", "viz", "gpu", "input", "benchmark", "latencyInfo"],
    }));
    // Main held 300 ms of each second, as a long sync task holds it: with the
    // terminal process, keys and echo cross no main turn and should not wait.
    if (COND === "type-stall") {
      await junto.app.evaluate(() => {
        (globalThis as { __perfStall?: ReturnType<typeof setInterval> }).__perfStall = setInterval(() => {
          const until = Date.now() + 300;
          while (Date.now() < until) { /* hold the loop */ }
        }, 1_000);
      });
    }
    const windowStart = Date.now();
    if (COND === "type" || COND === "type-busy" || COND === "type-stall") {
      for (let i = 0; i < 60; i++) {
        const char = TYPED[i % TYPED.length]!;
        await page.keyboard.press(char === " " ? "Space" : char);
        await sleep(WINDOW_MS / 60);
      }
    } else if (COND === "watch") {
      await sleep(WINDOW_MS);
    } else {
      // Fire and forget at 120 Hz, as a trackpad does: no wait on the renderer's ack.
      const cdp = await page.context().newCDPSession(page);
      const deltas = trackpadDeltas(Math.floor(WINDOW_MS / 8.33));
      const sent: Array<Promise<unknown>> = [];
      for (let i = 0; i < deltas.length; i++) {
        sent.push(cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: cx, y: cy, deltaX: 0, deltaY: deltas[i]! }).catch(() => undefined));
        const wait = windowStart + (i + 1) * 8.33 - Date.now();
        if (wait > 0) await sleep(wait);
      }
      await Promise.all(sent);
      await cdp.detach();
    }
    const windowS = (Date.now() - windowStart) / 1000;
    if (COND === "type-stall") {
      await junto.app.evaluate(() => clearInterval((globalThis as { __perfStall?: ReturnType<typeof setInterval> }).__perfStall));
    }
    const pings = (await pinger?.stop()) ?? [];
    await junto.app.evaluate(({ contentTracing }, path) => contentTracing.stopRecording(path), tracePath);
    const m1 = machine();

    const inPage = await page.evaluate(() => {
      const run = (window as unknown as Record<string, any>).__perfRun;
      run.stop = true;
      const frames: Array<[number, number]> = run.frames;
      const gaps = frames.slice(1).map((f, i) => f[0] - frames[i]![0]);
      const moved = frames.slice(1).filter((f, i) => f[1] !== frames[i]![1]).length;
      const longtasks: number[] = run.longtasks;
      return {
        echoParsed: run.echoParsed as number[],
        echoDrawn: run.echoDrawn as number[],
        rafFrames: frames.length,
        rafGaps: gaps,
        framesViewportMoved: run.probe ? moved : null,
        xtermRenders: run.probe ? run.probe.renders() - run.renders0 : null,
        longTasks: { count: longtasks.length, totalMs: Math.round(longtasks.reduce((a, b) => a + b, 0)), maxMs: Math.round(Math.max(0, ...longtasks)) },
      };
    });

    const trace = summarizeTrace(tracePath, windowS);
    if (!KEEP_TRACE) rmSync(tracePath, { force: true });
    // Name the heaviest painted nodes (trace node ids are backend node ids).
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.getDocument", { depth: -1 });
    const paintByNode = await Promise.all(trace.paintByNode.map(async (p) => {
      try {
        const { node } = (await cdp.send("DOM.describeNode", { backendNodeId: p.nodeId })) as { node: { nodeName: string; attributes?: string[] } };
        const attrs = node.attributes ?? [];
        const at = (k: string): string => (attrs.includes(k) ? attrs[attrs.indexOf(k) + 1]! : "");
        const id = at("id");
        const classes = at("class").split(" ").filter(Boolean).slice(0, 3).join(".");
        return { ...p, node: `${node.nodeName.toLowerCase()}${id ? `#${id}` : ""}${classes ? `.${classes}` : ""}` };
      } catch {
        return { ...p, node: "unresolved" };
      }
    }));
    await cdp.detach();

    const { rafGaps, echoParsed, echoDrawn, ...probe } = inPage;
    mkdirSync(join(OUT, ".."), { recursive: true });
    writeFileSync(OUT, JSON.stringify({
      condition: COND,
      windowS,
      board: { nodes: fixture.nodes.length, wires: fixture.wires.length },
      machine: { atStart: m0, atEnd: m1 },
      terminal,
      ...probe,
      raf: {
        gapMs: { p50: rafGaps.sort((a, b) => a - b)[Math.floor(rafGaps.length / 2)] ?? null, max: rafGaps.at(-1) ?? null },
        gapsOver12_5: rafGaps.filter((g) => g > 12.5).length,
        gapsOver16_7: rafGaps.filter((g) => g > 16.7).length,
        gapsOver33: rafGaps.filter((g) => g > 33.4).length,
      },
      // Typed keys only: keydown to echo parsed by xterm, and to the render pass that drew it.
      echoMs: echoDrawn.length ? { parsed: spread(echoParsed), drawn: spread(echoDrawn), missed: 60 - echoDrawn.length } : null,
      // Main-process event loop: work control socket ping round trips.
      mainLoop: pings.length ? { rttMs: spread(pings), over16_7: pings.filter((p) => p > 16.7).length, over50: pings.filter((p) => p > 50).length, stalledMsPerS: Math.round((pings.filter((p) => p > 8.3).reduce((a, b) => a + b, 0) / windowS) * 10) / 10 } : null,
      ...trace,
      paintByNode,
    }, null, 2));
  } finally {
    await junto.close();
  }
});
