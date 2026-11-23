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
 *       16 px block holding 24 or more changed pixels. The diff is saved on
 *       failure;
 *   (b) `atlasAudit()` and the texel readback (`atlasAuditTexels`) are clean;
 *   (c) no GPU error since the last stop.
 *
 * During each gesture between two stops (each leg crosses one bucket
 * boundary), one frame is captured mid-gesture with the atlas unsettled and
 * compared, downsampled to 8 px blocks, against the reference of the nearest
 * stop of the same tier, mapped to the frame's camera. Tolerance: a block is
 * hot when its mean channel delta is over 56, and the frame fails on a
 * connected group of 12 or more hot blocks (about a 28 px square, smaller
 * than a mid-tier portrait). A scaled stand-in blurs or sharpens and stays
 * under that; another item's pixels, a missing portrait, a black disc or a
 * whole page drawn in a quad do not.
 *
 * What legitimately differs between two launches, and how it is held for the
 * shot (nothing else is masked):
 *   - ring phase and every clock-driven motion on the canvas: the frame clocks
 *     are held (`holdClocks`) at an epoch multiple of MARK_PHASE_MS, the one
 *     period every ring, band and reach motion divides, so each shows phase 0;
 *   - CSS animations in the DOM (rings in the bars): paused at phase 0;
 *   - the DOM minimap: hidden, because it frames to the camera's travel, not
 *     to the camera;
 *   - the DOM hotbar (the top bar's group slots): hidden, because it leases
 *     slots by the recency of seat activity, which is the churn's history;
 *   - the pointer: parked at the same pane corner in both launches;
 *   - churned content: every seat gets the baseline event again before the
 *     shot, the one the reference launch was given: idle from a freshly bound
 *     state machine, with no unseen turn. An idle from the churn's own machine
 *     would carry the churned turn as unseen ("done, not read yet").
 * A frame captured during a gesture cannot hold its clocks (a transition
 * started under a held clock never ends), so it skips the pixels that moved
 * across four unheld reference shots: the board's own motion.
 *
 * The run fails if the atlas never evicted a plot (reclaim never exercised).
 *
 * Run (the fixture must be a copy; the live database is refused):
 *   sqlite3 "file:$HOME/.junto/state/junto.db?mode=ro" ".backup '/tmp/junto-factory.db'"
 *   JUNTO_GPU_PROOF=1 JUNTO_FACTORY_DB=/tmp/junto-factory.db \
 *     bun run test:e2e:fast e2e/scenarios/gpu-zoom-ladder.spec.ts
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
import type { NestedCanvasFixture } from "../harness/nested-canvas-fixture";
import {
  buildProofBoard,
  launchProofArm,
  loadFactoryBoard,
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

const DB = process.env["JUNTO_FACTORY_DB"] ?? "";
const JSON_FIXTURE = process.env["JUNTO_FACTORY_JSON"] ?? "";
const ENABLED = process.env["JUNTO_GPU_PROOF"] === "1" && (DB !== "" || JSON_FIXTURE !== "");
const OUT = process.env["JUNTO_ZOOM_LADDER_OUT"] ?? "/tmp/junto-zoom-ladder";
const CYCLES = Number(process.env["JUNTO_ZOOM_LADDER_CYCLES"] ?? 3);
/** The note images' server: a fixed port, because the seeded board names it. */
const IMAGE_PORT = Number(process.env["JUNTO_ZOOM_LADDER_IMAGE_PORT"] ?? 47391);
const CHANNEL = "junto:agent-seat-state-changed";

test.skip(!ENABLED, "set JUNTO_GPU_PROOF=1 and JUNTO_FACTORY_DB=<copy of junto.db> (or JUNTO_FACTORY_JSON=<saved fixture>)");

/**
 * One stop per raster bucket at the operator's pixel ratio 2, each clear of
 * every hysteresis band: buckets k = -3..5 of round(2 log2(2 zoom)).
 */
const LADDER = [0.15, 0.26, 0.36, 0.54, 0.74, 1.0, 1.41, 2.0, 2.5] as const;

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type Camera = { readonly x: number; readonly y: number; readonly zoom: number };
type Place = { readonly name: string; readonly x: number; readonly y: number };
type Audit = { checked: number; heldCells: number; counts: Record<string, number>; samples: Array<Record<string, unknown>> };
type TexelAudit = { checked: number; skipped: Record<string, number>; mismatches: Array<Record<string, unknown>>; worst: number };

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
  const centre = regions[0]!.r;
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

const auditTexels = (page: Page): Promise<TexelAudit | null> =>
  page.evaluate(async () => {
    const hook = (window as unknown as { __juntoCanvas?: { atlasAuditTexels?: (limit?: number) => Promise<unknown> | null } }).__juntoCanvas;
    return ((await hook?.atlasAuditTexels?.(600)) ?? null) as TexelAudit | null;
  });

/** Checks (b) and (c) at one stop. `seen` carries the GPU error count across stops. */
const checkStop = async (page: Page, where: string, seen: { errors: number }): Promise<Record<string, unknown>> => {
  const state = await readProofState(page);
  const atlas = state.atlas as (typeof state.atlas & { compactions?: number }) | null;
  const errors = state.gpuErrors?.count ?? 0;
  if (state.gpuErrors === null) fail(`${where}: the build has no gpuErrors hook`);
  else if (errors > seen.errors) fail(`${where}: ${String(errors - seen.errors)} GPU error(s) since the last stop`, { last: state.gpuErrors.last });
  seen.errors = errors;
  const a = await audit(page);
  if (a === null) fail(`${where}: the build has no atlasAudit hook`);
  else if (Object.keys(a.counts).length > 0) fail(`${where}: atlas audit`, { counts: a.counts, checked: a.checked, first: a.samples.slice(0, 6) });
  const t = await auditTexels(page);
  if (t === null) fail(`${where}: the build has no atlasAuditTexels hook`);
  else if (t.mismatches.length > 0) fail(`${where}: ${String(t.mismatches.length)} landed sprite cell(s) hold another drawing`, { first: t.mismatches.slice(0, 6) });
  return {
    tier: state.tier,
    zoom: Math.round(state.camera.zoom * 1000) / 1000,
    evictions: atlas?.evictions,
    compactions: atlas?.compactions,
    pages: atlas?.pages,
    landed: atlas?.landed,
    gpuErrors: errors,
    audit: a === null ? null : { checked: a.checked, counts: a.counts },
    texels: t === null ? null : { checked: t.checked, mismatches: t.mismatches.length, worst: Math.round(t.worst * 10) / 10 },
  };
};

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
  return {
    /** The content every shot is taken with: each seat idle, freshly bound, no unseen turn. */
    baseline: async (app: ElectronApplication): Promise<void> => {
      const fresh = new SeatStateMachine({ now: () => Date.now() });
      for (const b of bindings) fresh.bind(b, { harness: "codex", epoch: "ladder" });
      await send(app, bindings.map((b) => fresh.force(b, "idle", "ladder:baseline")));
      fresh.dispose();
      for (const b of bindings) machine.force(b, "idle", "ladder:baseline");
    },
    /** A share of seats change their line and their expression. */
    churn: (app: ElectronApplication) => {
      turn += 1;
      const events = bindings
        .filter((_, i) => (i + turn) % 3 === 0)
        .map((b, i) =>
          (i + turn) % 2 === 0
            ? machine.force(b, "working", "ladder:churn")
            : machine.force(b, "attention", `churn ${String(turn)}: reading the ${String(turn * 7 + i)} files it wrote`),
        );
      return send(app, events);
    },
  };
};

// --- pictures ------------------------------------------------------------------

const shot = async (page: Page, clip?: Rect): Promise<PngImage> => PNG.sync.read(await page.screenshot(clip === undefined ? {} : { clip }));

const delta = (a: PngImage, i: number, b: PngImage, j: number): number =>
  Math.max(Math.abs(a.data[i]! - b.data[j]!), Math.abs(a.data[i + 1]! - b.data[j + 1]!), Math.abs(a.data[i + 2]! - b.data[j + 2]!));

/** Check (a): changed pixels, and the 16 px blocks that hold at least 24 of them. */
const compareStop = (reference: PngImage, now: PngImage): { changed: number; blocks: number; diff: PngImage } => {
  const { width, height } = reference;
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
    const key = Math.floor(p / width / 16) * 10_000 + Math.floor((p % width) / 16);
    blockCounts.set(key, (blockCounts.get(key) ?? 0) + 1);
  }
  let blocks = 0;
  for (const n of blockCounts.values()) if (n >= 24) blocks += 1;
  return { changed, blocks, diff };
};

