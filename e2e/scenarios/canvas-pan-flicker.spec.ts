/**
 * Pan-flicker evidence capture — a repeatable measurement, not a pass/fail gate.
 *
 * The operator reports that panning the canvas (especially with multiple and
 * nested regions) flickers: the screen flickers, nodes blink. This spec boots
 * the real app on a dense region-heavy fixture and captures, per gesture:
 *
 *   - CDP screencast frames (the compositor's own output, timestamped)
 *   - a per-frame rAF sample (timestamp, mounted .vellum-node count,
 *     html[data-viewport-busy] state, computed will-change on the viewport)
 *   - DOM churn from a MutationObserver on the .react-flow subtree
 *     (childList adds/removes — the remint/blink signature)
 *   - html[data-viewport-busy] attribute transitions, deduped, from a
 *     dedicated observer (attributeFilter — not every <html> attribute, and
 *     never merged with the rAF-derived transitions, which live separately)
 *   - long tasks + CDP Performance.getMetrics deltas (metrics collection is
 *     explicitly enabled; absent metric names fail the run instead of
 *     reading as zero)
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
// A real factory neighborhood, not a grid of notes: a genuinely nested
// geography — alpha contains bravo, bravo contains delta — plus a sibling
// region charlie. Blocker flags run the heaviest continuous paint on the
// board.

const seat = (id: string, keyIndex: number): TextNode =>
  agentTextNode({
    id,
    key: `local:flick-${keyIndex}`,
    label: `flick seat ${keyIndex}`,
    x: 0,
    y: 0,
  });

type Placement = { readonly x: number; readonly y: number };
const place = (node: TextNode, at: Placement): TextNode => ({ ...node, x: at.x, y: at.y });

const buildField = (): CanvasDoc => {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  // Geography: alpha ⊃ bravo ⊃ delta, charlie standalone.
  const alphaAt = { x: 0, y: 0 };
  const bravoAt = { x: 60, y: 300 };
  const deltaAt = { x: bravoAt.x + 40, y: bravoAt.y + 110 };
  const charlieAt = { x: 1000, y: 0 };

  let seatIndex = 0;
  const cluster = (
    id: string,
    label: string,
    at: Placement,
    width: number,
    height: number,
    seats: number,
    columns: number,
  ): TextNode[] => {
    nodes.push({ id, type: "group", label, x: at.x, y: at.y, width, height });
    const members: TextNode[] = [];
    for (let i = 0; i < seats; i += 1) {
      members.push(place(seat(`${id}-s${i}`, seatIndex++), {
        x: at.x + 30 + (i % columns) * 270,
        y: at.y + 56 + Math.floor(i / columns) * 130,
      }));
    }
    nodes.push(...members);
    return members;
  };

  // 8 seats in alpha (above the nested bravo strip).
  const alphaMembers = cluster("rg-alpha", "alpha", alphaAt, 900, 560, 8, 3);
  // 3 seats in bravo (which nests inside alpha, containing delta).
  const bravoMembers = cluster("rg-bravo", "bravo", bravoAt, 640, 240, 3, 3);
  // 2 seats in delta (double-nested).
  const deltaMembers = cluster("rg-delta", "delta", deltaAt, 560, 120, 2, 2);
  // 6 seats in charlie (sibling region).
  const charlieMembers = cluster("rg-charlie", "charlie", charlieAt, 900, 560, 6, 3);

  const tasks = place(tasksNode({ id: "tasks", x: 1020, y: 620 }), { x: 1020, y: 620 });
  nodes.push(tasks);

  // Wire every agent to the shared tasks sink: agent → task `contributes`.
  for (const member of [...alphaMembers, ...bravoMembers, ...deltaMembers, ...charlieMembers]) {
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
  /** Deduped html[data-viewport-busy] attribute transitions (observer). */
  readonly busyFlips: readonly { readonly busy: boolean; readonly t: number }[];
  /**
   * Busy-state transitions seen by the rAF sampler — kept SEPARATE from the
   * observer census so the two instruments never double-count.
   */
  readonly rafBusyTransitions: readonly { readonly busy: boolean; readonly t: number }[];
  /** Computed will-change of .react-flow__viewport, sampled on the rAF loop. */
  readonly willChangeValues: readonly string[];
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
    const willChangeValues: string[] = [];
    const busyFlips: { busy: boolean; t: number }[] = [];
    const rafBusyTransitions: { busy: boolean; t: number }[] = [];
    const dom = { added: 0, removed: 0, samples: [] as string[] };
    const longTasks = { count: 0, totalMs: 0, maxMs: 0 };
    let frames = 0;
    let lastFrameAt = performance.now();
    let maxGap = 0;
    let lastBusy = false;
    let running = false;
    let raf = 0;
    let domObserver: MutationObserver | undefined;
    let busyObserver: MutationObserver | undefined;
    let taskObserver: PerformanceObserver | undefined;

    const sample = (): void => {
      const busy = document.documentElement.hasAttribute("data-viewport-busy");
      perFrame.push({
        t: Math.round(performance.now()),
        nodes: document.querySelectorAll(".vellum-node").length,
        busy,
      });
      if (busy !== lastBusy) {
        lastBusy = busy;
        rafBusyTransitions.push({ busy, t: Math.round(performance.now()) });
      }
      if (frames % 10 === 0) {
        const viewport = document.querySelector(".react-flow__viewport");
        willChangeValues.push(
          viewport ? getComputedStyle(viewport).willChange : "(missing)",
        );
      }
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
        willChangeValues.length = 0;
        busyFlips.length = 0;
        rafBusyTransitions.length = 0;
        lastBusy = document.documentElement.hasAttribute("data-viewport-busy");
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

        // Busy gate only — never the attention-clock attributes, never a
        // merged stream: the census must count busy transitions and nothing
        // else.
        busyObserver = new MutationObserver(() => {
          const busy = document.documentElement.hasAttribute("data-viewport-busy");
          const previous = busyFlips[busyFlips.length - 1];
          if (previous && previous.busy === busy) return;
          busyFlips.push({ busy, t: Math.round(performance.now()) });
        });
        busyObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-viewport-busy"],
        });

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
        busyObserver?.disconnect();
        taskObserver?.disconnect();
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
          rafBusyTransitions: rafBusyTransitions.slice(0, 120),
          willChangeValues: [...new Set(willChangeValues)],
          perFrame: perFrame.filter((_, i) => i % 2 === 0),
        };
      },
    };
  });
}

