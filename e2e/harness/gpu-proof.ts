/**
 * Real-Electron proof harness for the GPU canvas (#913).
 *
 * The proof runs the same real app on three board sizes: the factory board
 * (1x) and that board tiled 10 and 100 times, with the same cards, regions
 * and wires in every tile. Nothing here fakes a device, a hook or a pixel:
 * the numbers come from the shipped `window.__juntoCanvas` test hook and the
 * screenshots and traces from Electron itself.
 *
 * The factory shape is read from a COPY of a Junto database
 * (`loadFactoryShapeCanvas`, which refuses the live one). A copy is made with
 *
 *   sqlite3 "file:$HOME/.junto/state/junto.db?mode=ro" ".backup '/tmp/junto-factory.db'"
 *
 * and named by `JUNTO_FACTORY_DB`. The fixture is scratch data: its labels
 * are the operator's board and never enter the repo.
 */

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { Node, Wire } from "../../src/shared/model";
import { launchJunto, type JuntoHandle } from "./launch";
import { modelFixture, type ModelFixture } from "./model";
import {
  OPERATOR_DISPLAY,
  loadFactoryShapeCanvas,
  type NestedCanvasFixture,
} from "./nested-canvas-fixture";
import { createSandbox, destroySandbox, writeFixtureExperimentalFeatures, writeFixtureModel } from "./sandbox";

export const PROOF_CANVAS = "factory";

/** The three sizes the proof runs, in board copies of the factory canvas. */
export type ProofScale = 1 | 10 | 100;

