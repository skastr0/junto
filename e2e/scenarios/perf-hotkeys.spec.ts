/**
 * Hotkey performance probe: what every cmd+ chord costs on a factory-size
 * board, open → type → close, before and after a change. Measurement only —
 * no budgets, no assertions on timing. Skipped unless PERF_HOTKEYS=1.
 *
 *   PERF_HOTKEYS=1 scripts/run-e2e.sh e2e/scenarios/perf-hotkeys.spec.ts
 *
 * The board is the operator's shape, geometry only (e2e/fixtures/
 * perf-board-layout.json: 358 nodes, 841 wires), plus a handful of real-kind
 * nodes (artifacts, tasks, a page, files, automations, git, a terminal) so
 * the surface chords have something to act on, and open agent signals so the
 * feed and the palette standings have live data.
 *
 * Per chord, per rep: an in-page probe records long tasks, Event Timing
 * entries (keydown/keypress/input → next paint) and rAF frame gaps across
 * the whole open/type/close window; the app's own `operator-modal-open`
 * measure records ask→paint for the modal chords. Results land in
 * PERF_HOTKEYS_OUT (default /tmp/perf-hotkeys.json).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import type { AgentSignal } from "../../src/shared/agent-signals";
import type { Node as ModelNode, Wire as ModelWire } from "../../src/shared/model";
import { crewPlayFactory } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import {
  modelFixture,
  modelNote,
  modelRegion,
  modelSeat,
  modelTerminal,
  modelWire,
} from "../harness/model";

const OUT = process.env.PERF_HOTKEYS_OUT ?? "/tmp/perf-hotkeys.json";
const REPS = Number(process.env.PERF_HOTKEYS_REPS ?? "3");
const ONLY = process.env.PERF_HOTKEYS_ONLY?.split(",");
const CANVAS = "perf-hotkeys";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── the board ────────────────────────────────────────────────────────────────

type LaidOut = { kind: string; x: number; y: number; w: number; h: number; hold?: boolean };
const layout = JSON.parse(readFileSync(join(process.cwd(), "e2e/fixtures/perf-board-layout.json"), "utf8")) as {
  nodes: LaidOut[];
  wires: Array<[number, number]>;
};

const boardNodes: ModelNode[] = [];
layout.nodes.forEach((item, i) => {
  const id = `ly-${item.kind}-${String(i).padStart(3, "0")}`;
  if (item.kind === "agent") {
    boardNodes.push({
      ...modelSeat({ id, key: `local:${id}`, label: id, x: item.x, y: item.y }),
      width: item.w,
      height: item.h,
    } as ModelNode);
  } else if (item.kind === "region") {
    boardNodes.push(
      modelRegion({ id, label: `region ${String(i)}`, x: item.x, y: item.y, width: item.w, height: item.h, hold: item.hold === true }),
    );
  } else {
    boardNodes.push({ ...modelNote(id, `note ${String(i)}`, item.x, item.y), width: item.w, height: item.h } as ModelNode);
  }
});

const agentIds = boardNodes.filter((n) => n.kind === "agent").map((n) => n.id);

// Real-kind nodes the surface chords act on, parked past the board's edge.
const edgeX = Math.max(...boardNodes.map((n) => n.x + n.width)) + 200;
const extraNodes: ModelNode[] = [
  modelTerminal({ id: "hk-terminal", bindingId: "local:hk-terminal", label: "hk terminal", host: "this-mac", x: edgeX, y: 0 }),
];
const pairs = new Set<string>();
const boardWires: ModelWire[] = layout.wires.flatMap(([from, to], i) => {
  const a = boardNodes[from]!;
  const b = boardNodes[to]!;
  const pair = `${a.id}>${b.id}`;
  if (a.id === b.id || a.kind !== "agent" || b.kind !== "agent" || pairs.has(pair)) return [];
  pairs.add(pair);
  return [modelWire(`ly-wire-${String(i).padStart(3, "0")}`, a.id, b.id, "messages", boardNodes)];
});
// The staged seat keeps a couple of connections so rail/mirror chords have live targets.
const staged = agentIds[0]!;
const wired = agentIds.slice(1, 6);
const taken = new Set(boardWires.map((wire) => `${wire.from}>${wire.to}>${wire.verb}`));
const extraWire = (id: string, from: string, to: string): ModelWire | null => {
  const key = `${from}>${to}>messages`;
  if (taken.has(key)) return null;
  taken.add(key);
  return modelWire(id, from, to, "messages", [...boardNodes, ...extraNodes]);
};
const extraWires: ModelWire[] = [
  ...wired.map((id) => extraWire(`hk-wire-${id}`, staged, id)),
  ...agentIds.slice(6, 10).map((id) => extraWire(`hk-wire2-${id}`, id, staged)),
].filter((wire): wire is ModelWire => wire !== null);

const fixture = modelFixture(
  [...boardNodes.filter((n) => n.kind === "region"), ...boardNodes.filter((n) => n.kind !== "region"), ...extraNodes],
  [...boardWires, ...extraWires],
);

// Live signal data for the feed and the palette standings.
const SIGNAL_KINDS = ["blocked", "escalate", "feedback"] as const;
const signals: AgentSignal[] = agentIds.slice(0, 60).map((nodeId, i) => ({
  signalId: `hk-signal-${i}`,
  canvasName: CANVAS,
  nodeId,
  kind: SIGNAL_KINDS[i % 3]!,
  text: `Hotkey probe signal ${i}: needs a decision`,
  createdAt: 1_791_000_000_000 - i * 45_000,
  state: "open" as const,
}));

// ── the in-page probe ────────────────────────────────────────────────────────

const installProbe = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const w = window as unknown as { __hk: Record<string, unknown> };
    w.__hk = { lt: [] as number[], ev: [] as Array<{ n: string; d: number; s: number }>, frames: [] as number[] };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) (w.__hk.lt as number[]).push(Math.round(entry.duration * 10) / 10);
      }).observe({ type: "longtask", buffered: false });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const e = entry as PerformanceEventTiming;
          (w.__hk.ev as Array<{ n: string; d: number; s: number }>).push({
            n: e.name,
            d: Math.round(e.duration * 10) / 10,
            s: Math.round(e.startTime),
          });
        }
      }).observe({ type: "event", durationThreshold: 8, buffered: false } as PerformanceObserverInit);
    } catch {
      /* Event Timing unsupported: longtasks and frames still land. */
    }
    const tick = (t: number): void => {
      (w.__hk.frames as number[]).push(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

const resetProbe = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const w = window as unknown as { __hk: { lt: number[]; ev: unknown[]; frames: number[] } };
    w.__hk.lt.length = 0;
    w.__hk.ev.length = 0;
    w.__hk.frames.length = 0;
    performance.clearMeasures("operator-modal-open");
    performance.mark("hk-window");
  });

