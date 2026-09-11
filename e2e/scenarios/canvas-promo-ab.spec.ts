/**
 * Promotion A/B — is the busy-gate `will-change: transform` promotion still
 * earning its keep now that ViewportTransformLease holds the camera transform
 * in a paused Web Animation?
 *
 * Variants (addStyleTag override, app code untouched):
 *   busy-promoted         — stock behaviour: viewport promoted only while busy
 *                           (html[data-viewport-busy] rule from styles.css)
 *   will-change-suppressed— busy promotion suppressed for the whole run; the
 *                           transform lease stays mounted, so this isolates
 *                           the will-change hint, not the layer itself
 *   permanently-promoted  — the candidate fix: stable will-change regardless
 *                           of the busy gate
 *
 * Measurements per variant: continuous + bursty wheel pan windows sampled for
 * rAF gap / long tasks / busy flips / CDP Performance deltas (collection
 * enabled) + PAN-PROMO-AB evidence lines.
 *
 * Run: bun run test:e2e:fast e2e/scenarios/canvas-promo-ab.spec.ts
 */
import { agentTextNode, canvasDoc, tasksNode, verbEdge } from "../harness/sandbox";
import type { CanvasDoc, CanvasEdge, CanvasNode, TextNode } from "../../src/shared/canvas";
import { expect, test } from "../harness/launch";

const REGION = { width: 900, height: 560 };

const seat = (i: number): TextNode =>
  agentTextNode({ id: `seat${i}`, key: `local:ab-${i}`, label: `ab seat ${i}`, x: 0, y: 0 });
const place = (node: TextNode, at: { x: number; y: number }): TextNode => ({ ...node, x: at.x, y: at.y });

const buildField = (): CanvasDoc => {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const regions = [
    { id: "rg-a", at: { x: 0, y: 0 } },
    { id: "rg-b", at: { x: 1000, y: 0 } },
    { id: "rg-c", at: { x: 0, y: 640 } },
  ];
  const members: TextNode[] = [];
  let seatId = 0;
  const nextSeat = (): TextNode => seat(seatId++);
  for (const region of regions) {
    nodes.push({
      id: region.id,
      type: "group",
      label: region.id.replace("rg-", ""),
      x: region.at.x,
      y: region.at.y,
      width: REGION.width,
      height: REGION.height,
    });
    const nested = {
      id: `${region.id}-inner`,
      type: "group" as const,
      label: `${region.id}-inner`,
      x: region.at.x + 60,
      y: region.at.y + 320,
      width: 620,
      height: 200,
    };
    nodes.push(nested);
    for (let i = 0; i < 6; i += 1) {
      members.push(place(nextSeat(), {
        x: region.at.x + 40 + (i % 3) * 280,
        y: region.at.y + 60 + Math.floor(i / 3) * 130,
      }));
    }
    for (let i = 0; i < 2; i += 1) {
      members.push(place(nextSeat(), {
        x: nested.x + 40 + i * 280,
        y: nested.y + 60,
      }));
    }
  }
  const tasks = place(tasksNode({ id: "tasks", x: 1020, y: 700 }), { x: 1020, y: 700 });
  nodes.push(...members, tasks);
  for (const member of members) {
    edges.push(verbEdge(`e-${member.id}`, member.id, "tasks", "contributes", nodes));
  }
  return canvasDoc(nodes, edges);
};

const fixtureDoc = buildField();
const NODE_COUNT = fixtureDoc.nodes.length;

test.use({
  vellumOptions: { seedCanvases: { ab: fixtureDoc } },
});

type InPageSampler = {
  readonly begin: () => void;
  readonly end: () => Promise<{
    readonly frames: number;
    readonly maxGapMs: number;
    readonly longTasks: number;
    readonly busyFlips: number;
    readonly willChangeValues: readonly string[];
  }>;
};