export interface ProofStats {
  readonly copies: number;
  readonly regions: number;
  readonly seats: number;
  readonly notes: number;
  readonly terminals: number;
  readonly edges: number;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface ProofBoard {
  readonly scale: ProofScale;
  readonly copies: number;
  readonly columns: number;
  readonly model: ModelFixture;
  readonly stats: ProofStats;
  readonly seats: ReadonlyArray<string>;
}

/** Gap between tiles: wide enough that no region contains another tile's card. */
const TILE_GAP = 1_200;

const prefixOf = (tile: number): string => `t${String(tile)}-`;

/** A node with this tile's id, keys, offset and (past 1x) its own words. */
const remapNode = (node: Node, tile: number, dx: number, dy: number, unique: boolean): Node => {
  const prefix = prefixOf(tile);
  const at = { x: node.x + dx, y: node.y + dy };
  const remapped: Node =
    node.kind === "agent"
      ? {
          ...node,
          id: `${prefix}${node.id}` as Node["id"],
          agentKey: `${prefix}${node.agentKey}` as typeof node.agentKey,
          bindingId: `${prefix}${node.bindingId}` as typeof node.bindingId,
          ...at,
        }
      : node.kind === "terminal"
        ? {
            ...node,
            id: `${prefix}${node.id}` as Node["id"],
            bindingId: `${prefix}${node.bindingId}` as typeof node.bindingId,
            ...at,
          }
        : { ...node, id: `${prefix}${node.id}` as Node["id"], ...at };
  if (!unique) return remapped;
  // A tiled board is only a board if the tiles are different content: the
  // same name, note or label in every tile bakes one atlas cell, not 100.
  const words = remapped as unknown as Record<string, unknown>;
  if (typeof words["label"] === "string") words["label"] = `${prefix}${words["label"]}`;
  if (typeof words["text"] === "string") words["text"] = `${prefix}${words["text"]}`;
  if (typeof words["title"] === "string") words["title"] = `${prefix}${words["title"]}`;
  return remapped;
};

const remapWire = (wire: Wire, tile: number): Wire => {
  const prefix = prefixOf(tile);
  return {
    ...wire,
    id: `${prefix}${wire.id}` as Wire["id"],
    from: `${prefix}${wire.from}` as Wire["from"],
    to: `${prefix}${wire.to}` as Wire["to"],
  };
};

/**
 * The factory fixture tiled `copies` times in a compact grid. Every tile is
 * the same cards, regions and wires, offset by the factory's own bounds plus
 * a gap; ids, agent keys and binding ids are prefixed so 100 tiles hold 100
 * distinct seats per factory seat.
 */
export const tileFactory = (fixture: NestedCanvasFixture, copies: number, columns: number): ProofBoard => {
  const unit = fixture.model;
  const bounds = fixture.stats.bounds;
  const stepX = bounds.width + TILE_GAP;
  const stepY = bounds.height + TILE_GAP;
  const nodes: Node[] = [];
  const wires: Wire[] = [];
  for (let tile = 0; tile < copies; tile += 1) {
    const dx = (tile % columns) * stepX;
    const dy = Math.floor(tile / columns) * stepY;
    const unique = copies > 1;
    for (const node of unit.nodes) nodes.push(remapNode(node, tile, dx, dy, unique));
    // A live board can hold the same relationship twice from before the model
    // refused it; the product refuses that add now, so the fixture keeps the
    // first of each pair and says how many it dropped.
    const seen = new Set<string>();
    for (const wire of unit.wires) {
      const key = `${wire.from}|${wire.to}|${wire.verb}`;
      if (seen.has(key)) continue;
      seen.add(key);
      wires.push(remapWire(wire, tile));
    }
  }
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  const seats = nodes.filter((node) => node.kind === "agent").map((node) => String(node.id));
  return {
    scale: copies as ProofScale,
    copies,
    columns,
    model: modelFixture(nodes, wires),
    stats: {
      copies,
      regions: fixture.stats.regions * copies,
      seats: fixture.stats.seats * copies,
      notes: fixture.stats.notes * copies,
      terminals: fixture.stats.terminals * copies,
      edges: wires.length,
      bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    },
    seats,
  };
};

export const columnsFor = (copies: number): number => (copies >= 100 ? 10 : copies >= 10 ? 5 : 1);

/** The factory shape, read once from a database copy. */
export const loadFactoryBoard = (dbPath: string): { readonly fixture: NestedCanvasFixture; readonly board: ProofBoard } => {
  const fixture = loadFactoryShapeCanvas({ dbPath, canvasName: PROOF_CANVAS });
  return { fixture, board: tileFactory(fixture, 1, 1) };
};

/**
 * The same shape from a saved fixture (the `nestedCanvas` JSON a probe writes):
 * `{ model, stats, signalRows }`. Used on a machine without a copy of the
 * operator's database, so the scale arms can run there; the proof on the
 * operator's Mac reads the database copy itself.
 */
export const loadFactoryFixture = (jsonPath: string): NestedCanvasFixture => {
  const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as {
    readonly model: { readonly nodes: NestedCanvasFixture["model"]["nodes"]; readonly wires: NestedCanvasFixture["model"]["wires"] };
    readonly stats: NestedCanvasFixture["stats"];
    readonly signalRows?: ReturnType<NestedCanvasFixture["signals"]>;
  };
  return {
    model: modelFixture(parsed.model.nodes, parsed.model.wires),
    stats: parsed.stats,
    signals: () => parsed.signalRows ?? [],
  };
};

export const buildProofBoard = (fixture: NestedCanvasFixture, scale: ProofScale): ProofBoard =>
  tileFactory(fixture, scale, columnsFor(scale));


/** Launch one arm: the GPU canvas with its experimental switch, or the DOM canvas. */
/** The build this run uses, so a schema change cannot reuse an old seed. */
const buildTag = (): string => {
  try {
    const source = JSON.parse(readFileSync(join(process.cwd(), "out", "build-source.json"), "utf8")) as {
      commit?: string;
      sourceCommit?: string;
    };
    return (source.sourceCommit ?? source.commit ?? "unknown").slice(0, 12);
  } catch {
    return "unknown";
  }
};

/**
 * Seed a large board into one SQLite file, once per scale and build, and let
 * every launch copy it in. A 100x board is 44k nodes: writing it through the
 * app's command path at every launch measured about 90 s of the rig's time,
 * and an operator opens a board that is already stored, not one being written.
 */
let seedInfo: { scale: number; builtMs: number; cached: boolean } | null = null;

/** The seed this process last prepared, for the report. */
export const lastSeed = (): { scale: number; builtMs: number; cached: boolean } | null => seedInfo;

const preparedSeed = async (board: ProofBoard): Promise<{ path: string; builtMs: number; cached: boolean }> => {
  const dir = join(tmpdir(), "junto-gpu-proof-seeds");
  await mkdir(dir, { recursive: true });
  const path = join(
    dir,
    `${String(board.scale)}x-${String(board.stats.seats)}s-${String(board.stats.notes)}n-${String(board.stats.regions)}r-${buildTag()}.db`,
  );
  if (existsSync(path)) return { path, builtMs: 0, cached: true };

  const started = Date.now();
  const sandbox = await createSandbox();
  try {
    await writeFixtureModel(sandbox, PROOF_CANVAS, board.model);
    await writeFixtureExperimentalFeatures(sandbox, ["gpuCanvas"]);
    await copyFile(join(sandbox.homeDir, ".junto", "state", "junto.db"), path);
  } finally {
    await destroySandbox(sandbox);
  }
  return { path, builtMs: Date.now() - started, cached: false };
};

const rememberSeed = (info: { scale: number; builtMs: number; cached: boolean }): void => {
  seedInfo = info;
};

export const launchProofArm = async (
  board: ProofBoard,
  options: { readonly gpu: boolean; readonly extraEnv?: Readonly<Record<string, string>> },
): Promise<JuntoHandle> => {
  // The operator's display by default. On the Mac mini the pane is a
  // 1920x1080 screen: a 1726x1083 window does not fit, so the shakedown arm
  // asks for a smaller window without the forced scale factor.
  const display =
    process.env["JUNTO_GPU_PROOF_WINDOW"] === "mini"
      ? { windowContentSize: { width: 1440, height: 900 } }
      : OPERATOR_DISPLAY;
  const seed = await preparedSeed(board);
  rememberSeed({ scale: board.scale, builtMs: seed.builtMs, cached: seed.cached });
  console.log(
    `${String(board.scale)}x seed: ${seed.cached ? "reused" : `${String((seed.builtMs / 1000).toFixed(1))}s built`} (${seed.path})`,
  );
  return launchJunto({
    seedDatabasePath: seed.path,
    seedModels: {},
    ...(options.gpu ? { seedExperimentalFeatures: ["gpuCanvas" as const] } : {}),
    ...display,
    ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv }),
  });
};