const readProbe = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __hk: { lt: number[]; ev: Array<{ n: string; d: number; s: number }>; frames: number[] };
    };
    const frames = w.__hk.frames;
    const gaps = frames.slice(1).map((f, i) => f - frames[i]!);
    const sorted = [...gaps].sort((a, b) => a - b);
    const q = (p: number): number | null =>
      sorted.length === 0 ? null : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! * 10) / 10;
    const byName = new Map<string, number[]>();
    for (const e of w.__hk.ev) {
      const list = byName.get(e.n) ?? [];
      list.push(e.d);
      byName.set(e.n, list);
    }
    const events: Record<string, { count: number; p50: number | null; p95: number | null; max: number | null; total: number }> = {};
    for (const [name, ds] of byName) {
      const s = [...ds].sort((a, b) => a - b);
      events[name] = {
        count: ds.length,
        p50: s[Math.floor(s.length / 2)] ?? null,
        p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? null,
        max: s.at(-1) ?? null,
        total: Math.round(ds.reduce((a, b) => a + b, 0) * 10) / 10,
      };
    }
    const lt = w.__hk.lt;
    return {
      longtasks: { count: lt.length, totalMs: Math.round(lt.reduce((a, b) => a + b, 0) * 10) / 10, maxMs: lt.length ? Math.max(...lt) : 0 },
      frames: {
        n: frames.length,
        gapP50: q(0.5),
        gapP95: q(0.95),
        gapMax: sorted.length ? Math.round(sorted.at(-1)! * 10) / 10 : null,
        over16_7: gaps.filter((g) => g > 16.7).length,
        over33: gaps.filter((g) => g > 33.4).length,
      },
      events,
      raw: w.__hk.ev.slice(0, 400),
      modalOpen: performance
        .getEntriesByType("measure")
        .filter((m) => m.name === "operator-modal-open")
        .map((m) => ({ modal: (m as PerformanceMeasure & { detail?: { modal?: string } }).detail?.modal ?? "?", ms: Math.round(m.duration * 10) / 10 })),
    };
  });

