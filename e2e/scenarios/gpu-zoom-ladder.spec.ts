/**
 * The zoom ladder (operator requirement, 2026-11-23): "a validation that
 * zooms in and out, taking screenshots at every different level, ensuring
 * the integrity of the screenshots." It runs before every release.
 *
 * The ladder: one stop in every raster scale bucket (`atlasScale`, half
 * powers of two of device pixels per board unit, scene.ts) from the widest
 * zoom the camera allows (0.15) to the closest (2.5), which covers every tier.
 * Each stop sits clear of the tier hysteresis bands (canvas-tier.ts, 0.03
 * about 0.2, 0.46 and 0.62), so its tier does not depend on the way the
 * camera came. The ladder runs in, then out, at three places on the board (a
 * region centre, a region edge, a cluster of notes with images), for several
 * cycles. Seat state churn (status lines and portrait expressions) runs
 * between stops, and a mid-zoom tour between cycles fills the atlas so it has
 * to reclaim.
 *
 * At every stop, after the atlas settles, the window is screenshotted and
 * saved under the proof directory with the stop's name. Its integrity is
 * three checks, and all must hold:
 *   (a) it equals the reference screenshot of the same camera and content,
 *       taken from a fresh launch that went from its opening camera straight
 *       to that camera with no zoom history. Tolerance: a pixel is changed
 *       when a channel differs by more than 48, and the stop fails on any
 *       16 CSS px block holding 24 or more changed pixels (at any device
 *       scale: the block and the count scale with devicePixelRatio, so the
 *       2x arm has the 1x arm's sensitivity). The diff is saved on failure;
 *   (b) `atlasAudit()` and the texel readback (`atlasAuditTexels`) are clean,
 *       and the readback is whole: it fails when `truncated` says the limit
 *       stopped it with comparable cells left, or `skipped` counts any cell a
 *       quad can draw that it did not compare; each stop logs what it compared,
 *       what it skipped and the `undrawn` cells no quad can draw (information,
 *       never a failure);
 *   (c) no GPU error since the last stop.
 *
 * Each leg between two stops (each crosses one bucket boundary) pinches to a
 * point and takes a zoom-end frame there: the picture right after a zoom
 * ends, on a camera still for three display frames, with the atlas
 * unsettled (rasters for the new scale still in flight, stand-ins showing).
 * It is not a frame from inside a moving gesture: those are the pop check's.
 *
 * The pop check (operator ruling 6: nothing visible disappears, pops or goes
 * blank) reads the CPU tables on every presented frame of every leg's
 * gestures, never a texel readback (a readback inside a gesture would change
 * what is measured). Two faults, and nothing else: an in-view atlas quad that
 * draws nothing, and a quad that showed its own pixels and on a later frame,
 * at the raster scale it held, shows a stand-in's, its placeholder or
 * nothing. Own cell, then stand-in, then own cell across a raster scale
 * change is the design and passes. Its control is a seeded fault
 * (`popWatch("seed")`: in-view quads let go of their own cells, so the frame
 * really draws nothing there), run first: the run fails unless the check
 * catches it.
 *
 * The leg churns first and
 * lets the atlas raster the churned seats, then restores the baseline and
 * settles, so the frame holds its reference's content and differs only by
 * what the zoom did. A leg that crosses a tier ends just past the crossing,
 * hysteresis included (where a card changes its drawing and a pop would
 * show); any other leg ends at its geometric middle. The frame is compared,
 * downsampled to 8 CSS px blocks (scaled with devicePixelRatio, as the stops
 * are), against a fresh launch placed at exactly the frame's camera with its
 * clocks held the same way, so the two compare pixel-aligned and both show
 * ring phase 0; pixels under DOM are skipped, and so is everything the engine
 * says it draws moving at that frame: the placed rects of the parts that carry
 * a motion (`turn` for a ring, `pulse`, `reach`, `rise`), read from the test
 * hook, with the still sprites inside them unmasked. Never "every pixel that
 * changed": a card or a portrait that pops is a change, and a change is the
 * fault. A reference at another camera would misalign a seat's 12 px mark by
 * about a pixel, which reads as a fault at every seat on a dense board.
 * Tolerance: a block is hot when one channel of
 * its mean colour differs by more than 40 of 255, and the frame fails on a
 * connected group of 12 or more hot blocks (about a 28 CSS px square, smaller
 * than a mid-tier portrait). A scaled stand-in blurs or sharpens and keeps
 * its block means; another item's pixels, a missing portrait, a black disc or
 * a whole page drawn in a quad do not.
 *
 * What legitimately differs between two launches, and how it is held for the
 * shot (nothing else is masked):
 *   - ring phase and every clock-driven motion on the canvas: the frame clocks
 *     are held (`holdClocks`) at an epoch multiple of MARK_PHASE_MS, the one
 *     period every ring, band and reach motion divides, so each shows phase 0;
 *     a zoom-end frame is taken with the clocks unheld instead, and whatever
 *     moved between it and a second frame a moment later is masked;
 *   - CSS animations in the DOM (rings in the bars): paused at phase 0;
 *   - the DOM minimap: hidden, because it frames to the camera's travel, not
 *     to the camera;
 *   - the DOM hotbar (the top bar's group slots): hidden, because it leases
 *     slots by the recency of seat activity, which is the churn's history;
 *   - the pointer: parked at the same pane corner in both launches;
 *   - churned content: every seat gets the baseline event again before the
 *     shot, the one the reference launch was given: idle from a freshly bound
 *     state machine under a new epoch. The renderer reads a new epoch as a new
 *     generation (agent-seat-state.ts), so no finished turn carries over. An
 *     idle in the churn's own epoch ends the churned turn instead: "done, not
 *     read yet" and a "Junto done" bubble, which the reference never had.
 * A zoom-end frame cannot hold its clocks (a transition
 * started under a held clock never ends), so it skips the pixels that moved
 * across four unheld reference shots: the board's own motion.
 *
 * The run fails if the atlas never evicted a plot (reclaim never exercised).
 *
 * The board is never a copy of anyone's database (the rig's rule, and the
 * operator's): either the seeded factory-like board (the default,
 * JUNTO_ZOOM_LADDER_SEED names another preset), or a shapes file of a real
 * board, JUNTO_FACTORY_JSON: { model, stats } with made-up ids and names and
 * only rects, kinds, region colours and wire verbs, which canvas-lead checks
 * before any run reads it.
 *
 * Run (on the Mac mini, scripts/mini.sh):
 *   JUNTO_GPU_PROOF=1 scripts/run-e2e.sh e2e/scenarios/gpu-zoom-ladder.spec.ts
 *   JUNTO_GPU_PROOF=1 JUNTO_FACTORY_JSON=<shapes.json> scripts/run-e2e.sh e2e/scenarios/gpu-zoom-ladder.spec.ts
 * Output: JUNTO_ZOOM_LADDER_OUT (default /tmp/junto-zoom-ladder): proof.json,
 * every stop's screenshot, the references, the diffs, and contact/ (one
 * reference, after, diff strip per stop, with index.html).
 */

import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SeatStateMachine } from "../../src/core/term/agent-state";
import { MARK_PHASE_MS } from "../../src/shared/wire/rings";
import { TIER_FAR_MIN, TIER_HYSTERESIS, TIER_MID_MIN, TIER_NEAR_MIN } from "../../src/shared/canvas-tier";
import { modelNote } from "../harness/model";
import { buildNestedCanvasFixture, type NestedCanvasFixture, type NestedCanvasPresetName } from "../harness/nested-canvas-fixture";
import {
  buildProofBoard,
  launchProofArm,
  loadFactoryFixture,
  paneRect,
  placeCamera,
  readProofState,
  settleAtlas,
  waitGpuReady,
  type ProofBoard,
} from "../harness/gpu-proof";

interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  readonly PNG: {
    new (options: { width: number; height: number }): PngImage;
    readonly sync: { read(png: Buffer): PngImage; write(png: PngImage): Buffer };
  };
};

const JSON_FIXTURE = process.env["JUNTO_FACTORY_JSON"] ?? "";
const SEED = (process.env["JUNTO_ZOOM_LADDER_SEED"] ?? "factory-like") as NestedCanvasPresetName;
const ENABLED = process.env["JUNTO_GPU_PROOF"] === "1";
const OUT = process.env["JUNTO_ZOOM_LADDER_OUT"] ?? "/tmp/junto-zoom-ladder";
const CYCLES = Number(process.env["JUNTO_ZOOM_LADDER_CYCLES"] ?? 3);
/** The note images' server: a fixed port, because the seeded board names it. */
const IMAGE_PORT = Number(process.env["JUNTO_ZOOM_LADDER_IMAGE_PORT"] ?? 47391);
const CHANNEL = "junto:agent-seat-state-changed";

test.skip(!ENABLED, "set JUNTO_GPU_PROOF=1 (and JUNTO_FACTORY_JSON=<a real board's shapes> for one)");

/**
 * One stop per raster bucket at the operator's pixel ratio 2, each clear of
 * every hysteresis band: buckets k = -3..5 of round(2 log2(2 zoom)).
 */
const LADDER = [0.15, 0.26, 0.36, 0.54, 0.74, 1.0, 1.41, 2.0, 2.5] as const;

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type Camera = { readonly x: number; readonly y: number; readonly zoom: number };
type Place = { readonly name: string; readonly x: number; readonly y: number };
type Audit = { checked: number; heldCells: number; counts: Record<string, number>; samples: Array<Record<string, unknown>> };
type TexelAudit = {
  checked: number;
  truncated?: boolean;
  skipped: Record<string, number>;
  undrawn?: Record<string, number>;
  mismatches: Array<Record<string, unknown>>;
  worst: number;
};

const failures: string[] = [];
const proof: Record<string, unknown>[] = [];
const log = (line: string, data: Record<string, unknown> = {}): void => {
  console.log(`${line}${Object.keys(data).length === 0 ? "" : ` ${JSON.stringify(data)}`}`);
  proof.push({ line, ...data });
};
const fail = (line: string, data: Record<string, unknown> = {}): void => {
  failures.push(line);
  log(`FAIL ${line}`, data);
};

// --- the board: the factory shape plus a cluster of notes with images ---------

const IMAGE_NOTES = 12;
const imageUrl = (n: number): string => `http://127.0.0.1:${String(IMAGE_PORT)}/note-${String(n)}.png`;

