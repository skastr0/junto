/**
 * Shared pan-flicker evidence capture — used by canvas-pan-flicker.spec.ts
 * (standard fixture) and canvas-pan-flicker-dense.spec.ts (100-node,
 * six-region stress fixture).
 *
 * A repeatable measurement, not a pass/fail gate. Per gesture it captures:
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
 * grep-able PAN-FLICKER-EVIDENCE {json} line per gesture.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";

const OUT = join(process.cwd(), "test-results", "pan-flicker");
const RELEASE_SETTLE_MS = 1_200;

export type InPageEvidence = {
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

export async function installEvidence(page: import("@playwright/test").Page): Promise<void> {
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

export async function wheelPan(
  page: import("@playwright/test").Page,
  ms: number,
  bursty: boolean,
  radius = 90,
): Promise<void> {
  const end = Date.now() + ms;
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(size.width / 2, size.height / 2);
  while (Date.now() < end) {
    const phase = (Date.now() % 4000) / 4000;
    const dx = Math.cos(phase * Math.PI * 2) * radius;
    const dy = Math.sin(phase * Math.PI * 2) * radius;
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

export async function middleDragPan(page: import("@playwright/test").Page, radius = 180, steps = 48): Promise<void> {
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  const cx = size.width / 2;
  const cy = size.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "middle" });
  for (let i = 0; i < steps; i += 1) {
    const phase = (i / steps) * Math.PI * 2;
    await page.mouse.move(cx + Math.cos(phase) * radius, cy + Math.sin(phase) * radius);
    await page.waitForTimeout(16);
  }
  await page.mouse.up({ button: "middle" });
}

/**
 * Zoom the camera out to React Flow's minZoom by dispatching ctrl-keyed wheel
 * events on the pane. With panOnScroll, xyflow routes ctrl+wheel through the
 * pinch path (scaleTo), so a positive deltaY zooms out. Resolves once the
 * viewport transform's scale stops shrinking or falls to the target.
 */
export async function zoomOutToTarget(page: import("@playwright/test").Page, target: number): Promise<number> {
  // Everything runs in-page: read the viewport scale, dispatch ctrl-keyed
  // wheel events (xyflow's pinch path under panOnScroll), repeat until the
  // scale reaches the target or the event budget is spent. The event carries
  // real client coordinates — xyflow anchors the pinch zoom at the pointer,
  // and a synthetic event without them zooms around a degenerate point.
  return page.evaluate((targetZoom): Promise<number> => {
    const readScale = (): number => {
      const viewport = document.querySelector(".react-flow__viewport");
      const matrix = viewport ? getComputedStyle(viewport).transform : "";
      const m = matrix.match(/matrix\(([^)]+)\)/);
      const a = m ? Number(m[1]!.split(",")[0]) : 1;
      return Number.isFinite(a) && a > 0 ? a : 1;
    };
    const readTranslate = (): { x: number; y: number } => {
      const viewport = document.querySelector(".react-flow__viewport");
      const matrix = viewport ? getComputedStyle(viewport).transform : "";
      const m = matrix.match(/matrix\(([^)]+)\)/);
      const parts = m ? m[1]!.split(",").map((v) => Number(v.trim())) : [];
      const x = parts[4] ?? 0;
      const y = parts[5] ?? 0;
      return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
    };
    const anchor = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    for (let i = 0; i < 80; i += 1) {
      if (readScale() <= targetZoom + 0.005) break;
      document
        .querySelector(".react-flow__pane")
        ?.dispatchEvent(
          new WheelEvent("wheel", {
            deltaX: 0,
            deltaY: 240,
            ctrlKey: true,
            clientX: anchor.x,
            clientY: anchor.y,
            bubbles: true,
            cancelable: true,
          }),
        );
      const next = readTranslate();
      // A degenerate anchor poisons the translate (NaN). Bail out rather
      // than pan a camera whose transform no longer points at the board.
      if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) break;
    }
    return Promise.resolve(readScale());
  }, target).then(async (scale) => {
    // Give the last zoom transitions a beat to paint before the caller asserts.
    await page.waitForTimeout(600);
    return scale;
  });
}

// --- capture ---------------------------------------------------------------------

export type CaptureArgs = {
  readonly app: import("playwright-core").ElectronApplication;
  readonly page: import("@playwright/test").Page;
  readonly nodeCount: number;
  readonly edgeCount: number;
};

export const capture = async (
  { app, page, nodeCount, edgeCount }: CaptureArgs,
  label: string,
  gesture: (page: import("@playwright/test").Page) => Promise<void>,
): Promise<void> => {
  const dir = join(OUT, label);
  await mkdir(dir, { recursive: true });

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".react-flow__node")).toHaveCount(nodeCount, { timeout: 30_000 });
  await expect(page.locator(".react-flow__edge")).toHaveCount(edgeCount, { timeout: 30_000 });

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