// ── scenarios ────────────────────────────────────────────────────────────────

type Scenario = {
  readonly id: string;
  /** The chord or gesture that opens the surface. */
  readonly open: (page: Page) => Promise<void>;
  /** Waits until the surface is provably up (falls back to a settle sleep). */
  readonly up?: (page: Page) => Promise<void>;
  /** What the operator does while it is open: text, or named keys at a cadence. */
  readonly type?: { readonly text?: string; readonly keys?: ReadonlyArray<string>; readonly perKeyMs?: number };
  /** The gesture that closes it. */
  readonly close: (page: Page) => Promise<void>;
  /** Waits until it is provably down. */
  readonly down?: (page: Page) => Promise<void>;
};

const visible = (page: Page, selector: string, timeout = 8_000) =>
  page.locator(selector).first().waitFor({ state: "visible", timeout });
const hidden = (page: Page, selector: string, timeout = 8_000) =>
  page.locator(selector).first().waitFor({ state: "hidden", timeout });

const typePhase = async (page: Page, type: Scenario["type"]): Promise<void> => {
  if (!type) return;
  const per = type.perKeyMs ?? 75;
  if (type.text) {
    for (const ch of type.text) {
      await page.keyboard.press(ch === " " ? "Space" : ch);
      await sleep(per);
    }
    return;
  }
  for (const key of type.keys ?? []) {
    await page.keyboard.press(key);
    await sleep(per);
  }
};

const chord = (combo: string) => (page: Page) => page.keyboard.press(combo);

const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    id: "cmd+k",
    open: chord("Meta+K"),
    up: (page) => visible(page, "[data-testid='command-bar-input']"),
    type: { text: "agents blocked waiting", perKeyMs: 70 },
    close: chord("Escape"),
    down: (page) => hidden(page, "[data-testid='command-bar-input']"),
  },
  {
    id: "cmd+k-actions",
    open: chord("Meta+K"),
    up: (page) => visible(page, "[data-testid='command-bar-input']"),
    type: { keys: ["Tab", "z", "u", "n", "d", "o"], perKeyMs: 70 },
    close: chord("Escape"),
    down: (page) => hidden(page, "[data-testid='command-bar-input']"),
  },
  {
    id: "cmd+i",
    open: chord("Meta+I"),
    up: (page) => visible(page, "[data-testid='operator-feed']"),
    type: { keys: ["j", "j", "j", "k", "1", "j"], perKeyMs: 90 },
    close: chord("Escape"),
    down: (page) => hidden(page, "[data-testid='operator-feed']"),
  },
  {
    id: "cmd+t",
    open: chord("Meta+T"),
    up: (page) => visible(page, ".quick-capture, [data-operator-modal='capture']"),
    type: { text: "capture note for the hotkey probe", perKeyMs: 70 },
    close: chord("Escape"),
    down: (page) => hidden(page, "[data-operator-modal='capture']"),
  },
  {
    id: "cmd+`",
    // Hold Cmd, tap backtick three times (each moves the strip), let Cmd go: commits.
    open: async (page) => {
      await page.keyboard.down("Meta");
      await page.keyboard.press("Backquote");
      await sleep(140);
      await page.keyboard.press("Backquote");
      await sleep(140);
      await page.keyboard.press("Backquote");
      await sleep(140);
      await page.keyboard.up("Meta");
    },
    up: (page) => visible(page, "[data-testid='focus-switcher'], .native-terminal-surface, [data-focus-surface]").catch(() => sleep(500)),
    close: chord("Meta+W"),
    down: async (page) => {
      await sleep(400);
    },
  },
  {
    id: "cmd+`-sweep",
    // Fast end to end: forty steps inside one Cmd hold, then release commits.
    // The strip's window must slide with the selection without a card ever
    // arriving late.
    open: async (page) => {
      await page.keyboard.down("Meta");
      for (let i = 0; i < 40; i += 1) {
        await page.keyboard.press("Backquote");
        await sleep(45);
      }
      await sleep(150);
      await page.keyboard.up("Meta");
    },
    up: (page) => visible(page, "[data-testid='focus-switcher'], .native-terminal-surface, [data-focus-surface]").catch(() => sleep(500)),
    close: chord("Meta+W"),
    down: async (page) => {
      await sleep(400);
    },
  },
  {
    // Control: an unbound key on the canvas (F2 only acts inside a sheet).
    // Whatever this costs is the dispatch + frame floor every hotkey pays
    // before its own work.
    id: "bare-f2",
    open: async (page) => {
      for (let i = 0; i < 40; i += 1) {
        await page.keyboard.press("F2");
        await sleep(45);
      }
    },
    up: async (page) => sleep(300),
    close: async () => sleep(50),
    down: async (page) => sleep(300),
  },
  {
    id: "cmd+`-cancel",
    open: async (page) => {
      await page.keyboard.down("Meta");
      await page.keyboard.press("Backquote");
      await sleep(200);
      await page.keyboard.press("Backquote");
      await sleep(200);
      await page.keyboard.press("Escape");
      await sleep(120);
      await page.keyboard.up("Meta");
    },
    up: async (page) => sleep(300),
    close: async () => sleep(50),
    down: (page) => hidden(page, "[data-testid='focus-switcher']"),
  },
  {
    id: "cmd+shift+`",
    open: async (page) => {
      await page.keyboard.down("Meta");
      await page.keyboard.down("Shift");
      await page.keyboard.press("Backquote");
      await sleep(160);
      await page.keyboard.press("Backquote");
      await sleep(160);
      await page.keyboard.up("Shift");
      await page.keyboard.up("Meta");
    },
    up: async (page) => sleep(300),
    close: async () => sleep(50),
    down: async (page) => sleep(300),
  },
  {
    id: "cmd+=-zoom",
    open: chord("Meta+Equal"),
    up: async (page) => sleep(250),
    type: { keys: ["Meta+Minus", "Meta+0", "Meta+Equal"], perKeyMs: 160 },
    close: async () => sleep(50),
    down: async (page) => sleep(250),
  },
  {
    id: "cmd+w-close",
    // Search open, then Cmd+W closes it: the close chord's own cost.
    open: chord("Meta+K"),
    up: (page) => visible(page, "[data-testid='command-bar-input']"),
    close: chord("Meta+W"),
    down: (page) => hidden(page, "[data-testid='command-bar-input']"),
  },
];

