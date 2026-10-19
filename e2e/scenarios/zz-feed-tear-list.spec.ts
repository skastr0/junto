/**
 * Feed tear, the list's side: what the Needs you list itself does while it
 * scrolls. A measurement, not a gate; it always passes once it has measured.
 *   scripts/run-e2e.sh --workers=1 e2e/scenarios/zz-feed-tear-list.spec.ts
 *
 * The operator's display (1726x1083 pt at 2x), a busy canvas: 36 seats, every
 * one working (its ring turns), and 36 open signals in the feed. Two boards
 * that differ only in where the seats sit:
 *   regions  six regions of six, so the list has six sticky region headers
 *   one      one region of 36, so the list has one
 * Each board scrolls the list with the wheel (down, then up) and with j/k.
 * Rings are never stilled or slowed (motion law): every variant runs them.
 *
 * Per gesture, into test-results/feed-tear-list/<board>-<gesture>/:
 *   - CDP screencast frames (the compositor's own output), a recording
 *   - layer churn: LayerTree updates, and the layer count low and high
 *   - the compositing reasons of the scroller, the sticky headers and the
 *     ring parts in the list (is the list scrolled on the compositor?)
 *   - ring part toggles: data-mark-visible flips inside the list, per frame
 *   - main thread: frame gaps, long tasks, layout and style counts and time
 * One FEED-TEAR-LIST {json} line per gesture.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import type { AgentSignal } from "../../src/shared/agent-signals";
import type { Node } from "../../src/shared/model";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";
import { OPERATOR_DISPLAY } from "../harness/nested-canvas-fixture";
import { expect, launchJunto, test } from "../harness/launch";

const OUT = join(process.cwd(), "test-results", "feed-tear-list");
const CANVAS = "feed-tear";
const SEATS = 36;

type Board = "regions" | "one";

const boardNodes = (board: Board): Node[] => {
  const regions =
    board === "regions"
      ? Array.from({ length: 6 }, (_, r) =>
          modelRegion({ id: `r${r}`, label: `Region ${r + 1}`, color: String((r % 6) + 1), x: (r % 3) * 1700, y: Math.floor(r / 3) * 900, width: 1600, height: 800 }),
        )
      : [modelRegion({ id: "r0", label: "All seats", color: "4", x: 0, y: 0, width: 5000, height: 1800 })];
  const seats = Array.from({ length: SEATS }, (_, n) => {
    const r = board === "regions" ? Math.floor(n / 6) : 0;
    const k = board === "regions" ? n % 6 : n;
    const ox = board === "regions" ? (r % 3) * 1700 : 0;
    const oy = board === "regions" ? Math.floor(r / 3) * 900 : 0;
    const cols = board === "regions" ? 3 : 12;
    return modelSeat({ id: `s${n}`, harness: n % 2 === 0 ? "claude" : "codex", x: ox + 60 + (k % cols) * 300, y: oy + 80 + Math.floor(k / cols) * 200 });
  });
  return [...regions, ...seats];
};

const signals = (): AgentSignal[] =>
  Array.from({ length: SEATS }, (_, n) => ({
    signalId: `t${n}`,
    canvasName: CANVAS,
    nodeId: `s${n}`,
    kind: (["feedback", "blocked", "escalate"] as const)[n % 3]!,
    text: `s${n} has a change ready: the parser now keeps comments, and the tests cover the three cases we saw.`,
    createdAt: Date.now() - (90 - n) * 60_000,
    state: "open",
  }));

/** Every seat working, so every ring turns, on the canvas and in the list. */
const ringAll = async (app: import("@playwright/test").ElectronApplication): Promise<void> => {
  const keys = Array.from({ length: SEATS }, (_, n) => `local:s${n}`);
  await app.evaluate(({ BrowserWindow }, { keys, at }) => {
    for (const window of BrowserWindow.getAllWindows())
      for (const bindingId of keys)
        window.webContents.send("junto:agent-seat-state-changed", { bindingId, epoch: "e2e", state: "working", reason: "rule:osc_title_working", confidence: "high", at });
  }, { keys, at: Date.now() });
};