/** A picture no other note shares: its own hue, n bars, a corner checker. */
const notePicture = (n: number): Buffer => {
  const width = 240;
  const height = 180;
  const png = new PNG({ width, height });
  const hue = (n * 47) % 360;
  const rgb = (h: number, l: number): [number, number, number] => {
    const c = (1 - Math.abs(2 * l - 1)) * 0.8;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    const m = l - c / 2;
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  };
  const back = rgb(hue, 0.55);
  const bar = rgb((hue + 180) % 360, 0.2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const inBar = y > 40 && y < 150 && x > 20 && Math.floor((x - 20) / 16) < n + 1 && (x - 20) % 16 < 9;
      const checker = x < 40 && y < 32 && (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      const [r, g, b] = inBar ? bar : checker ? [255, 255, 255] : back;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
};

const withImageNotes = (board: ProofBoard): { board: ProofBoard; cluster: Place } => {
  const b = board.stats.bounds;
  // Below the board, clear of every region: four columns of three.
  const x0 = b.x + 400;
  const y0 = b.y + b.height + 400;
  const notes = Array.from({ length: IMAGE_NOTES }, (_, n) => ({
    ...modelNote(`ladder-image-${String(n)}`, `Picture ${String(n)}\n\n![picture ${String(n)}](${imageUrl(n)})`, x0 + (n % 4) * 150, y0 + Math.floor(n / 4) * 170),
    width: 120,
    height: 150,
    z: 2,
  }));
  return {
    board: {
      ...board,
      model: { ...board.model, nodes: [...board.model.nodes, ...notes] as typeof board.model.nodes },
      stats: { ...board.stats, notes: board.stats.notes + IMAGE_NOTES },
    },
    cluster: { name: "image-notes", x: x0 + 2 * 150 - 15, y: y0 + 170 + 75 },
  };
};

const servePictures = (): Promise<Server> =>
  new Promise((resolve, reject) => {
    const pictures = new Map(Array.from({ length: IMAGE_NOTES }, (_, n) => [`/note-${String(n)}.png`, notePicture(n)]));
    const server = createServer((req, res) => {
      const body = pictures.get(req.url ?? "");
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (body === undefined) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader("Content-Type", "image/png");
      res.end(body);
    });
    server.once("error", reject);
    server.listen(IMAGE_PORT, "127.0.0.1", () => resolve(server));
  });

/** The region centre and region edge stops: the largest region with seats, and its top-left corner. */
const placesOf = (board: ProofBoard, cluster: Place): Place[] => {
  const nodes = board.model.nodes as ReadonlyArray<{ kind: string; x: number; y: number; width: number; height: number }>;
  const seats = nodes.filter((n) => n.kind === "agent");
  const regions = nodes
    .filter((n) => n.kind === "region")
    .map((r) => ({ r, seats: seats.filter((s) => s.x >= r.x && s.y >= r.y && s.x + s.width <= r.x + r.width && s.y + s.height <= r.y + r.height).length }))
    .filter((e) => e.seats > 0 && e.r.width < 4_000)
    .sort((a, b) => b.seats - a.seats);
  // A board whose regions hold no seat by these rects (a seeded one nests by parent) centres on its bounds.
  const b = board.stats.bounds;
  const whole = { x: b.x, y: b.y, width: b.width, height: b.height };
  const centre = regions[0]?.r ?? whole;
  const edge = regions[1]?.r ?? centre;
  return [
    { name: "region-centre", x: centre.x + centre.width / 2, y: centre.y + centre.height / 2 },
    { name: "region-edge", x: edge.x + 40, y: edge.y + 40 },
    cluster,
  ];
};

// --- the app's state, read through the test hook ------------------------------

const audit = (page: Page): Promise<Audit | null> =>
  page.evaluate(() => {
    const hook = (window as unknown as { __juntoCanvas?: { atlasAudit?: () => unknown } }).__juntoCanvas;
    return (hook?.atlasAudit?.() ?? null) as Audit | null;
  });

/** The texel readback's limit: a check that reaches it stopped before the end. */
const TEXEL_LIMIT = 600;

/**
 * What the texel check compared and what it did not (the shape canvas-services
 * shipped in 8166e6de8): every cell a quad can draw is either compared or
 * counted in `skipped` by why, and the gate fails on either kind of gap. Cells
 * no quad can draw are `undrawn`, by why: information, never a failure.
 * `truncated` says the limit stopped it with comparable cells left.
 */
const texelCoverage = (t: TexelAudit): { compared: number; notCompared: Record<string, number>; undrawn: Record<string, number>; stoppedAtLimit: boolean; gaps: string[] } => {
  const notCompared = Object.fromEntries(Object.entries(t.skipped).filter(([, n]) => n > 0));
  const undrawn = Object.fromEntries(Object.entries(t.undrawn ?? {}).filter(([, n]) => n > 0));
  // `truncated` (stopped at the limit with comparable cells left) where the build has it;
  // only a build without it falls back to `checked >= limit`. A board with exactly 600 comparable cells passes.
  const truncated = t.truncated;
  const stoppedAtLimit = truncated === undefined ? t.checked >= TEXEL_LIMIT : truncated;
  const gaps: string[] = [];
  if (stoppedAtLimit) gaps.push(`stopped at its limit of ${String(TEXEL_LIMIT)} cells`);
  for (const [why, n] of Object.entries(notCompared)) gaps.push(`passed over ${String(n)} cell(s): ${why}`);
  return { compared: t.checked, notCompared, undrawn, stoppedAtLimit, gaps };
};

const auditTexels = (page: Page): Promise<TexelAudit | null> =>
  page.evaluate(async (limit) => {
    const hook = (window as unknown as { __juntoCanvas?: { atlasAuditTexels?: (limit?: number) => Promise<unknown> | null } }).__juntoCanvas;
    return ((await hook?.atlasAuditTexels?.(limit)) ?? null) as TexelAudit | null;
  }, TEXEL_LIMIT);

/** Checks (b) and (c) at one stop. `seen` carries the GPU error count across stops. */
const checkStop = async (page: Page, where: string, seen: { errors: number; since: number; evictions: number }): Promise<Record<string, unknown>> => {
  const state = await readProofState(page);
  const atlas = state.atlas as
    | (typeof state.atlas & { compactions?: number; overwrites?: number; rerasters?: number })
    | null;
  // Thrash: keys evicted and rastered again inside this stop's window (since the last stop). Logged for canvas-services, not failed.
  const { now, log } = await page.evaluate(() => {
    const hook = (window as unknown as { __juntoCanvas?: { rerasterLog?: () => ReadonlyArray<{ key: string; evictedAt: number; at: number }> } }).__juntoCanvas;
    return { now: performance.now(), log: hook?.rerasterLog?.() ?? [] };
  });
  const thrashed = log.filter((r) => r.evictedAt >= seen.since);
  const thrash = { count: thrashed.length, logFull: log.length >= 256 && (log[0]?.evictedAt ?? 0) >= seen.since, keys: thrashed.slice(0, 8).map((r) => r.key) };
  seen.since = now;
  const evictedThisStop = (atlas?.evictions ?? 0) - seen.evictions;
  seen.evictions = atlas?.evictions ?? 0;
  const errors = state.gpuErrors?.count ?? 0;
  if (state.gpuErrors === null) fail(`${where}: the build has no gpuErrors hook`);
  else if (errors > seen.errors) fail(`${where}: ${String(errors - seen.errors)} GPU error(s) since the last stop`, { last: state.gpuErrors.last });
  seen.errors = errors;
  const a = await audit(page);
  if (a === null) fail(`${where}: the build has no atlasAudit hook`);
  else if (Object.keys(a.counts).length > 0) fail(`${where}: atlas audit`, { counts: a.counts, checked: a.checked, first: a.samples.slice(0, 6) });
  // Slots failed now (canvas-services P1): a settled stop holds none.
  const failedCells = atlas?.failedCells;
  if (atlas !== null && typeof failedCells !== "number") fail(`${where}: the build's atlasStats has no failedCells`);
  else if (failedCells !== undefined && failedCells > 0) fail(`${where}: ${String(failedCells)} atlas slot(s) failed and wait for a retry at a settled stop`);
  const t = await auditTexels(page);
  if (t === null) fail(`${where}: the build has no atlasAuditTexels hook`);
  // A readout this gate does not know would pass every check below by being empty.
  else if (typeof t.checked !== "number" || typeof t.skipped !== "object" || !Array.isArray(t.mismatches)) {
    fail(`${where}: the texel audit answers a shape this gate does not read`, { readout: t });
  } else if (t.mismatches.length > 0) {
    fail(`${where}: ${String(t.mismatches.length)} landed sprite cell(s) hold another drawing`, { first: t.mismatches.slice(0, 6) });
  }
  const coverage = t === null ? null : texelCoverage(t);
  if (coverage !== null && coverage.gaps.length > 0) fail(`${where}: the texel check is partial: ${coverage.gaps.join("; ")}`, { compared: coverage.compared, notCompared: coverage.notCompared });
  return {
    tier: state.tier,
    zoom: Math.round(state.camera.zoom * 1000) / 1000,
    // A running total of cells freed since launch; the stop's own share is the difference from the stop before.
    evictions: atlas?.evictions,
    evictedThisStop,
    compactions: atlas?.compactions,
    // A cell re-keyed in place (status churn) counts here; pages stay flat.
    overwrites: atlas?.overwrites,
    rerasters: atlas?.rerasters,
    failedCells,
    thrash,
    pages: atlas?.pages,
    landed: atlas?.landed,
    gpuErrors: errors,
    audit: a === null ? null : { checked: a.checked, counts: a.counts },
    texels: t === null || coverage === null ? null : { compared: coverage.compared, notCompared: coverage.notCompared, undrawn: coverage.undrawn, stoppedAtLimit: coverage.stoppedAtLimit, mismatches: t.mismatches.length, kinds: [...new Set(t.mismatches.map((m) => String((m as { kind?: unknown }).kind ?? "?")))], worst: Math.round(t.worst * 10) / 10 },
  };
};

type PopReport = {
  frames: number;
  blankFrames: number;
  blankQuads: number;
  pops: number;
  scanned: number;
  peakQuads: number;
  scaleChanges: number;
  seeded: number;
  samples: Array<Record<string, unknown>>;
};

/** The pop check's per-frame record (test hook `popWatch`). */
const popWatch = (page: Page, what: "start" | "read" | "stop" | "seed"): Promise<PopReport | null> =>
  page.evaluate((w) => {
    const hook = (window as unknown as { __juntoCanvas?: { popWatch?: (what: string) => unknown } }).__juntoCanvas;
    if (typeof hook?.popWatch !== "function") return null;
    return (hook.popWatch(w) ?? null) as never;
  }, what);

const atlasCounters = async (page: Page): Promise<{ evictions: number; compactions: number }> => {
  const atlas = (await readProofState(page)).atlas as { evictions?: number; compactions?: number } | null;
  return { evictions: atlas?.evictions ?? 0, compactions: atlas?.compactions ?? 0 };
};

// --- what differs between launches, held for the shot -------------------------

/** Hide the DOM minimap and hotbar for the whole run: they show the travel and the churn's history. */
const hideMinimap = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = ".react-flow__minimap, .group-bar { visibility: hidden !important; }";
    document.head.append(style);
  });