// --- the hook's facts ----------------------------------------------------------

/** The atlas counters the texture rework exposes (mail from canvas-services, Nov 22). */
export interface AtlasStats {
  readonly requests: number;
  readonly pending: number;
  readonly landed: number;
  readonly evictions: number;
  readonly failures: number;
  readonly pages: number;
  readonly pageSize: number;
  readonly bytesInUse: number;
  readonly activeCells: number;
  readonly pinnedCells: number;
  readonly visibleBlank: number;
  readonly visibleBlankTotal: number;
}

export interface ProofState {
  readonly tier: string;
  readonly camera: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly atlas: AtlasStats | null;
  readonly requests: number | null;
  readonly pending: number | null;
  readonly frames: number;
  readonly blank: {
    readonly visibleBlank: number;
    readonly placeholders: number;
    readonly ensuredNow: number;
    readonly marginScreenPx: number;
    readonly tierWindowOctaves: number;
  } | null;
  readonly cull: string | null;
  readonly cullFrames: { readonly gpu: number; readonly standalone: number } | null;
  readonly damage: { readonly lastPixels: number; readonly drawnPixelsTotal: number; readonly screenPixelsTotal: number } | null;
  readonly gpuPass: { readonly available: boolean; readonly samples: number; readonly lastMs?: number; readonly peakMs?: number } | null;
  readonly bufferFailures: ReadonlyArray<{ readonly buffer: string; readonly bytes: number; readonly limit?: number; readonly reason?: string }>;
}

/** What the canvas says about itself right now; null counters on a build without them. */
export const readProofState = (page: Page): Promise<ProofState> =>
  page.evaluate(() => {
    const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
    const atlas = typeof hook?.["atlasStats"] === "function" ? (hook["atlasStats"]() as AtlasStats) : null;
    const stats = typeof hook?.["stats"] === "function" ? (hook["stats"]() as Record<string, any>) : undefined;
    return {
      tier: String(hook?.["tier"]?.() ?? ""),
      camera: (hook?.["camera"]?.() ?? { x: 0, y: 0, zoom: 1 }) as ProofState["camera"],
      atlas,
      requests: typeof hook?.["atlasRequests"] === "function" ? Number(hook["atlasRequests"]()) : null,
      pending: typeof hook?.["atlasPending"] === "function" ? Number(hook["atlasPending"]()) : null,
      frames: Number(stats?.["frames"] ?? 0),
      blank: (stats?.["blank"] ?? null) as ProofState["blank"],
      cull: typeof stats?.["cull"] === "string" ? String(stats["cull"]) : null,
      cullFrames: (stats?.["cullFrames"] ?? null) as ProofState["cullFrames"],
      damage: (stats?.["damage"] ?? null) as ProofState["damage"],
      gpuPass: (stats?.["gpuPass"] ?? null) as ProofState["gpuPass"],
      bufferFailures: (stats?.["bufferFailures"] ?? []) as ProofState["bufferFailures"],
    };
  });

/** The hook has a GPU engine and every seeded card is mirrored. */
export const waitGpuReady = async (page: Page, board: ProofBoard, timeoutMs = 240_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let lastLog = startedAt;
  for (;;) {
    const ready = await page.evaluate(
      (expected) => {
        const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
        if (typeof hook?.["ids"] !== "function") return { ready: false, cards: 0, regions: 0, why: "no hook" };
        return {
          ready: Boolean(hook["ready"]?.()),
          cards: (hook["ids"]() as string[]).length,
          regions: Number(hook["regionCount"]?.() ?? 0),
          why: "hook present",
        };
      },
      board.stats.seats,
    );
    if (ready.ready && ready.cards >= board.stats.seats + board.stats.notes + board.stats.terminals && ready.regions === board.stats.regions) return;
    if (Date.now() - lastLog >= 10_000) {
      lastLog = Date.now();
      console.log(
        `waiting for the canvas: ${String(ready.cards)} cards, ${String(ready.regions)} regions after ${String(Math.round((Date.now() - startedAt) / 1000))}s (wanted ${String(board.stats.seats + board.stats.notes + board.stats.terminals)} and ${String(board.stats.regions)})`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `GPU canvas never mirrored board ${board.scale}x: ${ready.why}, ${String(ready.cards)} cards, ${String(ready.regions)} regions (wanted ${String(board.stats.seats + board.stats.notes + board.stats.terminals)} and ${String(board.stats.regions)})`,
      );
    }
    await page.waitForTimeout(250);
  }
};