type LayerNode = { readonly layerId: string; readonly backendNodeId?: number };

/** Which list elements own a compositor layer, and why. */
const layerReasons = async (cdp: CDPSession, layers: ReadonlyArray<LayerNode>) => {
  const owned = layers.filter((layer) => layer.backendNodeId !== undefined);
  const out: Record<string, string[]> = {};
  for (const layer of owned) {
    const described = await cdp.send("DOM.describeNode", { backendNodeId: layer.backendNodeId! }).catch(() => undefined);
    const attrs = described?.node.attributes ?? [];
    const cls = attrs[attrs.indexOf("class") + 1] ?? "";
    if (attrs.indexOf("class") === -1) continue;
    const name = cls.split(/\s+/u).find((c) => /operator-feed__(scroll|region-head|detail-scroll|panel)|junto-mark__part|operator-modal|focus-surface/u.test(c));
    if (!name) continue;
    const reasons = await cdp.send("LayerTree.compositingReasons", { layerId: layer.layerId }).catch(() => undefined);
    const key = `${name}`;
    out[key] ??= [];
    for (const reason of reasons?.compositingReasonIds ?? reasons?.compositingReasons ?? []) if (!out[key].includes(reason)) out[key].push(reason);
    if (!out[key].length) out[key].push("(none reported)");
  }
  return out;
};

const metricsOf = async (cdp: CDPSession): Promise<Record<string, number>> => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
};