/** Hold the canvas clocks at phase 0 of every motion and pause CSS animations at 0; returns the release. */
const holdForShot = async (page: Page): Promise<() => Promise<void>> => {
  await page.evaluate((cycle) => {
    const hook = (window as unknown as { __juntoCanvas?: { holdClocks?: (wall: number | undefined) => void } }).__juntoCanvas;
    if (typeof hook?.holdClocks !== "function") throw new Error("the build has no holdClocks hook");
    // Later than every fade in flight, so each one has ended.
    hook.holdClocks(Math.ceil((Date.now() + 2_000) / cycle) * cycle);
    const held: Array<{ a: Animation; delay: number; start: CSSNumberish | null }> = [];
    for (const a of document.getAnimations()) {
      const delay = Number(a.effect?.getTiming().delay ?? 0);
      held.push({ a, delay, start: a.startTime });
      a.pause();
      a.effect?.updateTiming({ delay: 0 });
      a.currentTime = 0;
    }
    (window as unknown as { __ladderHeld?: typeof held }).__ladderHeld = held;
  }, MARK_PHASE_MS);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
  return async () => {
    await page.evaluate(() => {
      const hook = (window as unknown as { __juntoCanvas?: { holdClocks?: (wall: number | undefined) => void } }).__juntoCanvas;
      hook?.holdClocks?.(undefined);
      const w = window as unknown as { __ladderHeld?: Array<{ a: Animation; delay: number; start: CSSNumberish | null }> };
      for (const { a, delay, start } of w.__ladderHeld ?? []) {
        a.effect?.updateTiming({ delay });
        // Back on the shared clock: the start it had, playing.
        if (start !== null) a.startTime = start;
        else a.play();
      }
      w.__ladderHeld = [];
    });
  };
};

const parkPointer = async (page: Page, pane: Rect): Promise<void> => {
  await page.mouse.move(pane.x + pane.width - 3, pane.y + 3);
};

// --- seat churn ----------------------------------------------------------------

const send = (app: ElectronApplication, events: ReadonlyArray<unknown>) =>
  app.evaluate(({ BrowserWindow }, { channel, events }) => {
    for (const w of BrowserWindow.getAllWindows()) for (const e of events) w.webContents.send(channel, e);
  }, { channel: CHANNEL, events });

const seatChurn = (board: ProofBoard) => {
  const bindings = (board.model.nodes as ReadonlyArray<{ kind: string; bindingId?: string }>)
    .filter((n) => n.kind === "agent" && typeof n.bindingId === "string")
    .map((n) => n.bindingId!);
  const machine = new SeatStateMachine({ now: () => Date.now() });
  for (const b of bindings) machine.bind(b, { harness: "codex", epoch: "ladder" });
  let turn = 0;
  let generation = 0;
  return {
    /** The content every shot is taken with: each seat idle, freshly bound, no unseen turn. */
    baseline: async (app: ElectronApplication): Promise<void> => {
      generation += 1;
      const fresh = new SeatStateMachine({ now: () => Date.now() });
      for (const b of bindings) fresh.bind(b, { harness: "codex", epoch: `ladder-baseline-${String(generation)}` });
      await send(app, bindings.map((b) => fresh.force(b, "idle", "ladder:baseline")));
      fresh.dispose();
    },
    /**
     * A third of the seats, a different third each turn, go to work: the line
     * reads "working", the portrait takes its working expression and the ring
     * turns. Attention is left out: it raises a "waiting on you" bubble and a
     * "wants your input" line that outlive the seat's next generation, so no
     * baseline event could put the reference's content back.
     */
    churn: (app: ElectronApplication) => {
      turn += 1;
      return send(app, bindings.filter((_, i) => (i + turn) % 3 === 0).map((b) => machine.force(b, "working", "ladder:churn")));
    },
  };
};

// --- pictures ------------------------------------------------------------------

const shot = async (page: Page, clip?: Rect): Promise<PngImage> => PNG.sync.read(await page.screenshot(clip === undefined ? {} : { clip }));

const delta = (a: PngImage, i: number, b: PngImage, j: number): number =>
  Math.max(Math.abs(a.data[i]! - b.data[j]!), Math.abs(a.data[i + 1]! - b.data[j + 1]!), Math.abs(a.data[i + 2]! - b.data[j + 2]!));

/**
 * Check (a): changed pixels, and the CSS-px blocks that hold at least 24 of
 * them. A block is 16 CSS px and 24 changed pixels is 9.4% of it, at any
 * device scale: at dpr 2 the same fault covers four times the device pixels,
 * and a rule written in device pixels would make the 2x arm four times as
 * sensitive as the 1x arm.
 */
const compareStop = (reference: PngImage, now: PngImage, dpr: number): { changed: number; blocks: number; diff: PngImage } => {
  const { width, height } = reference;
  const block = Math.round(16 * dpr);
  const perBlock = Math.round(24 * dpr * dpr);
  const diff = new PNG({ width, height });
  const blockCounts = new Map<number, number>();
  let changed = 0;
  const same = now.width === width && now.height === height;
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 4;
    const hot = !same || delta(reference, i, now, i) > 48;
    diff.data[i] = hot ? 255 : reference.data[i]! >> 2;
    diff.data[i + 1] = hot ? 0 : reference.data[i + 1]! >> 2;
    diff.data[i + 2] = hot ? 255 : reference.data[i + 2]! >> 2;
    diff.data[i + 3] = 255;
    if (!hot) continue;
    changed += 1;
    const key = Math.floor(p / width / block) * 10_000 + Math.floor((p % width) / block);
    blockCounts.set(key, (blockCounts.get(key) ?? 0) + 1);
  }
  let blocks = 0;
  for (const n of blockCounts.values()) if (n >= perBlock) blocks += 1;
  return { changed, blocks, diff };
};

/** Grown mask of the pixels that differ between two frames of the same camera, in device px. */
const growMask = (moving: Uint8Array, width: number, height: number, grow: number): Uint8Array => {
  const grown = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (moving[y * width + x] === 0) continue;
      for (let dy = -grow; dy <= grow; dy += 1) {
        for (let dx = -grow; dx <= grow; dx += 1) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < height && xx >= 0 && xx < width) grown[yy * width + xx] = 1;
        }
      }
    }
  }
  return grown;
};

/** Pixels that moved across unheld shots (the board's own motion), grown by 3 CSS px. */
const motionMask = (shots: ReadonlyArray<PngImage>, dpr: number): Uint8Array => {
  const grow = Math.round(3 * dpr);
  const { width, height } = shots[0]!;
  const moving = new Uint8Array(width * height);
  for (let s = 1; s < shots.length; s += 1) {
    for (let p = 0; p < width * height; p += 1) if (delta(shots[0]!, p * 4, shots[s]!, p * 4) > 24) moving[p] = 1;
  }
  return growMask(moving, width, height, grow);
};

/**
 * What the engine says it draws moving, at this frame: every drawn part that
 * carries a motion (`turn` for a ring, `pulse`, `reach`, `rise`, ...), its
 * placed rect in page CSS px, grown by 2 CSS px. Whatever holds still is not
 * masked even inside a moving record's box: a portrait or a picture that pops
 * inside a turning ring's box is still compared. canvas-lead's ruling,
 * 2026-11-25: mask the engine's moving records, never every pixel that
 * changed, because a changed pixel is exactly what the operator reported.
 */