/** Wait for the atlas queue to drain and two frames to draw the landed cells. */
export const settleAtlas = async (page: Page, timeoutMs = 180_000, stallMs = 20_000): Promise<ProofState> => {
  const deadline = Date.now() + timeoutMs;
  let pending = -1;
  let progress = { at: Date.now(), pending: -1, landed: -1, requests: -1 };
  for (;;) {
    const state = await readProofState(page);
    const now = state.atlas?.pending ?? state.pending ?? 0;
    const landed = state.atlas?.landed ?? null;
    const requests = state.atlas?.requests ?? state.requests ?? null;
    if (landed !== progress.landed || requests !== progress.requests || now !== progress.pending) {
      progress = { at: Date.now(), pending: now, landed: landed ?? -1, requests: requests ?? -1 };
    }
    if (now === 0) {
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      return readProofState(page);
    }
    if (Date.now() - progress.at >= stallMs) {
      throw new Error(
        `atlas stalled for ${String(Math.round(stallMs / 1000))}s: pending ${String(now)}, landed ${String(landed)}, requests ${String(requests)}, failures ${String(state.atlas?.failures ?? "?")}, blank ${String(state.atlas?.visibleBlank ?? "?")}`,
      );
    }
    if (Date.now() >= deadline) throw new Error(`atlas never settled: ${String(now)} items pending (landed ${String(landed)}, requests ${String(requests)})`);
    await page.waitForTimeout(100);
  }
};

/** Put the camera exactly where a spec says, with no ease. */
export const placeCamera = async (
  page: Page,
  target: { readonly x: number; readonly y: number; readonly zoom: number },
  settleMs = 250,
): Promise<void> => {
  await page.evaluate((to) => {
    const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
    if (typeof hook?.["moveCamera"] !== "function") throw new Error("no GPU test hook to move the camera");
    hook["moveCamera"](to);
  }, target);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const at = (await readProofState(page)).camera;
    const delta = Math.max(Math.abs(at.x - target.x), Math.abs(at.y - target.y), Math.abs(at.zoom - target.zoom));
    if (delta <= 0.01) break;
    if (Date.now() >= deadline) throw new Error(`camera never reached ${JSON.stringify(target)} (at ${JSON.stringify(at)})`);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(settleMs);
};

/** The camera that puts a board point at an exact screen point at a zoom. */
export const cameraOnAt = async (
  page: Page,
  point: { readonly x: number; readonly y: number },
  zoom: number,
  at: { readonly x: number; readonly y: number },
): Promise<{ readonly x: number; readonly y: number; readonly zoom: number }> => {
  const pane = await paneRect(page);
  return {
    x: Math.round(at.x - pane.x - point.x * zoom),
    y: Math.round(at.y - pane.y - point.y * zoom),
    zoom,
  };
};

/** The camera that puts a board point at the pane's centre at a zoom. */
export const cameraOn = async (
  page: Page,
  point: { readonly x: number; readonly y: number },
  zoom: number,
): Promise<{ readonly x: number; readonly y: number; readonly zoom: number }> =>
  page.evaluate(
    (input) => {
      const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
      const pane = hook?.["rectOf"]?.("") as { width: number; height: number } | undefined;
      if (pane === undefined) throw new Error("no pane rectangle from the hook");
      return {
        x: Math.round(pane.width / 2 - input.point.x * input.zoom),
        y: Math.round(pane.height / 2 - input.point.y * input.zoom),
        zoom: input.zoom,
      };
    },
    { point, zoom },
  );

// --- visibleBlank, sampled every frame -----------------------------------------

export interface BlankProbe {
  readonly frames: number;
  readonly maxVisible: number;
  readonly pendingMax: number;
  readonly statsMissing: number;
  readonly totalStart: number | null;
  readonly totalEnd: number | null;
}