const measure = async (page: Page, cdp: CDPSession, tag: string, gesture: () => Promise<void>) => {
  const dir = join(OUT, tag);
  await mkdir(dir, { recursive: true });
  let updates = 0;
  let low = Infinity;
  let high = 0;
  let last: ReadonlyArray<LayerNode> = [];
  const onLayers = (event: { layers?: LayerNode[] }) => {
    if (!event.layers) return;
    updates += 1;
    low = Math.min(low, event.layers.length);
    high = Math.max(high, event.layers.length);
    last = event.layers;
  };
  cdp.on("LayerTree.layerTreeDidChange", onLayers);
  const frames: { t: number; data: string }[] = [];
  const onFrame = (event: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    frames.push({ t: event.metadata.timestamp ?? 0, data: event.data });
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
  };
  cdp.on("Page.screencastFrame", onFrame);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
  await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>("[data-testid='operator-feed']")!;
    const probe = { frames: [] as number[], toggles: 0, togglesByFrame: [] as number[], longTasks: [] as number[], stop: false };
    let pending = 0;
    new MutationObserver((records) => {
      for (const r of records) if (r.attributeName === "data-mark-visible") pending += 1;
    }).observe(list, { attributes: true, subtree: true, attributeFilter: ["data-mark-visible"] });
    new PerformanceObserver((entries) => {
      for (const e of entries.getEntries()) probe.longTasks.push(e.duration);
    }).observe({ type: "longtask" });
    const tick = (t: number) => {
      probe.frames.push(t);
      probe.togglesByFrame.push(pending);
      probe.toggles += pending;
      pending = 0;
      if (!probe.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    (window as unknown as { __tear: typeof probe }).__tear = probe;
  });
  const before = await metricsOf(cdp);
  await gesture();
  await page.waitForTimeout(600);
  const after = await metricsOf(cdp);
  const inPage = await page.evaluate(() => {
    const probe = (window as unknown as { __tear: { frames: number[]; toggles: number; togglesByFrame: number[]; longTasks: number[]; stop: boolean } }).__tear;
    probe.stop = true;
    const gaps = probe.frames.slice(1).map((t, i) => t - probe.frames[i]!);
    const list = document.querySelector<HTMLElement>("[data-testid='operator-feed']")!;
    return {
      frames: probe.frames.length,
      maxFrameGapMs: Math.round(Math.max(0, ...gaps)),
      framesOver20ms: gaps.filter((g) => g > 20).length,
      markToggles: probe.toggles,
      framesWithToggles: probe.togglesByFrame.filter((n) => n > 0).length,
      longTasks: { count: probe.longTasks.length, maxMs: Math.round(Math.max(0, ...probe.longTasks)) },
      visibleMarksInList: list.querySelectorAll(".junto-mark[data-mark-visible]").length,
      marksInList: list.querySelectorAll(".junto-mark").length,
      stickyHeads: list.querySelectorAll(".operator-feed__region-head").length,
      scrollTop: Math.round(list.scrollTop),
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
    };
  });
  await cdp.send("Page.stopScreencast");
  cdp.off("Page.screencastFrame", onFrame);
  cdp.off("LayerTree.layerTreeDidChange", onLayers);
  const reasons = await layerReasons(cdp, last);
  const delta = (name: string): number => Math.round(((after[name] ?? 0) - (before[name] ?? 0)) * (name.endsWith("Duration") ? 1000 : 1));
  for (const [i, frame] of frames.entries()) await writeFile(join(dir, `frame-${String(i).padStart(4, "0")}.jpg`), Buffer.from(frame.data, "base64"));
  const evidence = {
    tag,
    screencastFrames: frames.length,
    layers: { updates, low: low === Infinity ? 0 : low, high },
    compositingReasons: reasons,
    main: { layoutCount: delta("LayoutCount"), recalcStyleCount: delta("RecalcStyleCount"), layoutMs: delta("LayoutDuration"), styleMs: delta("RecalcStyleDuration"), scriptMs: delta("ScriptDuration") },
    ...inPage,
  };
  await writeFile(join(dir, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`FEED-TEAR-LIST ${JSON.stringify(evidence)}`);
  return evidence;
};

for (const board of ["regions", "one"] as const) {
  test(`the list while it scrolls, ${board}`, async () => {
    test.setTimeout(240_000);
    await mkdir(OUT, { recursive: true });
    const junto = await launchJunto({
      ...OPERATOR_DISPLAY,
      seedModels: { [CANVAS]: modelFixture(boardNodes(board), []) },
      seedAgentSignals: signals(),
    });
    try {
      const { app, page } = junto;
      await expect(page.getByTestId("rf__node-s0")).toBeVisible({ timeout: 30_000 });
      await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
      await ringAll(app);
      await page.waitForTimeout(800);
      await page.keyboard.press("Meta+I");
      const list = page.getByTestId("operator-feed");
      await expect(list).toBeVisible({ timeout: 10_000 });
      await expect(list.getByTestId("operator-feed-card")).toHaveCount(SEATS, { timeout: 10_000 });
      expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight * 2)).toBe(true);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("DOM.getDocument", { depth: -1 });
      await cdp.send("LayerTree.enable");
      await cdp.send("Performance.enable", { timeDomain: "timeTicks" });
      await page.waitForTimeout(500);

      const box = (await list.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await measure(page, cdp, `${board}-wheel`, async () => {
        for (let i = 0; i < 60; i += 1) {
          await page.mouse.wheel(0, 40);
          await page.waitForTimeout(16);
        }
        for (let i = 0; i < 60; i += 1) {
          await page.mouse.wheel(0, -40);
          await page.waitForTimeout(16);
        }
      });

      await list.getByTestId("operator-feed-card").first().click();
      await page.mouse.move(4, 4);
      await measure(page, cdp, `${board}-jk`, async () => {
        for (let i = 0; i < SEATS - 1; i += 1) {
          await page.keyboard.press("j");
          await page.waitForTimeout(50);
        }
        for (let i = 0; i < SEATS - 1; i += 1) {
          await page.keyboard.press("k");
          await page.waitForTimeout(50);
        }
      });
    } finally {
      await junto.close();
    }
  });
}