const movingRecords = async (
  page: Page,
  ids: ReadonlyArray<string>,
  dpr: number,
  width: number,
  height: number,
): Promise<{ mask: Uint8Array; share: number; records: number; largest: Rect | null }> => {
  const parts = await page.evaluate((nodeIds) => {
    const hook = (window as unknown as { __juntoCanvas?: { partsOf?: (id: string) => ReadonlyArray<{ kind: string; drawn: boolean; rect: { x: number; y: number; width: number; height: number }; motion?: string }> } }).__juntoCanvas;
    const out: Array<{ kind: string; drawn: boolean; rect: { x: number; y: number; width: number; height: number }; motion?: string }> = [];
    for (const id of nodeIds) for (const part of hook?.partsOf?.(id) ?? []) out.push(part);
    return out;
  }, [...ids]);
  const grow = Math.round(2 * dpr);
  const mask = new Uint8Array(width * height);
  const fill = (rect: Rect, value: number): void => {
    const x0 = Math.max(0, Math.floor(rect.x * dpr) - grow);
    const y0 = Math.max(0, Math.floor(rect.y * dpr) - grow);
    const x1 = Math.min(width, Math.ceil((rect.x + rect.width) * dpr) + grow);
    const y1 = Math.min(height, Math.ceil((rect.y + rect.height) * dpr) + grow);
    for (let y = y0; y < y1; y += 1) mask.fill(value, y * width + x0, y * width + x1);
  };
  let records = 0;
  let largest: Rect | null = null;
  for (const part of parts) {
    if (part.drawn !== true || part.motion === undefined) continue;
    records += 1;
    if (largest === null || part.rect.width * part.rect.height > largest.width * largest.height) largest = part.rect;
    fill(part.rect, 1);
  }
  // A picture holds still inside a turning ring's box: unmask the sprites that carry no motion.
  for (const part of parts) {
    if (part.drawn !== true || part.kind !== "sprite" || part.motion !== undefined) continue;
    fill(part.rect, 0);
  }
  let masked = 0;
  for (let p = 0; p < mask.length; p += 1) masked += mask[p]!;
  return { mask, share: masked / mask.length, records, largest };
};

/**
 * A zoom-end frame against a reference at another camera: each frame pixel is
 * mapped to the board, then to the reference's pixel at its camera. Both are
 * averaged over 8 CSS px blocks; a block is hot over ZOOM_END_BLOCK_TOLERANCE;
 * the frame fails on a connected group of 12 hot blocks, about a 28 CSS px
 * square. Blocks are CSS px, so the 2x arm has the 1x arm's sensitivity: in
 * device pixels the same ring arc covers four times the area at dpr 2.
 */
/**
 * The pane's device pixels that lie under DOM (top bar, bottom bar, any
 * panel): the element hit there is not the one hit across most of the pane,
 * the canvas. Sampled every 4 CSS px. A zoom-end frame maps canvas pixels onto
 * the reference; where either end of that mapping is DOM, the two pixels are
 * not the same thing and are not compared.
 */
const overlayMask = async (page: Page, pane: Rect, dpr: number): Promise<{ mask: Uint8Array; share: number }> => {
  const step = 4;
  const cells = await page.evaluate(({ pane, step }) => {
    const cols = Math.ceil(pane.width / step);
    const rows = Math.ceil(pane.height / step);
    const hits: Array<Element | null> = [];
    const counts = new Map<Element, number>();
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const el = document.elementFromPoint(pane.x + Math.min(pane.width - 1, c * step + step / 2), pane.y + Math.min(pane.height - 1, r * step + step / 2));
        hits.push(el);
        if (el) counts.set(el, (counts.get(el) ?? 0) + 1);
      }
    }
    const base = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { cols, rows, over: hits.map((el) => (el === base ? 0 : 1)) };
  }, { pane, step });
  const width = Math.round(pane.width * dpr);
  const height = Math.round(pane.height * dpr);
  const mask = new Uint8Array(width * height);
  let over = 0;
  for (let y = 0; y < height; y += 1) {
    const r = Math.min(cells.rows - 1, Math.floor(y / dpr / step));
    for (let x = 0; x < width; x += 1) {
      const c = Math.min(cells.cols - 1, Math.floor(x / dpr / step));
      if (cells.over[r * cells.cols + c] === 1) {
        mask[y * width + x] = 1;
        over += 1;
      }
    }
  }
  return { mask, share: over / mask.length };
};

/**
 * A zoom-end block is hot when one channel of its mean colour differs from
 * the mapped reference's by more than this (of 255): looser than a stop,
 * which compares pixel by pixel, because the frame is unsettled and may draw
 * a scaled stand-in.
 */
const ZOOM_END_BLOCK_TOLERANCE = 40;

const compareZoomEnd = (
  ref: { image: PngImage; mask: Uint8Array; camera: Camera },
  frame: PngImage,
  camera: Camera,
  dpr: number,
  overlay: Uint8Array,
  moving: Uint8Array | undefined,
): { worstGroup: number; hot: number; diff: PngImage } => {
  const B = Math.round(8 * dpr);
  const bw = Math.floor(frame.width / B);
  const bh = Math.floor(frame.height / B);
  const hot = new Uint8Array(bw * bh);
  const diff = new PNG({ width: frame.width, height: frame.height });
  frame.data.copy(diff.data);
  for (let p = 0; p < diff.data.length; p += 4) {
    diff.data[p] = diff.data[p]! >> 2;
    diff.data[p + 1] = diff.data[p + 1]! >> 2;
    diff.data[p + 2] = diff.data[p + 2]! >> 2;
  }
  const scale = ref.camera.zoom / camera.zoom;
  let hotCount = 0;
  for (let by = 0; by < bh; by += 1) {
    for (let bx = 0; bx < bw; bx += 1) {
      // Downsampled: the block's mean colour in the frame against the mean of
      // the reference pixels it maps to. A scaled stand-in (softer, shifted
      // by a subpixel) keeps its block means; another drawing does not.
      const fm = [0, 0, 0];
      const rm = [0, 0, 0];
      let n = 0;
      let skip = false;
      for (let y = by * B; y < by * B + B && !skip; y += 1) {
        for (let x = bx * B; x < bx * B + B; x += 1) {
          // Clip coordinates (pane space, device px) -> reference pixel.
          const rx = Math.round((x / dpr - camera.x) * scale * dpr + ref.camera.x * dpr);
          const ry = Math.round((y / dpr - camera.y) * scale * dpr + ref.camera.y * dpr);
          if (
            rx < 0 ||
            ry < 0 ||
            rx >= ref.image.width ||
            ry >= ref.image.height ||
            ref.mask[ry * ref.image.width + rx] === 1 ||
            overlay[y * frame.width + x] === 1 ||
            overlay[ry * ref.image.width + rx] === 1 ||
            moving?.[y * frame.width + x] === 1
          ) {
            skip = true;
            break;
          }
          const fi = (y * frame.width + x) * 4;
          const ri = (ry * ref.image.width + rx) * 4;
          for (let c = 0; c < 3; c += 1) {
            fm[c] += frame.data[fi + c]!;
            rm[c] += ref.image.data[ri + c]!;
          }
          n += 1;
        }
      }
      if (skip || n === 0) continue;
      const meanDelta = Math.max(Math.abs(fm[0]! - rm[0]!), Math.abs(fm[1]! - rm[1]!), Math.abs(fm[2]! - rm[2]!)) / n;
      if (meanDelta <= ZOOM_END_BLOCK_TOLERANCE) continue;
      hot[by * bw + bx] = 1;
      hotCount += 1;
      for (let y = by * B; y < by * B + B; y += 1) {
        for (let x = bx * B; x < bx * B + B; x += 1) {
          const i = (y * frame.width + x) * 4;
          diff.data[i] = 255;
          diff.data[i + 1] = 0;
          diff.data[i + 2] = 255;
        }
      }
    }
  }
  // The largest 4-connected group of hot blocks.
  let worstGroup = 0;
  const seen = new Uint8Array(bw * bh);
  for (let start = 0; start < hot.length; start += 1) {
    if (hot[start] === 0 || seen[start] === 1) continue;
    let size = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const at = stack.pop()!;
      size += 1;
      const x = at % bw;
      const y = Math.floor(at / bw);
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const next = ny * bw + nx;
        if (hot[next] === 1 && seen[next] === 0) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    worstGroup = Math.max(worstGroup, size);
  }
  return { worstGroup, hot: hotCount, diff };
};