/** Pixels that moved across unheld shots (the board's own motion), grown by 3 px. */
const motionMask = (shots: ReadonlyArray<PngImage>): Uint8Array => {
  const { width, height } = shots[0]!;
  const moving = new Uint8Array(width * height);
  for (let s = 1; s < shots.length; s += 1) {
    for (let p = 0; p < width * height; p += 1) if (delta(shots[0]!, p * 4, shots[s]!, p * 4) > 24) moving[p] = 1;
  }
  const grown = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (moving[y * width + x] === 0) continue;
      for (let dy = -3; dy <= 3; dy += 1) {
        for (let dx = -3; dx <= 3; dx += 1) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < height && xx >= 0 && xx < width) grown[yy * width + xx] = 1;
        }
      }
    }
  }
  return grown;
};

/**
 * A gesture frame against a reference at another camera: each frame pixel is
 * mapped to the board, then to the reference's pixel at its camera. Both are
 * averaged over 8 px blocks; a block is hot over a mean delta of 56; the frame
 * fails on a connected group of 12 hot blocks.
 */
const compareGesture = (
  ref: { image: PngImage; mask: Uint8Array; camera: Camera },
  frame: PngImage,
  camera: Camera,
  dpr: number,
): { worstGroup: number; hot: number; diff: PngImage } => {
  const B = 8;
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
      let sum = 0;
      let n = 0;
      let skip = false;
      for (let y = by * B; y < by * B + B && !skip; y += 1) {
        for (let x = bx * B; x < bx * B + B; x += 1) {
          // Clip coordinates (pane space, device px) -> reference pixel.
          const rx = Math.round((x / dpr - camera.x) * scale * dpr + ref.camera.x * dpr);
          const ry = Math.round((y / dpr - camera.y) * scale * dpr + ref.camera.y * dpr);
          if (rx < 0 || ry < 0 || rx >= ref.image.width || ry >= ref.image.height || ref.mask[ry * ref.image.width + rx] === 1) {
            skip = true;
            break;
          }
          sum += delta(frame, (y * frame.width + x) * 4, ref.image, (ry * ref.image.width + rx) * 4);
          n += 1;
        }
      }
      if (skip || n === 0 || sum / n <= 56) continue;
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
  try {
    for (let step = 0; step < steps; step += 1) {
      const wait = started + step * 16 - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
      void cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: total / steps, modifiers: 2 }).catch(() => undefined);
    }
  } finally {
    await cdp.detach().catch(() => undefined);
  }
};

