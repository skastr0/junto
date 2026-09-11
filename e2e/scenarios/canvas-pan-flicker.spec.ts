/**
 * Pan-flicker evidence capture — a repeatable measurement, not a pass/fail gate.
 *
 * The operator reports that panning the canvas (especially with multiple and
 * nested regions) flickers: the screen flickers, nodes blink. This spec boots
 * the real app on a dense region-heavy fixture and captures, per gesture:
 *
 *   - CDP screencast frames (the compositor's own output, timestamped)
 *   - a per-frame rAF sample (timestamp, mounted .vellum-node count,
 *     html[data-viewport-busy] state)
 *   - DOM churn from a MutationObserver on the .react-flow subtree
 *     (childList adds/removes — the remint/blink signature)
 *   - attribute flips on <html> (viewport-busy latch) with timestamps — the
 *     compositor promote/de-promote signature
 *   - long tasks + CDP Performance.getMetrics deltas (Layout, RecalcStyle,
 *     Script, Task durations)
 *   - the app's own VELLUM_PERF counters (loom replans, route wires,
 *     activity mark mounts) via the in-page harness snapshot
 *
 * Each gesture keeps the window open 1.2s after the gesture so the busy-gate
 * release frame (the deferred-rebuild flush) lands inside the evidence window.
 *
 * Evidence lands in test-results/pan-flicker/<gesture>/ and is printed as one
 * grep-able PAN-FLICKER-EVIDENCE {json} line per gesture. Post-run, frames are
 * diffed (ImageMagick AE) and assembled into video for visual confirmation.
 *
 * Run: bun run test:e2e:fast e2e/scenarios/canvas-pan-flicker.spec.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanvasDoc, CanvasEdge, CanvasNode, TextNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc, tasksNode, verbEdge } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const OUT = join(process.cwd(), "test-results", "pan-flicker");
const GESTURE_MS = 6_000;
const RELEASE_SETTLE_MS = 1_200;

// --- fixture -----------------------------------------------------------------
//
// A real factory neighborhood, not a grid of notes: three regions, one nested
// region inside the first, and one double-nested region — the operator's
// "multiple regions, nested regions" shape. Alternating agent/task kinds keep
// every neighbouring pair wireable (agent → task `contributes`). Blocker flags
// run the heaviest continuous paint on the board.

const REGION = { width: 900, height: 560 };

const seat = (i: number): TextNode =>
  agentTextNode({
    id: `seat${i}`,
    key: `local:flick-${i}`,
    label: `flick seat ${i}`,
    x: 0,
    y: 0,
  });

type Placement = { readonly x: number; readonly y: number };
const place = (node: TextNode, at: Placement): TextNode => ({ ...node, x: at.x, y: at.y });

const buildField = (): CanvasDoc => {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  // Region Alpha — seats 0..5, one nested region (Bravo) holding seats 6..7.
  const alphaAt = { x: 0, y: 0 };
  const bravoAt = { x: alphaAt.x + 60, y: alphaAt.y + 300 };
  const charlieAt = { x: 1000, y: 0 };
  const deltaAt = { x: bravoAt.x + 60, y: bravoAt.y + 200 };

  const alphaMembers: TextNode[] = [];
  for (let i = 0; i < 6; i += 1) {
    alphaMembers.push(place(seat(i), {
      x: alphaAt.x + 40 + (i % 3) * 280,
      y: alphaAt.y + 60 + Math.floor(i / 3) * 140,
    }));
  }
  const bravoMembers: TextNode[] = [];
  for (let i = 6; i < 8; i += 1) {
    bravoMembers.push(place(seat(i), {
      x: bravoAt.x + 40 + (i % 2) * 260,
      y: bravoAt.y + 60,
    }));
  }
  const charlieMembers: TextNode[] = [];
  for (let i = 8; i < 14; i += 1) {
    charlieMembers.push(place(seat(i), {
      x: charlieAt.x + 40 + (i % 3) * 280,
      y: charlieAt.y + 60 + Math.floor(i / 3) * 140,
    }));
  }
  const deltaMembers: TextNode[] = [];
  for (let i = 14; i < 16; i += 1) {
    deltaMembers.push(place(seat(i), {
      x: deltaAt.x + 40 + (i % 2) * 240,
      y: deltaAt.y + 60,
    }));
  }

  const tasks = place(tasksNode({ id: "tasks", x: 1020, y: 620 }), { x: 1020, y: 620 });

  nodes.push(
    {
      id: "rg-alpha",
      type: "group",
      label: "alpha",
      x: alphaAt.x,
      y: alphaAt.y,
      width: REGION.width,
      height: REGION.height,
    },
    ...alphaMembers,
    {
      id: "rg-bravo",
      type: "group",
      label: "bravo",
      x: bravoAt.x,
      y: bravoAt.y,
      width: 620,
      height: 220,
    },
    ...bravoMembers,
    {
      id: "rg-charlie",
      type: "group",
      label: "charlie",
      x: charlieAt.x,
      y: charlieAt.y,
      width: REGION.width,
      height: REGION.height,
    },
    ...charlieMembers,
    {
      id: "rg-delta",
      type: "group",
      label: "delta",
      x: deltaAt.x,
      y: deltaAt.y,
      width: 560,
      height: 200,
    },
    ...deltaMembers,
    tasks,
  );

  // Wire every agent to the shared tasks sink: agent → task `contributes`.
  for (const member of [...alphaMembers, ...bravoMembers, ...charlieMembers, ...deltaMembers]) {
    edges.push(verbEdge(`e-${member.id}`, member.id, "tasks", "contributes", nodes));
  }
  return canvasDoc(nodes, edges);
};

const fixtureDoc = buildField();
const NODE_COUNT = fixtureDoc.nodes.length;
const EDGE_COUNT = fixtureDoc.edges.length;

test.use({
  vellumOptions: {
    seedCanvases: { flicker: fixtureDoc },
  },
});

// --- in-page instrumentation ---------------------------------------------------

type InPageEvidence = {
  readonly frames: number;
  readonly maxFrameGapMs: number;
  readonly longTasks: { readonly count: number; readonly totalMs: number; readonly maxMs: number };
  readonly dom: { readonly added: number; readonly removed: number; readonly samples: string[] };
  readonly busyFlips: readonly { readonly busy: boolean; readonly t: number }[];
  readonly perFrame: readonly {
    readonly t: number;
    readonly nodes: number;
    readonly busy: boolean;
  }[];
};

type EvidenceWindow = {
  readonly begin: () => void;
  readonly end: () => Promise<InPageEvidence>;
};

async function installEvidence(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as { VELLUM_PERF?: string }).VELLUM_PERF = "1";
  });
  // The perf flag resolved at module load — arm it before the app boots, then reload.
  await page.reload();
  await page.waitForFunction(
    () => (globalThis as { vellumCommandPerf?: { enabled: boolean } }).vellumCommandPerf?.enabled === true,
    undefined,
    { timeout: 15_000 },
  );
  await page.evaluate((): void => {
    const w = window as unknown as {
      __panEvidence?: EvidenceWindow;
    };
    const perFrame: { t: number; nodes: number; busy: boolean }[] = [];
    const busyFlips: { busy: boolean; t: number }[] = [];
    const dom = { added: 0, removed: 0, samples: [] as string[] };
    const longTasks = { count: 0, totalMs: 0, maxMs: 0 };
    let frames = 0;
    let lastFrameAt = performance.now();
    let maxGap = 0;
    let running = false;
    let raf = 0;
    let domObserver: MutationObserver | undefined;
    let attrObserver: MutationObserver | undefined;
    let taskObserver: PerformanceObserver | undefined;

    const sample = (): void => {
      perFrame.push({
        t: Math.round(performance.now()),
        nodes: document.querySelectorAll(".vellum-node").length,
        busy: document.documentElement.hasAttribute("data-viewport-busy"),
      });
    };

    const loop = (): void => {
      if (!running) return;
      const now = performance.now();
      maxGap = Math.max(maxGap, now - lastFrameAt);
      lastFrameAt = now;
      frames += 1;
      sample();
      raf = requestAnimationFrame(loop);
    };

    w.__panEvidence = {
      begin: (): void => {
        if (running) return;
        running = true;
        frames = 0;
        maxGap = 0;
        perFrame.length = 0;
        busyFlips.length = 0;
        dom.added = 0;
        dom.removed = 0;
        dom.samples.length = 0;
        longTasks.count = 0;
        longTasks.totalMs = 0;
        longTasks.maxMs = 0;

        domObserver = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node.nodeType === 1) dom.added += 1;
            }
            for (const node of record.removedNodes) {
              if (node.nodeType === 1) {
                dom.removed += 1;
                if (dom.samples.length < 40) {
                  const el = node as Element;
                  dom.samples.push(
                    `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`,
                  );
                }
              }
            }
          }
        });
        domObserver.observe(document.querySelector(".react-flow") ?? document.body, {
          childList: true,
          subtree: true,
        });

        attrObserver = new MutationObserver(() => {
          busyFlips.push({
            busy: document.documentElement.hasAttribute("data-viewport-busy"),
            t: Math.round(performance.now()),
          });
        });
        attrObserver.observe(document.documentElement, { attributes: true });

        taskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.count += 1;
            longTasks.totalMs += entry.duration;
            longTasks.maxMs = Math.max(longTasks.maxMs, entry.duration);
          }
        });
        taskObserver.observe({ entryTypes: ["longtask"] });

        lastFrameAt = performance.now();
        raf = requestAnimationFrame(loop);
      },
      end: async (): Promise<InPageEvidence> => {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        domObserver?.disconnect();
        attrObserver?.disconnect();
        taskObserver?.disconnect();
        // Dedupe per-frame busy states into flips.
        for (let i = 1; i < perFrame.length; i += 1) {
          if (perFrame[i]!.busy !== perFrame[i - 1]!.busy) {
            busyFlips.push({ busy: perFrame[i]!.busy, t: perFrame[i]!.t });
          }
        }
        return {
          frames,
          maxFrameGapMs: Math.round(maxGap),
          longTasks: {
            count: longTasks.count,
            totalMs: Math.round(longTasks.totalMs),
            maxMs: Math.round(longTasks.maxMs),
          },
          dom: { added: dom.added, removed: dom.removed, samples: [...dom.samples] },
          busyFlips: busyFlips.slice(0, 120),
          perFrame: perFrame.filter((_, i) => i % 2 === 0),
        };
      },
    };
  });
}

type CdpMetrics = Record<string, number>;

const metricsMap = (metrics: { name: string; value: number }[]): CdpMetrics =>
  metrics.reduce<CdpMetrics>((acc, m) => ({ ...acc, [m.name]: m.value }), {});

const metricsDelta = (before: CdpMetrics, after: CdpMetrics): CdpMetrics => {
  const keys = ["LayoutCount", "RecalcStyleCount", "ScriptDuration", "TaskDuration", "NodesAttached", "NodesDetached"];
  const out: CdpMetrics = {};
  for (const key of keys) out[key] = Math.round(((after[key] ?? 0) - (before[key] ?? 0)) * 1000) / 1000;
  return out;
};

// --- gestures -------------------------------------------------------------------

async function wheelPan(page: import("@playwright/test").Page, ms: number, bursty: boolean): Promise<void> {
  const end = Date.now() + ms;
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(size.width / 2, size.height / 2);
  while (Date.now() < end) {
    const phase = (Date.now() % 4000) / 4000;
    const dx = Math.cos(phase * Math.PI * 2) * 90;
    const dy = Math.sin(phase * Math.PI * 2) * 90;
    await page.mouse.wheel(dx, dy);
    if (bursty) {
      // ~250ms of wheel, ~350ms of idle — the shape that flaps a 160ms
      // end-hold latch.
      await page.waitForTimeout(40);
      if (Date.now() % 640 < 260) continue;
      await page.waitForTimeout(300);
    } else {
      await page.waitForTimeout(12);
    }
  }
}

async function middleDragPan(page: import("@playwright/test").Page): Promise<void> {
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  const cx = size.width / 2;
  const cy = size.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "middle" });
  for (let i = 0; i < 48; i += 1) {
    const phase = (i / 48) * Math.PI * 2;
    await page.mouse.move(cx + Math.cos(phase) * 180, cy + Math.sin(phase) * 180);
    await page.waitForTimeout(16);
  }
  await page.mouse.up({ button: "middle" });
}

// --- tests ------------------------------------------------------------------------

test.describe("canvas pan flicker evidence", () => {
  test.setTimeout(180_000);

  type Capture = { app: import("playwright-core").ElectronApplication; page: import("@playwright/test").Page };

  const capture = async (
    { app, page }: Capture,
    label: string,
    gesture: (page: import("@playwright/test").Page) => Promise<void>,
  ): Promise<void> => {
    const dir = join(OUT, label);
    await mkdir(dir, { recursive: true });

    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".react-flow__node")).toHaveCount(NODE_COUNT, { timeout: 30_000 });
    await expect(page.locator(".react-flow__edge")).toHaveCount(EDGE_COUNT, { timeout: 30_000 });

    // Settle the boot fitView before arming.
    await page.waitForTimeout(1_500);
    await page.mouse.move(4, 4);

    // CDP: screencast + metrics.
    const cdp = await app.context().newCDPSession(page);
    const frameRecords: { file: string; ts: number }[] = [];
    cdp.on(
      "Page.screencastFrame",
      (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
        const file = `f${String(frameRecords.length).padStart(5, "0")}.jpg`;
        writeFileSync(join(dir, file), Buffer.from(f.data, "base64"));
        frameRecords.push({ file, ts: f.metadata.timestamp ?? 0 });
        void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
      },
    );
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
    const metricsBefore = metricsMap((await cdp.send("Performance.getMetrics")).metrics);

    await page.evaluate(() => (window as unknown as { __panEvidence: EvidenceWindow }).__panEvidence.begin());
    await gesture(page);
    // Keep the evidence window open across the busy-gate release (160ms hold)
    // so the deferred-rebuild flush lands inside the capture.
    await page.waitForTimeout(RELEASE_SETTLE_MS);
    const evidence = await page.evaluate(
      () => (window as unknown as { __panEvidence: EvidenceWindow }).__panEvidence.end(),
    );
    const metricsAfter = metricsMap((await cdp.send("Performance.getMetrics")).metrics);
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    await page.waitForTimeout(400);

    const perfSnapshot = await page.evaluate(() => {
      const harness = (window as unknown as {
        vellumCommandPerf?: { snapshot?: () => unknown };
      }).vellumCommandPerf;
      return harness?.snapshot ? harness.snapshot() : undefined;
    });

    await writeFile(join(dir, "evidence.json"), JSON.stringify({ label, evidence, metrics: metricsDelta(metricsBefore, metricsAfter), perfSnapshot }, null, 2));
    await writeFile(
      join(dir, "frames-manifest.json"),
      JSON.stringify(frameRecords, null, 2),
    );

    const summary = {
      label,
      frames: frameRecords.length,
      rafSamples: evidence.frames,
      maxFrameGapMs: evidence.maxFrameGapMs,
      longTasks: evidence.longTasks,
      domAdded: evidence.dom.added,
      domRemoved: evidence.dom.removed,
      domSamples: evidence.dom.samples.slice(0, 8),
      busyFlips: evidence.busyFlips,
      metrics: metricsDelta(metricsBefore, metricsAfter),
    };
    console.log(`PAN-FLICKER-EVIDENCE ${JSON.stringify(summary)}`);

    expect(frameRecords.length).toBeGreaterThan(10);
  };

  test("wheel pan on a region-heavy canvas", async ({ vellumCommand }) => {
    const { app, page } = vellumCommand;
    await installEvidence(page);
    await capture({ app, page }, "wheel-pan", (p) => wheelPan(p, GESTURE_MS, false));
  });

  test("bursty wheel pan (flaps the busy latch)", async ({ vellumCommand }) => {
    const { app, page } = vellumCommand;
    await installEvidence(page);
    await capture({ app, page }, "wheel-pan-bursty", (p) => wheelPan(p, GESTURE_MS, true));
  });

  test("middle-button drag pan", async ({ vellumCommand }) => {
    const { app, page } = vellumCommand;
    await installEvidence(page);
    await capture({ app, page }, "middle-drag-pan", (p) => middleDragPan(p));
  });
});