/** Start a rAF loop that records the atlas's worst on-screen blank count. */
export const startBlankProbe = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const w = window as unknown as { __gpuProofBlank?: Record<string, any> };
    const probe: Record<string, any> = {
      frames: 0,
      maxVisible: 0,
      pendingMax: 0,
      statsMissing: 0,
      totalStart: null,
      totalEnd: null,
    };
    w.__gpuProofBlank = probe;
    const tick = (): void => {
      const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
      if (hook !== undefined) {
        probe["frames"] = Number(probe["frames"]) + 1;
        if (typeof hook["atlasStats"] !== "function") probe["statsMissing"] = Number(probe["statsMissing"]) + 1;
        else {
          const atlas = hook["atlasStats"]() as AtlasStats;
          probe["maxVisible"] = Math.max(Number(probe["maxVisible"]), Number(atlas.visibleBlank ?? 0));
          probe["pendingMax"] = Math.max(Number(probe["pendingMax"]), Number(atlas.pending ?? 0));
          const total = Number(atlas.visibleBlankTotal ?? 0);
          if (probe["totalStart"] === null) probe["totalStart"] = total;
          probe["totalEnd"] = total;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

export const readBlankProbe = (page: Page): Promise<BlankProbe | null> =>
  page.evaluate(() => ((window as unknown as { __gpuProofBlank?: BlankProbe }).__gpuProofBlank ?? null));

// --- trace measurement ----------------------------------------------------------

type TraceEvent = {
  readonly ph?: string;
  readonly name?: string;
  readonly pid?: number;
  readonly tid?: number;
  readonly ts: number;
  readonly dur?: number;
  readonly args?: Record<string, any>;
};

export interface FrameTrace {
  readonly seconds: number;
  readonly events: number;
  readonly presented: number;
  readonly presentedPerSecond: number;
  readonly gapP50: number | null;
  readonly gapP99: number | null;
  readonly gapMax: number | null;
  readonly gapsOver16_7: number;
  readonly mainBusyMsPerSecond: number | null;
  readonly mainTasksOver16ms: number;
  readonly mainTasksOver50ms: number;
  readonly cameraMoves: number;
  readonly movedNoPresent: number;
  readonly inputEvents: number;
  readonly inputGapP50: number | null;
  readonly inputGapMax: number | null;
  readonly worstGap: {
    readonly ms: number;
    readonly atSeconds: number;
    readonly tasks: ReadonlyArray<{ readonly name: string; readonly thread: string; readonly ms: number }>;
  } | null;
  readonly rawPath: string;
}

const round = (value: number, places = 2): number => Math.round(value * 10 ** places) / 10 ** places;

const pct = (sorted: ReadonlyArray<number>, p: number): number | null =>
  sorted.length === 0 ? null : round(sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))]!);

/**
 * One Chromium timeline trace around `run`, summarized the way the perf
 * scripts read it: presented frames are viz Display::DrawAndSwap, the renderer
 * main thread is the CrRendererMain with the most task time.
 */
export interface MotionProbe {
  readonly ticks: number;
  readonly cameraMoves: number;
  readonly movedNoPresent: number;
  readonly inputEvents: number;
  readonly inputGapP50: number | null;
  readonly inputGapMax: number | null;
}

const EMPTY_MOTION: MotionProbe = {
  ticks: 0,
  cameraMoves: 0,
  movedNoPresent: 0,
  inputEvents: 0,
  inputGapP50: null,
  inputGapMax: null,
};

export const traceRun = async (
  page: Page,
  run: () => Promise<void>,
  rawPath: string,
  readMotion: () => Promise<MotionProbe> = async () => EMPTY_MOTION,
): Promise<FrameTrace> => {
  const cdp = await page.context().newCDPSession(page);
  const chunks: TraceEvent[] = [];
  mkdirSync(dirname(rawPath), { recursive: true });
  // One JSON event per line, written as it arrives: a long trace is hundreds
  // of MB and JSON.stringify of the whole array exceeds V8's string limit.
  const sink = openSync(rawPath, "w");
  cdp.on("Tracing.dataCollected", (data) => {
    const events = (data as unknown as { value?: TraceEvent[] }).value ?? [];
    for (const event of events) chunks.push(event);
    if (events.length > 0) writeSync(sink, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  });
  const finished = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()));
  await cdp.send("Tracing.start", {
    categories: "toplevel,devtools.timeline,viz,cc",
    transferMode: "ReportEvents",
  });
  const started = Date.now();
  try {
    await run();
  } finally {
    const seconds = Math.max(0.001, (Date.now() - started) / 1000);
    await cdp.send("Tracing.end").catch(() => undefined);
    await finished;
    await cdp.detach();
    closeSync(sink);
    return summarizeFrames(chunks, seconds, rawPath, await readMotion());
  }
};