// Chords that need a working surface in front: staged once, before their reps.
const STAGED: ReadonlyArray<Scenario> = [
  {
    id: "cmd+enter-canvas",
    open: chord("Meta+Enter"),
    up: async (page) => sleep(300),
    close: async () => sleep(50),
    down: async (page) => sleep(300),
  },
  {
    id: "cmd+b-rail",
    open: chord("Meta+B"),
    up: async (page) => sleep(300),
    type: { keys: ["Meta+B", "Meta+B"], perKeyMs: 250 },
    close: async () => sleep(50),
    down: async (page) => sleep(300),
  },
  {
    id: "cmd+p-quickopen",
    open: chord("Meta+P"),
    up: (page) => visible(page, "[data-testid='quick-open-input'], .quick-open input, input[placeholder*='pen']").catch(() => sleep(500)),
    type: { text: "term", perKeyMs: 80 },
    close: chord("Escape"),
    down: async (page) => sleep(400),
  },
  {
    id: "cmd+g-git",
    open: chord("Meta+G"),
    up: async (page) => sleep(300),
    close: async () => sleep(50),
    down: async (page) => sleep(300),
  },
  {
    id: "cmd+brackets-mirror",
    open: chord("Meta+BracketRight"),
    up: async (page) => sleep(300),
    type: { keys: ["Meta+BracketLeft", "Meta+BracketRight"], perKeyMs: 220 },
    close: async () => sleep(50),
    down: async (page) => sleep(300),
  },
  {
    id: "cmd+z-undo",
    open: chord("Meta+Z"),
    up: async (page) => sleep(250),
    type: { keys: ["Meta+Shift+Z", "Meta+Z"], perKeyMs: 250 },
    close: async () => sleep(50),
    down: async (page) => sleep(250),
  },
  {
    id: "cmd+digit-groups",
    open: chord("Meta+1"),
    up: async (page) => sleep(300),
    type: { keys: ["Meta+2", "Meta+3", "Meta+1"], perKeyMs: 250 },
    close: async () => sleep(50),
    down: async (page) => sleep(300),
  },
  {
    id: "cmd+plus-zoom",
    open: chord("Meta+Shift+Equal"),
    up: async (page) => sleep(250),
    close: async () => sleep(50),
    down: async (page) => sleep(250),
  },
  {
    id: "cmd+shift+m-comments",
    open: chord("Meta+Shift+M"),
    up: async (page) => sleep(300),
    close: async () => sleep(50),
    down: async (page) => sleep(300),
  },
  {
    id: "cmd+s-files",
    open: chord("Meta+S"),
    up: async (page) => sleep(300),
    close: async () => sleep(50),
    down: async (page) => sleep(300),
  },
  {
    id: "cmd+r-page",
    open: chord("Meta+R"),
    up: async (page) => sleep(300),
    close: async () => sleep(50),
    down: async (page) => sleep(300),
  },
  {
    id: "cmd+l-page",
    open: chord("Meta+L"),
    up: async (page) => sleep(300),
    type: { text: "junto", perKeyMs: 80 },
    close: chord("Escape"),
    down: async (page) => sleep(300),
  },
  {
    id: "cmd+alt+arrow-panes",
    open: chord("Meta+Alt+ArrowRight"),
    up: async (page) => sleep(300),
    type: { keys: ["Meta+Alt+ArrowLeft", "Meta+Alt+ArrowRight"], perKeyMs: 250 },
    close: async () => sleep(50),
    down: async (page) => sleep(300),
  },
];