/** A box-filtered copy `factor` times smaller, for the contact sheet. */
const shrink = (image: PngImage, factor: number): PngImage => {
  const width = Math.floor(image.width / factor);
  const height = Math.floor(image.height / factor);
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const acc = [0, 0, 0];
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const i = ((y * factor + dy) * image.width + x * factor + dx) * 4;
          acc[0]! += image.data[i]!;
          acc[1]! += image.data[i + 1]!;
          acc[2]! += image.data[i + 2]!;
        }
      }
      const o = (y * width + x) * 4;
      out.data[o] = acc[0]! / (factor * factor);
      out.data[o + 1] = acc[1]! / (factor * factor);
      out.data[o + 2] = acc[2]! / (factor * factor);
      out.data[o + 3] = 255;
    }
  }
  return out;
};

/** reference | after | diff, side by side, 6 times smaller. */
const strip = (images: ReadonlyArray<PngImage>): PngImage => {
  const small = images.map((i) => shrink(i, 6));
  const width = small.reduce((w, i) => w + i.width, 0) + 8 * (small.length - 1);
  const height = Math.max(...small.map((i) => i.height));
  const out = new PNG({ width, height });
  out.data.fill(255);
  let x0 = 0;
  for (const img of small) {
    for (let y = 0; y < img.height; y += 1) img.data.copy(out.data, (y * width + x0) * 4, y * img.width * 4, (y + 1) * img.width * 4);
    x0 += img.width + 8;
  }
  return out;
};

/**
 * Where a leg captures its frame: just past the tier boundary it crosses, as
 * the hysteresis places it (in: the boundary plus 0.03, out: minus 0.03), or
 * the geometric middle of a leg inside one tier.
 */
const captureZoom = (from: number, to: number): number => {
  for (const edge of [TIER_FAR_MIN, TIER_MID_MIN, TIER_NEAR_MIN]) {
    if (to > from && from < edge + TIER_HYSTERESIS && edge + TIER_HYSTERESIS < to) return Math.min(to, (edge + TIER_HYSTERESIS) * 1.02);
    if (to < from && to < edge - TIER_HYSTERESIS && edge - TIER_HYSTERESIS < from) return Math.max(to, (edge - TIER_HYSTERESIS) / 1.02);
  }
  return Math.sqrt(from * to);
};

const tierOf = (zoom: number): string => (zoom >= TIER_NEAR_MIN ? "near" : zoom >= TIER_MID_MIN ? "mid" : zoom >= TIER_FAR_MIN ? "far" : "overview");

const cameraAt = (pane: Rect, place: Place, zoom: number): Camera => ({
  x: pane.width / 2 - place.x * zoom,
  y: pane.height / 2 - place.y * zoom,
  zoom,
});

/** A pinch about the pane centre, one wheel event a display frame, stopping `part` of the way. */
const pinch = async (page: Page, at: { x: number; y: number }, from: number, to: number): Promise<void> => {
  const cdp = await page.context().newCDPSession(page);
  const total = -Math.log2(to / from) / 0.02;
  const steps = Math.max(2, Math.ceil(Math.abs(total) / 3));
  const started = Date.now();
  const sent: Array<Promise<unknown>> = [];
  try {
    for (let step = 0; step < steps; step += 1) {
      const wait = started + step * 16 - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
      sent.push(cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: total / steps, modifiers: 2 }));
    }
    // Every wheel event delivered before the gesture counts as over.
    await Promise.all(sent);
  } finally {
    await cdp.detach().catch(() => undefined);
  }
};

/** The camera once it has held still for three display frames (the gesture is over; the atlas need not be). */
const stillCamera = async (page: Page): Promise<Camera> => {
  const read = () =>
    page.evaluate(
      () =>
        new Promise<{ x: number; y: number; zoom: number }>((resolve) => {
          requestAnimationFrame(() => {
            const hook = (window as unknown as { __juntoCanvas?: { camera?: () => { x: number; y: number; zoom: number } } }).__juntoCanvas;
            resolve(hook?.camera?.() ?? { x: 0, y: 0, zoom: 1 });
          });
        }),
    );
  let last = await read();
  let held = 0;
  for (let i = 0; i < 120 && held < 3; i += 1) {
    const at = await read();
    held = at.x === last.x && at.y === last.y && at.zoom === last.zoom ? held + 1 : 0;
    last = at;
  }
  return last;
};

const sameCamera = (a: Camera, b: Camera): boolean => a.x === b.x && a.y === b.y && a.zoom === b.zoom;

// --- the run -------------------------------------------------------------------

type Reference = { image: PngImage; unheld: PngImage; mask: Uint8Array; camera: Camera; path: string };
const refKey = (place: string, zoom: number): string => `${place}@${String(zoom)}`;

test.describe.configure({ mode: "serial" });