// CDP performance metrics: collection must be enabled or Chromium 150 returns
// an empty metric list — which must fail the run, never read as zeros.
const METRIC_KEYS = ["LayoutCount", "RecalcStyleCount", "ScriptDuration", "TaskDuration"] as const;

type CdpMetrics = Record<string, number>;

const readMetrics = async (cdp: import("playwright-core").CDPSession): Promise<CdpMetrics> => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const map = metrics.reduce<CdpMetrics>((acc, m) => ({ ...acc, [m.name]: m.value }), {});
  const missing = METRIC_KEYS.filter((key) => map[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`Performance.getMetrics missing ${missing.join(", ")} — collection not enabled`);
  }
  return map;
};

const metricsDelta = (before: CdpMetrics, after: CdpMetrics): CdpMetrics => {
  const out: CdpMetrics = {};
  for (const key of METRIC_KEYS) out[key] = Math.round(((after[key] ?? 0) - (before[key] ?? 0)) * 1000) / 1000;
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

    // CDP: screencast + metrics (collection explicitly enabled).
    const cdp = await app.context().newCDPSession(page);
    await cdp.send("Performance.enable");
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
    const metricsBefore = await readMetrics(cdp);

    await page.evaluate(() => (window as unknown as { __panEvidence: EvidenceWindow }).__panEvidence.begin());
    await gesture(page);
    // Keep the evidence window open across the busy-gate release (160ms hold)
    // so the deferred-rebuild flush lands inside the capture.
    await page.waitForTimeout(RELEASE_SETTLE_MS);
    const evidence = await page.evaluate(
      () => (window as unknown as { __panEvidence: EvidenceWindow }).__panEvidence.end(),
    );
    const metricsAfter = await readMetrics(cdp);
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
      rafBusyTransitions: evidence.rafBusyTransitions,
      willChangeValues: evidence.willChangeValues,
      metrics: metricsDelta(metricsBefore, metricsAfter),
    };
    console.log(`PAN-FLICKER-EVIDENCE ${JSON.stringify(summary)}`);

    expect(frameRecords.length).toBeGreaterThan(10);
    // The one invariant the flicker fix owns: the viewport's will-change hint
    // must never change during a pan gesture.
    expect(
      evidence.willChangeValues,
      "computed will-change on .react-flow__viewport changed mid-gesture",
    ).toHaveLength(1);
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