// Inside-surface chords, staged inside the modal that owns them.
const INSIDE: ReadonlyArray<{ id: string; stage: (page: Page) => Promise<void>; scenario: Scenario }> = [
  {
    id: "in-search-cmd+enter",
    stage: async (page) => {
      await page.keyboard.press("Meta+K");
      await visible(page, "[data-testid='command-bar-input']");
      await page.keyboard.type("ly-agent-0", { delay: 30 });
    },
    scenario: {
      id: "in-search-cmd+enter",
      open: chord("Meta+Enter"),
      up: async (page) => sleep(400),
      close: chord("Escape"),
      down: async (page) => sleep(400),
    },
  },
  {
    id: "in-capture-cmd+n",
    stage: async (page) => {
      await page.keyboard.press("Meta+T");
      await visible(page, "[data-operator-modal='capture']");
      await sleep(400);
    },
    scenario: {
      id: "in-capture-cmd+n",
      open: chord("Meta+N"),
      up: async (page) => sleep(400),
      type: { text: "second capture", perKeyMs: 70 },
      close: chord("Escape"),
      down: async (page) => sleep(400),
    },
  },
  {
    id: "in-capture-cmd+l",
    stage: async (page) => {
      await page.keyboard.press("Meta+T");
      await visible(page, "[data-operator-modal='capture']");
      await sleep(400);
    },
    scenario: {
      id: "in-capture-cmd+l",
      open: chord("Meta+L"),
      up: async (page) => sleep(300),
      type: { text: "ink", perKeyMs: 80 },
      close: chord("Escape"),
      down: async (page) => sleep(400),
    },
  },
];

// ── runner ───────────────────────────────────────────────────────────────────

test.skip(process.env.PERF_HOTKEYS !== "1", "run through PERF_HOTKEYS=1 scripts/run-e2e.sh e2e/scenarios/perf-hotkeys.spec.ts");