test("the zoom ladder: every stop's screenshot equals its fresh-launch reference, the atlas audits clean, no GPU error", async () => {
  test.setTimeout(150 * 60_000);
  await mkdir(join(OUT, "stops"), { recursive: true });
  await mkdir(join(OUT, "references"), { recursive: true });
  await mkdir(join(OUT, "contact"), { recursive: true });
  const fixture: NestedCanvasFixture = JSON_FIXTURE !== "" ? loadFactoryFixture(JSON_FIXTURE) : buildNestedCanvasFixture(SEED);
  const { board, cluster } = withImageNotes(buildProofBoard(fixture, 1));
  const places = placesOf(board, cluster);
  log("board", { source: JSON_FIXTURE !== "" ? `shapes ${JSON_FIXTURE}` : `seeded ${SEED}`, nodes: board.model.nodes.length });
  const churn = seatChurn(board);
  const server = await servePictures();
  const references = new Map<string, Reference>();
  const contact: Array<{ name: string; strip: string; verdict: string; detail: string }> = [];
  /**
   * A fresh launch placed at exactly this camera, its clocks held like the
   * frame's: the zoom-end frame's own reference. One per distinct camera,
   * cached across cycles.
   */
  const legReferences = new Map<string, { image: PngImage; camera: Camera; tier: string; mask: Uint8Array }>();
  const legReference = async (camera: Camera): Promise<{ image: PngImage; camera: Camera; tier: string; mask: Uint8Array }> => {
    const key = `${camera.x.toFixed(2)},${camera.y.toFixed(2)},${camera.zoom.toFixed(5)}`;
    const hit = legReferences.get(key);
    if (hit !== undefined) return hit;
    const fresh = await launchProofArm(board, { gpu: true });
    try {
      const freshPage = fresh.page;
      await waitGpuReady(freshPage, board);
      await hideMinimap(freshPage);
      await churn.baseline(fresh.app);
      await freshPage.waitForTimeout(1_500);
      const freshPane = await paneRect(freshPage);
      await placeCamera(freshPage, camera, 400);
      await parkPointer(freshPage, freshPane);
      await settleAtlas(freshPage);
      const release = await holdForShot(freshPage);
      const image = await shot(freshPage);
      await release();
      const state = await readProofState(freshPage);
      const mask = new Uint8Array(image.width * image.height);
      const ref = { image, camera, tier: state.tier, mask };
      legReferences.set(key, ref);
      log(`leg reference ${key}`, { tier: state.tier, gpuErrors: state.gpuErrors?.count, landed: state.atlas?.landed });
      return ref;
    } finally {
      await fresh.close();
    }
  };
  const started = Date.now();
  try {
    log("ladder", { places, ladder: LADDER, cycles: CYCLES, tiers: LADDER.map(tierOf), hysteresis: TIER_HYSTERESIS });

    // --- references: a fresh launch per camera, straight there, baseline content
    for (const place of places) {
      for (const zoom of LADDER) {
        const junto = await launchProofArm(board, { gpu: true });
        try {
          const page = junto.page;
          await waitGpuReady(page, board);
          await hideMinimap(page);
          await churn.baseline(junto.app);
          await page.waitForTimeout(1_500);
          const pane = await paneRect(page);
          const dpr = await page.evaluate(() => window.devicePixelRatio);
          const camera = cameraAt(pane, place, zoom);
          await placeCamera(page, camera, 400);
          await parkPointer(page, pane);
          await settleAtlas(page);
          const unheldShots: PngImage[] = [];
          for (let n = 0; n < 4; n += 1) {
            unheldShots.push(await shot(page, pane));
            await page.waitForTimeout(350);
          }
          const release = await holdForShot(page);
          const image = await shot(page);
          await release();
          const path = join(OUT, "references", `${place.name}-${String(zoom)}.png`);
          await writeFile(path, PNG.sync.write(image));
          references.set(refKey(place.name, zoom), { image, unheld: unheldShots[0]!, mask: motionMask(unheldShots, dpr), camera, path });
          const state = await readProofState(page);
          log(`reference ${refKey(place.name, zoom)}`, { tier: state.tier, gpuErrors: state.gpuErrors?.count, landed: state.atlas?.landed });
          if ((state.gpuErrors?.count ?? 0) > 0) fail(`reference ${refKey(place.name, zoom)}: ${String(state.gpuErrors?.count)} GPU error(s) in a fresh launch`, { last: state.gpuErrors?.last });
        } finally {
          await junto.close();
        }
      }
    }
    log("references done", { seconds: Math.round((Date.now() - started) / 1000) });

    // --- the ladder --------------------------------------------------------------
    const junto = await launchProofArm(board, { gpu: true });
    const page = junto.page;
    try {
      await waitGpuReady(page, board);
      await hideMinimap(page);
      await churn.baseline(junto.app);
      const pane = await paneRect(page);
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      const centre = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };
      const overlay = await overlayMask(page, pane, dpr);
      log("overlay", { share: Math.round(overlay.share * 1000) / 1000 });
      // The scale this run drew at, read from the page and the screenshot itself.
      const probe = await shot(page, pane);
      log("display", { devicePixelRatio: dpr, pane: { width: pane.width, height: pane.height }, shot: { width: probe.width, height: probe.height }, window: process.env["JUNTO_GPU_PROOF_WINDOW"] ?? "operator" });
      if (overlay.share > 0.5) fail(`the DOM overlay mask covers ${String(Math.round(overlay.share * 100))}% of the pane: it would hide the canvas`);
      const launchState = await readProofState(page);
      const seen = {
        errors: launchState.gpuErrors?.count ?? 0,
        since: await page.evaluate(() => performance.now()),
        evictions: (launchState.atlas as { evictions?: number } | null)?.evictions ?? 0,
      };
      if (seen.errors > 0) fail(`ladder launch: ${String(seen.errors)} GPU error(s) before the first stop`);

      // The pop check's control: a seeded fault it must catch, before any leg counts.
      {
        const place = places[0]!;
        await placeCamera(page, cameraAt(pane, place, 1.0), 100);
        await settleAtlas(page);
        const started = await popWatch(page, "start");
        if (started === null && (await popWatch(page, "read")) === null) fail("the build has no popWatch hook");
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await popWatch(page, "seed");
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
        await pinch(page, centre, 1.0, 1.41);
        await stillCamera(page);
        const control = await popWatch(page, "stop");
        log("pop control", { ...control, samples: control?.samples.slice(0, 4) });
        if (control !== null && (control.seeded === 0 || control.pops === 0 || control.blankQuads === 0)) {
          fail(`the pop check missed its seeded fault (seeded ${String(control.seeded)}, pops ${String(control.pops)}, blank quads ${String(control.blankQuads)})`);
        }
        await placeCamera(page, cameraAt(pane, place, LADDER[0]), 100);
        await settleAtlas(page);
      }
      let stopIndex = 0;

      const stop = async (cycle: number, place: Place, zoom: number, way: "in" | "out"): Promise<void> => {
        stopIndex += 1;
        const name = `c${String(cycle)}-${place.name}-${way}-${String(zoom)}`;
        const ref = references.get(refKey(place.name, zoom))!;
        // Churned content back to the baseline, then the exact camera.
        await churn.baseline(junto.app);
        await page.waitForTimeout(1_500);
        await placeCamera(page, ref.camera, 300);
        await parkPointer(page, pane);
        await settleAtlas(page);
        const release = await holdForShot(page);
        const after = await shot(page);
        await release();
        const path = join(OUT, "stops", `${String(stopIndex).padStart(3, "0")}-${name}.png`);
        await writeFile(path, PNG.sync.write(after));
        const before = failures.length;
        const { changed, blocks, diff } = compareStop(ref.image, after, dpr);
        if (blocks > 0) {
          const diffPath = join(OUT, "stops", `${String(stopIndex).padStart(3, "0")}-${name}-diff.png`);
          await writeFile(diffPath, PNG.sync.write(diff));
          fail(`${name}: ${String(blocks)} 16px block(s) differ from the fresh-launch reference (${String(changed)} px)`, { after: path, diff: diffPath, reference: ref.path });
        }
        const facts = await checkStop(page, name, seen);
        const stripPath = `contact/${String(stopIndex).padStart(3, "0")}-${name}.png`;
        await writeFile(join(OUT, stripPath), PNG.sync.write(strip([ref.image, after, diff])));
        const own = failures.slice(before);
        contact.push({ name, strip: stripPath, verdict: own.length === 0 ? "pass" : "fail", detail: own.length === 0 ? `${String(changed)} px changed, 0 blocks` : own.join("; ") });
        log(`stop ${name}`, { changed, blocks, ...facts });
      };

      /** One leg with a zoom-end frame, taken unsettled: past a tier crossing, or halfway. */
      const leg = async (cycle: number, place: Place, from: number, to: number): Promise<void> => {
        const mid = captureZoom(from, to);
        // Churn works the atlas; the baseline puts the reference's content back before the gesture.
        await churn.churn(junto.app);
        await settleAtlas(page);
        await churn.baseline(junto.app);
        await page.waitForTimeout(1_500);
        await settleAtlas(page);
        await popWatch(page, "start");
        await pinch(page, centre, from, mid);
        let camera = await stillCamera(page);
        // A tier leg's frame is past the crossing, hysteresis included: nudge a short landing over it.
        const crossing = mid !== Math.sqrt(from * to);
        for (let nudge = 0; crossing && nudge < 6 && (to > from ? camera.zoom < mid : camera.zoom > mid); nudge += 1) {
          await pinch(page, centre, camera.zoom, to > from ? mid * 1.01 : mid / 1.01);
          camera = await stillCamera(page);
        }
        // The frame and the camera it is mapped with are one moment: the camera holds across the shot.
        let frame = await shot(page, pane);
        for (let retry = 0; retry < 4; retry += 1) {
          const after = await stillCamera(page);
          if (sameCamera(after, camera)) break;
          camera = after;
          frame = await shot(page, pane);
        }
        // The engine's own word on whether anything is still easing: a tier
        // crossing eases every card's drawing over STYLE_TRANSITION_MS, and a
        // frame caught mid-ease differs from a settled reference at every mark.
        // Wait for it (bounded), then take the frame.
        let easedMs = 0;
        for (let waited = 0; waited < 2_000; waited += 100) {
          const busy = await page.evaluate(() => (window as unknown as { __juntoCanvas?: { hasMotion?: () => boolean } }).__juntoCanvas?.hasMotion?.() ?? false);
          if (!busy) break;
          await page.waitForTimeout(100);
          easedMs += 100;
        }
        for (let retry = 0; retry < 4; retry += 1) {
          const after = await stillCamera(page);
          if (sameCamera(after, camera)) break;
          camera = after;
          await page.waitForTimeout(100);
        }
        // The clocks are held for this frame, the way a stop's are, and its own
        // fresh-launch reference is taken the same way: both show phase 0, so a
        // ring's phase is not a difference and the frame compares pixel-aligned.
        const settleHold = await holdForShot(page);
        frame = await shot(page, pane);
        // What the engine says moves this frame: its own moving records, not
        // every pixel that changed (a pop is a change and must fail).
        const moving = await movingRecords(page, board.model.nodes.map((node) => node.id), dpr, frame.width, frame.height);
        const state = { ...(await readProofState(page)), camera };
        await settleHold();
        await pinch(page, centre, state.camera.zoom, to);
        await stillCamera(page);
        const pops = await popWatch(page, "stop");
        const popName = `c${String(cycle)}-${place.name}-pops-${String(from)}-${String(to)}`;
        log(`pops ${popName}`, pops === null ? { hook: false } : { ...pops, samples: pops.samples.slice(0, 4) });
        if (pops !== null && (pops.pops > 0 || pops.blankQuads > 0)) {
          fail(`${popName}: ${String(pops.pops)} quad(s) lost their own pixels at an unchanged raster scale and ${String(pops.blankQuads)} in-view quad(s) drew nothing, over ${String(pops.frames)} frames of the gesture`, { first: pops.samples.slice(0, 8) });
          contact.push({ name: popName, strip: "", verdict: "fail", detail: failures[failures.length - 1]! });
        }
        // The frame's own reference: a fresh launch placed at exactly the
        // camera this frame was taken at, so the comparison is pixel-aligned
        // and needs no mapping. A reference at a different camera misaligns a
        // seat's 12 px mark by about a pixel, which reads as a fault at every
        // seat on a dense board.
        const own = await legReference(state.camera);
        const { worstGroup, hot, diff } = compareZoomEnd({ image: own.image, mask: own.mask, camera: own.camera }, frame, state.camera, dpr, overlay.mask, moving.mask);
        const name = `c${String(cycle)}-${place.name}-zoomend-${String(from)}-${String(to)}`;
        log(`zoomend ${name}`, { aimed: Math.round(mid * 1000) / 1000, zoom: Math.round(state.camera.zoom * 1000) / 1000, tier: state.tier, referenceTier: own.tier, hot, worstGroup, eased: easedMs, masked: Math.round(moving.share * 1000) / 1000, records: moving.records, largestRecord: moving.largest });
        if (own.tier !== state.tier) {
          fail(`${name}: the frame's tier is ${String(state.tier)} and a fresh launch at the same camera is ${String(own.tier)}: the two drawings are different by design`);
        }
        if (worstGroup >= 12) {
          const framePath = join(OUT, "stops", `${name}-frame.png`);
          const diffPath = join(OUT, "stops", `${name}-diff.png`);
          await writeFile(framePath, PNG.sync.write(frame));
          await writeFile(diffPath, PNG.sync.write(diff));
          fail(`${name}: the frame right after the zoom ends holds a wrong picture (${String(worstGroup)} connected 8px CSS-px blocks off a fresh launch at the same camera)`, { frame: framePath, diff: diffPath });
          const stripPath = `contact/${name}.png`;
          await writeFile(join(OUT, stripPath), PNG.sync.write(strip([own.image, frame, diff])));
          contact.push({ name, strip: stripPath, verdict: "fail", detail: failures[failures.length - 1]! });
        }
      };

      /** Fill the atlas: jump across the board at mid and near zoom, settling each time. */
      const tour = async (cycle: number): Promise<void> => {
        const b = board.stats.bounds;
        for (let n = 0; n < 16; n += 1) {
          const gx = ((n * 7 + cycle * 3) % 9) / 8;
          const gy = ((n * 5 + cycle) % 7) / 6;
          const zoom = n % 2 === 0 ? 0.54 : 1.0;
          await churn.churn(junto.app);
          await placeCamera(page, cameraAt(pane, { name: "tour", x: b.x + b.width * (0.05 + 0.9 * gx), y: b.y + b.height * (0.05 + 0.9 * gy) }, zoom), 50);
          await settleAtlas(page);
        }
        log(`tour after cycle ${String(cycle)}`, await atlasCounters(page));
      };

      for (let cycle = 0; cycle < CYCLES; cycle += 1) {
        for (const place of places) {
          await placeCamera(page, cameraAt(pane, place, LADDER[0]), 100);
          await stop(cycle, place, LADDER[0], "in");
          for (let i = 1; i < LADDER.length; i += 1) {
            await leg(cycle, place, LADDER[i - 1]!, LADDER[i]!);
            await stop(cycle, place, LADDER[i]!, "in");
          }
          for (let i = LADDER.length - 2; i >= 0; i -= 1) {
            await leg(cycle, place, LADDER[i + 1]!, LADDER[i]!);
            await stop(cycle, place, LADDER[i]!, "out");
          }
        }
        if (cycle < CYCLES - 1) await tour(cycle);
      }
      const final = await atlasCounters(page);
      log("ladder done", { ...final, stops: stopIndex, minutes: Math.round((Date.now() - started) / 60_000) });
      if (final.evictions === 0) fail(`the ladder never reclaimed a plot (evictions 0 over ${String(stopIndex)} stops): reclaim was not exercised`);
    } finally {
      await junto.close();
    }
  } finally {
    server.close();
    await writeFile(join(OUT, "proof.json"), JSON.stringify({ failures, proof }, null, 2));
    const rows = contact
      .map((c) => `<figure class="${c.verdict}"><figcaption><b>${c.name}</b> ${c.verdict}: ${c.detail.replace(/</g, "&lt;")}</figcaption>${c.strip === "" ? "" : `<img loading="lazy" src="${c.strip}" alt="${c.name}">`}</figure>`)
      .join("\n");
    await writeFile(
      join(OUT, "contact", "..", "index.html"),
      `<!doctype html><meta charset="utf-8"><title>Zoom ladder</title><style>body{font:13px system-ui;background:#111;color:#ddd;margin:16px}figure{margin:0 0 18px}img{max-width:100%}.fail figcaption{color:#ff6b9a}</style><h1>Zoom ladder</h1><p>${String(failures.length)} failure(s). Each strip: reference, after, diff (magenta is changed).</p>${rows}`,
    );
  }
  expect(failures, failures.join("\n")).toEqual([]);
});