const summarizeFrames = (
  events: ReadonlyArray<TraceEvent>,
  seconds: number,
  rawPath: string,
  motion: MotionProbe,
): FrameTrace => {
  const threads = new Map<string, string>();
  const processes = new Map<number, string>();
  for (const event of events) {
    if (event.ph !== "M") continue;
    if (event.name === "thread_name") threads.set(`${String(event.pid)}:${String(event.tid)}`, String(event.args?.name ?? ""));
    if (event.name === "process_name") processes.set(Number(event.pid), String(event.args?.name ?? ""));
  }
  const busy = new Map<string, number>();
  const taskMs = new Map<string, number[]>();
  const swaps: number[] = [];
  for (const event of events) {
    if (event.ph !== "X") continue;
    if (event.name === "Display::DrawAndSwap") swaps.push(event.ts);
    if (event.name !== "RunTask" && event.name !== "ThreadControllerImpl::RunTask") continue;
    const key = `${String(event.pid)}:${String(event.tid)}`;
    const ms = (event.dur ?? 0) / 1000;
    busy.set(key, (busy.get(key) ?? 0) + ms);
    const list = taskMs.get(key) ?? [];
    list.push(ms);
    taskMs.set(key, list);
  }
  const mainKey = [...busy]
    .filter(([key]) => threads.get(key) === "CrRendererMain")
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  const tasks = mainKey === undefined ? [] : (taskMs.get(mainKey) ?? []);
  swaps.sort((a, b) => a - b);
  const gaps = swaps.slice(1).map((ts, index) => (ts - swaps[index]!) / 1000);
  let worst: { gap: number; a: number; b: number } = { gap: 0, a: 0, b: 0 };
  for (let index = 1; index < swaps.length; index += 1) {
    const gap = swaps[index]! - swaps[index - 1]!;
    if (gap > worst.gap) worst = { gap, a: swaps[index - 1]!, b: swaps[index]! };
  }
  const worstTasks =
    worst.gap === 0
      ? []
      : events
          .filter((event) => event.ph === "X" && event.ts >= worst.a && event.ts <= worst.b && event.name !== "Display::DrawAndSwap")
          .map((event) => ({
            name: String(event.name ?? "?"),
            thread: threads.get(`${String(event.pid)}:${String(event.tid)}`) ?? "",
            ms: round((event.dur ?? 0) / 1000, 2),
          }))
          .filter((task) => task.ms >= 1)
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 10);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  return {
    seconds: round(seconds, 2),
    events: events.length,
    presented: swaps.length,
    presentedPerSecond: round(swaps.length / seconds, 1),
    gapP50: pct(sortedGaps, 50),
    gapP99: pct(sortedGaps, 99),
    gapMax: sortedGaps.length === 0 ? null : round(sortedGaps.at(-1)!),
    gapsOver16_7: gaps.filter((gap) => gap > 16.7).length,
    mainBusyMsPerSecond: mainKey === undefined ? null : round((busy.get(mainKey) ?? 0) / seconds, 1),
    mainTasksOver16ms: tasks.filter((ms) => ms > 16.7).length,
    mainTasksOver50ms: tasks.filter((ms) => ms > 50).length,
    cameraMoves: motion.cameraMoves,
    movedNoPresent: motion.movedNoPresent,
    inputEvents: motion.inputEvents,
    inputGapP50: motion.inputGapP50,
    inputGapMax: motion.inputGapMax,
    worstGap:
      worst.gap === 0
        ? null
        : { ms: round(worst.gap / 1000, 2), atSeconds: round((worst.a - swaps[0]!) / 1_000_000, 2), tasks: worstTasks },
    rawPath,
  };
};

// --- camera motion probe --------------------------------------------------------

/**
 * Watch the camera and the drawn-frame counter every rAF while input runs.
 * A rAF where the camera moved and the frame counter did not is a camera
 * move that presented nothing, which no trace gap alone can name.
 */