// --- the run -------------------------------------------------------------------

type Reference = { image: PngImage; unheld: PngImage; mask: Uint8Array; camera: Camera; path: string };
const refKey = (place: string, zoom: number): string => `${place}@${String(zoom)}`;

test.describe.configure({ mode: "serial" });

test("the zoom ladder: every stop's screenshot equals its fresh-launch reference, the atlas audits clean, no GPU error", async () => {
  test.setTimeout(150 * 60_000);
  await mkdir(join(OUT, "stops"), { recursive: true });
  await mkdir(join(OUT, "references"), { recursive: true });
  await mkdir(join(OUT, "contact"), { recursive: true });
  const fixture: NestedCanvasFixture = DB === "" && JSON_FIXTURE !== "" ? loadFactoryFixture(JSON_FIXTURE) : loadFactoryBoard(DB).fixture;
  const { board, cluster } = withImageNotes(buildProofBoard(fixture, 1));
  const places = placesOf(board, cluster);
  const churn = seatChurn(board);
  const server = await servePictures();
  const references = new Map<string, Reference>();
  const contact: Array<{ name: string; strip: string; verdict: string; detail: string }> = [];
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
          references.set(refKey(place.name, zoom), { image, unheld: unheldShots[0]!, mask: motionMask(unheldShots), camera, path });
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
      const seen = { errors: (await readProofState(page)).gpuErrors?.count ?? 0 };
      if (seen.errors > 0) fail(`ladder launch: ${String(seen.errors)} GPU error(s) before the first stop`);
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
        const { changed, blocks, diff } = compareStop(ref.image, after);
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

      /** One gesture leg with a frame captured halfway, unsettled. */
      const leg = async (cycle: number, place: Place, from: number, to: number): Promise<void> => {
        const mid = Math.sqrt(from * to);
        await churn.churn(junto.app);
        await pinch(page, centre, from, mid);
        const frame = await shot(page, pane);
        const state = await readProofState(page);
        await pinch(page, centre, state.camera.zoom, to);
        // The nearest stop of the frame's own tier, in log zoom.
        const candidates = [from, to].filter((z) => tierOf(z) === state.tier);
        const nearest = (candidates.length > 0 ? candidates : [from, to]).sort(
          (a, b) => Math.abs(Math.log2(a / state.camera.zoom)) - Math.abs(Math.log2(b / state.camera.zoom)),
        )[0]!;
        const ref = references.get(refKey(place.name, nearest))!;
        const { worstGroup, hot, diff } = compareGesture({ image: ref.unheld, mask: ref.mask, camera: ref.camera }, frame, state.camera, dpr);
        const name = `c${String(cycle)}-${place.name}-gesture-${String(from)}-${String(to)}`;
        log(`gesture ${name}`, { zoom: Math.round(state.camera.zoom * 1000) / 1000, tier: state.tier, against: nearest, hot, worstGroup });
        if (worstGroup >= 12) {
          const framePath = join(OUT, "stops", `${name}-frame.png`);
          const diffPath = join(OUT, "stops", `${name}-diff.png`);
          await writeFile(framePath, PNG.sync.write(frame));
          await writeFile(diffPath, PNG.sync.write(diff));
          fail(`${name}: a frame mid-gesture holds a wrong picture (${String(worstGroup)} connected 8px blocks off the ${String(nearest)} reference)`, { frame: framePath, diff: diffPath });
          const stripPath = `contact/${name}.png`;
          await writeFile(join(OUT, stripPath), PNG.sync.write(strip([ref.unheld, frame, diff])));
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
      .map((c) => `<figure class="${c.verdict}"><figcaption><b>${c.name}</b> ${c.verdict}: ${c.detail.replace(/</g, "&lt;")}</figcaption><img loading="lazy" src="${c.strip}" alt="${c.name}"></figure>`)
      .join("\n");
    await writeFile(
      join(OUT, "contact", "..", "index.html"),
      `<!doctype html><meta charset="utf-8"><title>Zoom ladder</title><style>body{font:13px system-ui;background:#111;color:#ddd;margin:16px}figure{margin:0 0 18px}img{max-width:100%}.fail figcaption{color:#ff6b9a}</style><h1>Zoom ladder</h1><p>${String(failures.length)} failure(s). Each strip: reference, after, diff (magenta is changed).</p>${rows}`,
    );
  }
  expect(failures, failures.join("\n")).toEqual([]);
});