const installSampler = async (page: import("@playwright/test").Page): Promise<void> => {
  await page.evaluate((): void => {
    const w = window as unknown as { __promoSampler?: InPageSampler };
    let frames = 0;
    let maxGap = 0;
    let last = 0;
    let running = false;
    let raf = 0;
    let busyFlips = 0;
    let lastBusy = false;
    let willChange = new Set<string>();
    let longTasks = 0;
    let observer: PerformanceObserver | undefined;
    let attrObserver: MutationObserver | undefined;
    w.__promoSampler = {
      begin: (): void => {
        frames = 0;
        maxGap = 0;
        busyFlips = 0;
        longTasks = 0;
        willChange = new Set();
        running = true;
        lastBusy = document.documentElement.hasAttribute("data-viewport-busy");
        last = performance.now();
        observer = new PerformanceObserver((list) => {
          longTasks += list.getEntries().length;
        });
        observer.observe({ entryTypes: ["longtask"] });
        // Busy gate only — a dedicated observer with attributeFilter, so the
        // census never counts attention-clock or other <html> attributes.
        attrObserver = new MutationObserver(() => {
          const busy = document.documentElement.hasAttribute("data-viewport-busy");
          if (busy !== lastBusy) {
            lastBusy = busy;
            busyFlips += 1;
          }
        });
        attrObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-viewport-busy"],
        });
        const loop = (): void => {
          if (!running) return;
          const now = performance.now();
          maxGap = Math.max(maxGap, now - last);
          last = now;
          frames += 1;
          const viewport = document.querySelector(".react-flow__viewport");
          if (viewport) willChange.add(getComputedStyle(viewport).willChange);
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      },
      end: async () => {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        observer?.disconnect();
        attrObserver?.disconnect();
        return {
          frames,
          maxGapMs: Math.round(maxGap),
          longTasks,
          busyFlips,
          willChangeValues: [...willChange],
        };
      },
    };
  });
};

async function wheelPan(page: import("@playwright/test").Page, ms: number, bursty: boolean): Promise<void> {
  const end = Date.now() + ms;
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(size.width / 2, size.height / 2);
  while (Date.now() < end) {
    const phase = (Date.now() % 4000) / 4000;
    await page.mouse.wheel(Math.cos(phase * Math.PI * 2) * 90, Math.sin(phase * Math.PI * 2) * 90);
    if (bursty) {
      await page.waitForTimeout(40);
      if (Date.now() % 640 < 260) continue;
      await page.waitForTimeout(300);
    } else {
      await page.waitForTimeout(12);
    }
  }
}

test.describe("viewport promotion A/B", () => {
  test.setTimeout(240_000);

  for (const variant of ["busy-promoted", "will-change-suppressed", "permanently-promoted"] as const) {
    test(`pan cost with ${variant} viewport promotion`, async ({ vellumCommand }) => {
      test.setTimeout(240_000);
      const { page } = vellumCommand;

      await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(".react-flow__node")).toHaveCount(NODE_COUNT, { timeout: 30_000 });
      await page.waitForTimeout(1_500);
      await page.mouse.move(4, 4);

      if (variant === "will-change-suppressed") {
        await page.addStyleTag({
          // suppress the busy-scoped promotion hint for this run; the
          // transform lease stays mounted, so this isolates the hint itself
          content: "html[data-viewport-busy] .react-flow .react-flow__viewport { will-change: auto !important; }",
        });
      } else if (variant === "permanently-promoted") {
        await page.addStyleTag({
          // the candidate fix: stable hint regardless of the busy gate
          content: ".react-flow .react-flow__viewport { will-change: transform !important; }",
        });
      }

      const cdp = await vellumCommand.app.context().newCDPSession(page);
      await cdp.send("Performance.enable");
      const results: Record<string, unknown> = {};

      for (const gesture of ["continuous", "bursty"] as const) {
        // settle between windows
        await page.waitForTimeout(1_200);
        const before = (await cdp.send("Performance.getMetrics")).metrics;
        await installSampler(page);
        await page.evaluate(() => (window as unknown as { __promoSampler: InPageSampler }).__promoSampler.begin());
        await wheelPan(page, 5_000, gesture === "bursty");
        await page.waitForTimeout(1_000);
        const sample = await page.evaluate(() => (window as unknown as { __promoSampler: InPageSampler }).__promoSampler.end());
        const after = (await cdp.send("Performance.getMetrics")).metrics;
        const delta = (name: string): number => {
          const b = before.find((m) => m.name === name)?.value;
          const a = after.find((m) => m.name === name)?.value;
          if (b === undefined || a === undefined) throw new Error(`metric ${name} missing — collection not enabled`);
          return Math.round((a - b) * 1000) / 1000;
        };
        const gestureResult = {
          ...sample,
          scriptDurationS: delta("ScriptDuration"),
          taskDurationS: delta("TaskDuration"),
          layoutCount: delta("LayoutCount"),
          recalcStyleCount: delta("RecalcStyleCount"),
        };
        results[gesture] = gestureResult;
        console.log(`PAN-PROMO-AB ${JSON.stringify({ variant, gesture, ...gestureResult })}`);
      }

      expect(Object.keys(results)).toHaveLength(2);
    });
  }
});