export const startMotionProbe = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const w = window as unknown as { __gpuMotion?: Record<string, unknown> };
    const probe: Record<string, unknown> = { ticks: 0, cameraMoves: 0, movedNoPresent: 0, inputEvents: 0, lastFrames: -1, lastCamera: null };
    w.__gpuMotion = probe;
    (window as unknown as { __gpuInputGaps?: number[] }).__gpuInputGaps = [];
    const tick = (): void => {
      const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
      if (hook !== undefined) {
        probe["ticks"] = Number(probe["ticks"]) + 1;
        const camera = hook["camera"]() as { x: number; y: number; zoom: number };
        const frames = Number((hook["stats"]() as { frames?: number }).frames ?? -1);
        const key = `${String(camera.x)}:${String(camera.y)}:${String(camera.zoom)}`;
        if (probe["lastCamera"] !== null && probe["lastCamera"] !== key) {
          probe["cameraMoves"] = Number(probe["cameraMoves"]) + 1;
          if (frames === Number(probe["lastFrames"])) probe["movedNoPresent"] = Number(probe["movedNoPresent"]) + 1;
        }
        probe["lastCamera"] = key;
        probe["lastFrames"] = frames;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

export const readMotionProbe = async (page: Page): Promise<MotionProbe> => {
  const raw = await page.evaluate(() => {
    const motion = (window as unknown as { __gpuMotion?: Record<string, unknown> }).__gpuMotion;
    if (motion === undefined) return null;
    return {
      ticks: Number(motion["ticks"] ?? 0),
      cameraMoves: Number(motion["cameraMoves"] ?? 0),
      movedNoPresent: Number(motion["movedNoPresent"] ?? 0),
      inputEvents: Number(motion["inputEvents"] ?? 0),
    };
  });
  if (raw === null) return EMPTY_MOTION;
  const gaps = (await page.evaluate(() => (window as unknown as { __gpuInputGaps?: number[] }).__gpuInputGaps ?? [])) as number[];
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    ticks: raw.ticks,
    cameraMoves: raw.cameraMoves,
    movedNoPresent: raw.movedNoPresent,
    inputEvents: raw.inputEvents,
    inputGapP50: sorted.length === 0 ? null : round(sorted[Math.floor(sorted.length / 2)]!, 1),
    inputGapMax: sorted.length === 0 ? null : round(sorted.at(-1)!, 1),
  };
};

/**
 * Zoom through `targets` the way a trackpad does: one wheel event per display
 * frame, small deltas, and no reads of the engine between events. Reading
 * between steps stops the motion, which is what made the first trace measure
 * the driver instead of the canvas.
 */
export const wheelSweep = async (page: Page, targets: ReadonlyArray<number>, deltaPerEvent = 4, frameMs = 16): Promise<void> => {
  const camera = await page.evaluate(() => {
    const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
    return { zoom: (hook?.["camera"]() as { zoom: number } | undefined)?.zoom ?? 1, pane: hook?.["rectOf"]("") as { x: number; y: number; width: number; height: number } | undefined };
  });
  let zoom = camera.zoom;
  const pane = camera.pane ?? { x: 0, y: 0, width: 800, height: 600 };
  const cdp = await page.context().newCDPSession(page);
  const sends: Array<Promise<unknown>> = [];
  const stamps: number[] = [];
  const startedAt = Date.now();
  let index = 0;
  try {
    for (const target of targets) {
      const events = Math.ceil(Math.abs(Math.log2(target / zoom)) / (deltaPerEvent * 0.02));
      const direction = target > zoom ? 1 : -1;
      for (let step = 0; step < events; step += 1) {
        const due = startedAt + index * frameMs;
        const wait = due - Date.now();
        if (wait > 0) await page.waitForTimeout(wait);
        stamps.push(Date.now());
        sends.push(
          cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: pane.x + pane.width / 2,
            y: pane.y + pane.height / 2,
            deltaX: 0,
            deltaY: -direction * deltaPerEvent,
          }).catch(() => undefined),
        );
        index += 1;
      }
      zoom = target;
    }
    await Promise.all(sends);
  } finally {
    await cdp.detach().catch(() => undefined);
  }
  const gaps = stamps.slice(1).map((ts, i) => ts - stamps[i]!);
  await page.evaluate(
    (input: { events: number; gaps: number[] }) => {
      const w = window as unknown as { __gpuMotion?: Record<string, unknown>; __gpuInputGaps?: number[] };
      if (w.__gpuMotion !== undefined) {
        const previous = Number(w.__gpuMotion["inputEvents"]);
        w.__gpuMotion["inputEvents"] = (Number.isFinite(previous) ? previous : 0) + input.events;
      }
      const previous = w.__gpuInputGaps ?? [];
      w.__gpuInputGaps = previous.concat(input.gaps);
    },
    { events: stamps.length, gaps },
  );
};

/** A two-finger pan as the canvas takes it: wheel deltas at display rate, no reads. */
export const panSweep = async (
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  frames = 40,
  frameMs = 16,
): Promise<void> => {
  const pane = await page.evaluate(() => {
    const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
    return hook?.["rectOf"]("") as { x: number; y: number; width: number; height: number } | undefined;
  });
  const rect = pane ?? { x: 0, y: 0, width: 800, height: 600 };
  const cdp = await page.context().newCDPSession(page);
  const sends: Array<Promise<unknown>> = [];
  const stamps: number[] = [];
  const startedAt = Date.now();
  try {
    for (let frame = 0; frame < frames; frame += 1) {
      const due = startedAt + frame * frameMs;
      const wait = due - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
      stamps.push(Date.now());
      sends.push(
        cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          deltaX: (to.x - from.x) / frames,
          deltaY: (to.y - from.y) / frames,
        }).catch(() => undefined),
      );
    }
    await Promise.all(sends);
  } finally {
    await cdp.detach().catch(() => undefined);
  }
  const gaps = stamps.slice(1).map((ts, i) => ts - stamps[i]!);
  await page.evaluate(
    (input: { events: number; gaps: number[] }) => {
      const w = window as unknown as { __gpuMotion?: Record<string, unknown>; __gpuInputGaps?: number[] };
      if (w.__gpuMotion !== undefined) {
        const previous = Number(w.__gpuMotion["inputEvents"]);
        w.__gpuMotion["inputEvents"] = (Number.isFinite(previous) ? previous : 0) + input.events;
      }
      const before = w.__gpuInputGaps ?? [];
      w.__gpuInputGaps = before.concat(input.gaps);
    },
    { events: stamps.length, gaps },
  );
};