test("hotkey performance probe", async () => {
  test.setTimeout(20 * 60_000);
  const junto = await launchJunto({
    seedModels: { [CANVAS]: fixture },
    seedAgentSignals: signals,
    windowContentSize: { width: 1440, height: 900 },
  });
  const results: Record<string, unknown> = {};
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
    await installProbe(page);
    await page.reload();
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
    await crewPlayFactory(page);
    await sleep(1_500);

    // Stage a working surface once for the chords that need one in front:
    // command bar → the staged seat's name → Cmd+Enter opens it.
    await page.keyboard.press("Meta+K");
    await visible(page, "[data-testid='command-bar-input']");
    await page.keyboard.type(staged, { delay: 20 });
    await sleep(700);
    await page.keyboard.press("Meta+Enter");
    await sleep(1_800);
    // Put the keyboard back on the canvas chrome for the unstageable chords.
    await page.locator(".react-flow__pane").first().click({ position: { x: 8, y: 8 } }).catch(() => undefined);
    await sleep(400);

    // CPU-profile one switcher sweep: JS self-time per function. Native
    // style/layout/paint does not sample, so what is missing here is the
    // browser's share of the step.
    if (process.env.PERF_HOTKEYS_PROFILE === "sweep") {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      await cdp.send("Profiler.start");
      await resetProbe(page);
      await page.keyboard.down("Meta");
      for (let i = 0; i < 40; i += 1) {
        await page.keyboard.press("Backquote");
        await sleep(45);
      }
      await sleep(300);
      await page.keyboard.up("Meta");
      await sleep(400);
      const { profile } = (await cdp.send("Profiler.stop")) as {
        profile: {
          nodes: Array<{
            id: number;
            hitCount?: number;
            callFrame: { functionName: string; url: string; lineNumber: number };
            children?: number[];
          }>;
          samples?: number[];
          timeDeltas?: number[];
        };
      };
      const self = new Map<string, { hits: number; name: string; url: string; line: number }>();
      for (const node of profile.nodes) {
        const hits = node.hitCount ?? 0;
        if (hits === 0) continue;
        const cf = node.callFrame;
        const key = `${cf.functionName || "(anon)"} @ ${cf.url.split("/").pop()}:${cf.lineNumber + 1}`;
        const cur = self.get(key) ?? { hits: 0, name: cf.functionName || "(anon)", url: cf.url, line: cf.lineNumber + 1 };
        cur.hits += hits;
        self.set(key, cur);
      }
      const totalHits = [...self.values()].reduce((a, b) => a + b.hits, 0);
      const top = [...self.values()]
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 60)
        .map((s) => ({ ...s, pct: Math.round((s.hits / Math.max(1, totalHits)) * 1000) / 10 }));
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(
        OUT,
        JSON.stringify(
          {
            profile: "sweep",
            samples: profile.samples?.length ?? 0,
            totalHits,
            probe: await readProbe(page),
            top,
          },
          null,
          2,
        ),
      );
      return;
    }

    // Timeline trace of one sweep: names the native share per step —
    // UpdateLayoutTree elementCount, Layout dirty count, Paint,
    // PaintArtifactCompositor, and invalidation reasons. Starts well before
    // the sweep so its own start does not land inside a step.
    if (process.env.PERF_HOTKEYS_TRACE === "sweep") {
      const cdp = await page.context().newCDPSession(page);
      const chunks: unknown[] = [];
      cdp.on("Tracing.dataCollected", (e) => chunks.push(...((e as { value: unknown[] }).value ?? [])));
      const finished = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()));
      await cdp.send("Tracing.start", {
        categories: "toplevel,devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking,blink,cc",
        transferMode: "ReportEvents",
      });
      await sleep(1_200);
      await page.keyboard.down("Meta");
      for (let i = 0; i < 40; i += 1) {
        await page.keyboard.press("Backquote");
        await sleep(45);
      }
      await sleep(300);
      await page.keyboard.up("Meta");
      await sleep(400);
      await cdp.send("Tracing.end");
      await finished;
      await sleep(300);
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, JSON.stringify({ trace: "sweep", events: chunks }, null, 1));
      return;
    }

    const runScenario = async (scenario: Scenario): Promise<unknown[]> => {
      const reps: unknown[] = [];
      for (let rep = 0; rep < REPS; rep += 1) {
        await resetProbe(page);
        await scenario.open(page);
        if (scenario.up) await scenario.up(page).catch(() => sleep(400));
        else await sleep(400);
        await typePhase(page, scenario.type);
        await scenario.close(page);
        if (scenario.down) await scenario.down(page).catch(() => sleep(400));
        else await sleep(400);
        reps.push(await readProbe(page));
      }
      return reps;
    };

    const wanted = (id: string): boolean => ONLY === undefined || ONLY.includes(id);

    for (const scenario of [...SCENARIOS, ...STAGED]) {
      if (!wanted(scenario.id)) continue;
      results[scenario.id] = await runScenario(scenario);
    }
    for (const entry of INSIDE) {
      if (!wanted(entry.id)) continue;
      await entry.stage(page);
      await sleep(300);
      results[entry.id] = await runScenario(entry.scenario);
      // Leave the staged modal the way the next stage expects: closed.
      await page.keyboard.press("Escape");
      await sleep(400);
    }

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          canvas: CANVAS,
          board: { nodes: fixture.nodes.length, wires: fixture.wires.length, agents: agentIds.length, signals: signals.length },
          reps: REPS,
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    await junto.close();
  }
});