// --- screencast -----------------------------------------------------------------

export interface RecordedFrame {
  readonly at: number;
  readonly file: string;
}

/**
 * Record the renderer with CDP's screencast for the length of `run`. Every
 * composited frame becomes a PNG, so anything that blinks out shows up in the
 * frames as well as in the atlas's own visibleBlank counter.
 */
export const recordRun = async (page: Page, run: () => Promise<void>, outDir: string): Promise<ReadonlyArray<RecordedFrame>> => {
  await mkdir(outDir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames: RecordedFrame[] = [];
  let writing: Promise<void> = Promise.resolve();
  cdp.on("Page.screencastFrame", (frame) => {
    const data = frame as unknown as { data: string; sessionId: number; metadata: { timestamp: number } };
    const index = frames.length;
    const file = join(outDir, `frame-${String(index).padStart(4, "0")}.png`);
    frames.push({ at: data.metadata.timestamp, file });
    writing = writing.then(async () => {
      await writeFile(file, Buffer.from(data.data, "base64"));
      await cdp.send("Page.screencastFrameAck", { sessionId: data.sessionId }).catch(() => undefined);
    });
  });
  await cdp.send("Page.enable");
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: 1600, maxHeight: 1000, everyNthFrame: 1 });
  try {
    await run();
  } finally {
    await page.waitForTimeout(400);
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    await writing;
    await cdp.detach();
  }
  return frames;
};

// --- real gestures --------------------------------------------------------------

/**
 * Zoom to `zoom` with trusted ctrl+wheel events (the trackpad pinch path), the
 * way the seat's own hands would. Returns the camera it landed on.
 */
export const wheelZoomTo = async (page: Page, zoom: number): Promise<void> => {
  const cdp = await page.context().newCDPSession(page);
  try {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const { camera } = await readProofState(page);
      if (Math.abs(camera.zoom - zoom) < 0.004) break;
      const pane = await page.evaluate(() => {
        const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
        const rect = hook?.["rectOf"]?.("") as { x: number; y: number; width: number; height: number } | undefined;
        return rect ?? null;
      });
      if (pane === null) throw new Error("no pane to zoom over");
      const factor = 0.02;
      const delta = -Math.log2(zoom / camera.zoom) / factor;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: pane.x + pane.width / 2,
        y: pane.y + pane.height / 2,
        deltaX: 0,
        deltaY: Math.max(-240, Math.min(240, delta)),
        modifiers: 2,
      });
      if (Date.now() >= deadline) throw new Error(`wheel never reached zoom ${String(zoom)} (at ${String(camera.zoom)})`);
      await page.waitForTimeout(60);
    }
  } finally {
    await cdp.detach();
  }
  await page.waitForTimeout(120);
};

/** A fast two-finger-style pan fling across the pane, with real pointer moves. */
export const fling = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12): Promise<void> => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
};

/** The pane's page rectangle. */
export const paneRect = async (page: Page): Promise<{ x: number; y: number; width: number; height: number }> =>
  page.evaluate(() => {
    const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
    const rect = hook?.["rectOf"]?.("") as { x: number; y: number; width: number; height: number } | undefined;
    if (rect === undefined) throw new Error("no pane rectangle");
    return rect;
  });

/** A board point's screen point under the current camera, or null when off the pane. */
export const screenOf = (
  camera: { x: number; y: number; zoom: number },
  pane: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number },
): { x: number; y: number; inside: boolean } => {
  const x = pane.x + camera.x + point.x * camera.zoom;
  const y = pane.y + camera.y + point.y * camera.zoom;
  return { x, y, inside: x >= pane.x && y >= pane.y && x <= pane.x + pane.width && y <= pane.y + pane.height };
};

/** A seat's board rectangle, from the model (mirror rows keep the authored rect). */
export const seatBoardRects = (board: ProofBoard): Readonly<Record<string, { x: number; y: number; width: number; height: number }>> =>
  Object.fromEntries(
    board.model.nodes
      .filter((node) => node.kind === "agent")
      .map((node) => [node.id, { x: node.x, y: node.y, width: node.width, height: node.height }]),
  );
