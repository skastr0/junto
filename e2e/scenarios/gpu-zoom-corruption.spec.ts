/**
 * The zoom-corruption gate (operator priority, 2026-11-23): on the factory
 * board, zooming in and out made quads draw other items' pixels and made
 * cards and portraits pop. This spec reproduces it in the real app and is the
 * gate any fix must pass.
 *
 * A cold launch, then trackpad zoom gestures about the pointer through every
 * tier (overview to near and back, at varied pointer points), until the atlas
 * has both evicted plots and compacted one. It fails on:
 *   - any uncaught GPU error (`gpuErrors`), which a dropped copy raises;
 *   - any broken cell-table invariant (`atlasAudit`): a row that is not its
 *     own slot's rect, a stand-in whose row no longer matches its target, a
 *     held cell that was freed, overlapping live rects, a pinned miscount;
 *   - any landed sprite cell whose texels differ from a fresh raster of its
 *     own quad at its own scale (`atlasAuditTexels`);
 *   - any frame that differs from a settled reference at the same camera,
 *     outside the pixels the board's own motion moves.
 *
 * The board is never a copy of anyone's database: the seeded factory-like
 * board (JUNTO_ZOOM_GATE_SEED names another preset), or a real board's
 * shapes file, JUNTO_FACTORY_JSON (made-up ids and names; rects, kinds,
 * region colours and wire verbs only).
 *
 * Run (on the Mac mini, scripts/mini.sh):
 *   JUNTO_GPU_PROOF=1 scripts/run-e2e.sh e2e/scenarios/gpu-zoom-corruption.spec.ts
 * Images and the report land in JUNTO_ZOOM_GATE_OUT (default /tmp/junto-zoom-gate).
 */

import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
const SEED = (process.env["JUNTO_ZOOM_GATE_SEED"] ?? "factory-like") as NestedCanvasPresetName;
const ENABLED = process.env["JUNTO_GPU_PROOF"] === "1";
const OUT = process.env["JUNTO_ZOOM_GATE_OUT"] ?? "/tmp/junto-zoom-gate";
const MAX_CYCLES = Number(process.env["JUNTO_ZOOM_GATE_CYCLES"] ?? 80);

test.skip(!ENABLED, "set JUNTO_GPU_PROOF=1 (and JUNTO_FACTORY_JSON=<a real board's shapes> for one)");

/** One camera per tier, centred on the board: overview, far, mid, near. */
const REFERENCE_ZOOMS = [0.15, 0.3, 0.52, 0.9] as const;
/** One gesture cycle: in past near, out through far, in again, and out to overview every third cycle. */
const CYCLE = [2.5, 0.52, 1.6, 0.3, 2.0, 0.9] as const;

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type Audit = { checked: number; heldCells: number; counts: Record<string, number>; samples: Array<Record<string, unknown>> };
type TexelAudit = { checked: number; skipped: Record<string, number>; mismatches: Array<Record<string, unknown>>; worst: number };

const failures: string[] = [];
const report: Record<string, unknown>[] = [];
const log = (line: string, data: Record<string, unknown> = {}): void => {
  console.log(`${line}${Object.keys(data).length === 0 ? "" : ` ${JSON.stringify(data)}`}`);
  report.push({ line, ...data });
};
const fail = (line: string, data: Record<string, unknown> = {}): void => {
  failures.push(line);
  log(`FAIL ${line}`, data);
};

const fixture = ((): NestedCanvasFixture | null => {
  if (!ENABLED) return null;
  return JSON_FIXTURE !== "" ? loadFactoryFixture(JSON_FIXTURE) : buildNestedCanvasFixture(SEED);
})();

const audit = (page: Page): Promise<Audit | null> =>
  page.evaluate(() => {
    const hook = (window as unknown as { __juntoCanvas?: { atlasAudit?: () => unknown } }).__juntoCanvas;
    return (hook?.atlasAudit?.() ?? null) as Audit | null;
  });

/** The texel readback's limit: a check that reaches it stopped before the end. */
const TEXEL_LIMIT = 600;

/**
 * What the texel check compared and what it did not. It covers landed,
 * referenced sprite cells on full-size pages (canvas-nodes' read): the gate
 * fails when it stopped at the limit or passed anything over by name, so a
 * clean result is never a partial one.
 */
const texelCoverage = (t: TexelAudit): { compared: number; notCompared: Record<string, number>; stoppedAtLimit: boolean; gaps: string[] } => {
  const notCompared = Object.fromEntries(Object.entries(t.skipped).filter(([, n]) => n > 0));
  // canvas-lead's ruling: `truncated` (stopped at the limit with comparable cells left) where the build has it;
  // only a build without it falls back to `checked >= limit`. A board with exactly 600 comparable cells passes.
  const truncated = (t as { truncated?: boolean }).truncated;
  const stoppedAtLimit = truncated === undefined ? t.checked >= TEXEL_LIMIT : truncated;
  const gaps: string[] = [];
  if (stoppedAtLimit) gaps.push(`stopped at its limit of ${String(TEXEL_LIMIT)} cells`);
  for (const [why, n] of Object.entries(notCompared)) gaps.push(`passed over ${String(n)} cell(s): ${why}`);
  return { compared: t.checked, notCompared, stoppedAtLimit, gaps };
};

const auditTexels = (page: Page): Promise<TexelAudit | null> =>
  page.evaluate(async (limit) => {
    const hook = (window as unknown as { __juntoCanvas?: { atlasAuditTexels?: (limit?: number) => Promise<unknown> | null } }).__juntoCanvas;
    return ((await hook?.atlasAuditTexels?.(limit)) ?? null) as TexelAudit | null;
  }, TEXEL_LIMIT);

/** Every invariant at once; a failure names where it was found. */
const checkAll = async (page: Page, where: string, texels: boolean): Promise<void> => {
  const state = await readProofState(page);
  const atlas = state.atlas as (typeof state.atlas & { compactions?: number }) | null;
  if (state.gpuErrors === null) fail(`${where}: the build has no gpuErrors hook`);
  else if (state.gpuErrors.count > 0) fail(`${where}: ${String(state.gpuErrors.count)} uncaught GPU error(s)`, { last: state.gpuErrors.last });
  const a = await audit(page);
  if (a === null) fail(`${where}: the build has no atlasAudit hook`);
  else if (Object.keys(a.counts).length > 0) fail(`${where}: atlas audit`, { counts: a.counts, checked: a.checked, held: a.heldCells, first: a.samples.slice(0, 8) });
  if (texels) {
    const t = await auditTexels(page);
    if (t === null) fail(`${where}: the build has no atlasAuditTexels hook`);
    else {
      const coverage = texelCoverage(t);
      log(`${where}: texels`, { compared: coverage.compared, notCompared: coverage.notCompared, stoppedAtLimit: coverage.stoppedAtLimit, worst: Math.round(t.worst * 10) / 10, mismatches: t.mismatches.length });
      if (t.mismatches.length > 0) fail(`${where}: ${String(t.mismatches.length)} landed sprite cell(s) hold another drawing`, { first: t.mismatches.slice(0, 8) });
      if (coverage.gaps.length > 0) fail(`${where}: the texel check is partial: ${coverage.gaps.join("; ")}`, { compared: coverage.compared, notCompared: coverage.notCompared });
    }
  }
  log(`${where}: stats`, {
    tier: state.tier,
    zoom: Math.round(state.camera.zoom * 1000) / 1000,
    evictions: atlas?.evictions,
    compactions: atlas?.compactions,
    pages: atlas?.pages,
    landed: atlas?.landed,
    pinned: atlas?.pinnedCells,
    active: atlas?.activeCells,
    failures: atlas?.failures,
    visibleBlank: atlas?.visibleBlankTotal,
    gpuErrors: state.gpuErrors?.count,
  });
};

/** A pinch about one pointer point: ctrl+wheel, one event a display frame, no reads between. */
const pinchAbout = async (page: Page, at: { x: number; y: number }, from: number, to: number): Promise<void> => {
  const cdp = await page.context().newCDPSession(page);
  const factor = 0.02; // the wheel's log2 zoom per delta unit, as wheelZoomTo uses
  const total = -Math.log2(to / from) / factor;
  const steps = Math.max(1, Math.ceil(Math.abs(total) / 12));
  const started = Date.now();
  const sends: Array<Promise<unknown>> = [];
  try {
    for (let step = 0; step < steps; step += 1) {
      const wait = started + step * 16 - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
      sends.push(
        cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: total / steps, modifiers: 2 }).catch(() => undefined),
      );
    }
    await Promise.all(sends);
  } finally {
    await cdp.detach().catch(() => undefined);
  }
};

const shot = async (page: Page, clip: Rect): Promise<PngImage> => PNG.sync.read(await page.screenshot({ clip }));

const pixelDelta = (a: PngImage, b: PngImage, i: number): number =>
  Math.max(Math.abs(a.data[i]! - b.data[i]!), Math.abs(a.data[i + 1]! - b.data[i + 1]!), Math.abs(a.data[i + 2]! - b.data[i + 2]!));

/** Pixels the board's own motion moves: anything that differs across settled shots, grown by 3 px. */
const motionMask = (shots: ReadonlyArray<PngImage>): Uint8Array => {
  const { width, height } = shots[0]!;
  const moving = new Uint8Array(width * height);
  for (let s = 1; s < shots.length; s += 1) {
    for (let p = 0; p < width * height; p += 1) if (pixelDelta(shots[0]!, shots[s]!, p * 4) > 24) moving[p] = 1;
  }
  const grown = new Uint8Array(width * height);
  const r = 3;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (moving[y * width + x] === 0) continue;
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < height && xx >= 0 && xx < width) grown[yy * width + xx] = 1;
        }
      }
    }
  }
  return grown;
};

/** Changed pixels outside the mask, and the 16 px blocks that hold at least 24 of them. */
const compare = (reference: PngImage, mask: Uint8Array, now: PngImage): { changed: number; blocks: number; diff: PngImage } => {
  const { width, height } = reference;
  const diff = new PNG({ width, height });
  const blockCounts = new Map<number, number>();
  let changed = 0;
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 4;
    const d = mask[p] === 1 ? 0 : pixelDelta(reference, now, i);
    const hot = d > 48;
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

/** The camera that centres the board's middle at `zoom`. */
const centred = (board: ProofBoard, pane: Rect, zoom: number): { x: number; y: number; zoom: number } => {
  const b = board.stats.bounds;
  return { x: pane.width / 2 - (b.x + b.width / 2) * zoom, y: pane.height / 2 - (b.y + b.height / 2) * zoom, zoom };
};

test.describe.configure({ mode: "serial" });

test("a plain launch at the operator's window raises no GPU error and keeps the cell table true", async () => {
  test.setTimeout(10 * 60_000);
  await mkdir(OUT, { recursive: true });
  const board = buildProofBoard(fixture!, 1);
  const junto = await launchProofArm(board, { gpu: true });
  const page = junto.page;
  const own: string[] = [];
  try {
    await waitGpuReady(page, board);
    const view = await page.evaluate(() => ({ dpr: window.devicePixelRatio, w: window.innerWidth, h: window.innerHeight }));
    log("plain launch: window", view);
    for (let s = 0; s <= 75; s += 15) {
      const before = failures.length;
      await checkAll(page, `plain launch +${String(s)}s idle`, s === 75);
      own.push(...failures.slice(before));
      if (s < 75) await page.waitForTimeout(15_000);
    }
    await page.screenshot({ path: join(OUT, "plain-launch.png") });
  } finally {
    await writeFile(join(OUT, "report-plain.json"), JSON.stringify({ failures: own, report }, null, 2));
    await junto.close();
  }
  expect(own, own.join("\n")).toEqual([]);
});

test("zooming in and out through every tier never draws another item's pixels", async () => {
  test.setTimeout(30 * 60_000);
  await mkdir(OUT, { recursive: true });
  const board = buildProofBoard(fixture!, 1);
  const junto = await launchProofArm(board, { gpu: true });
  const page = junto.page;
  try {
    await waitGpuReady(page, board);
    const pane = await paneRect(page);
    const clip: Rect = { x: Math.round(pane.x), y: Math.round(pane.y), width: Math.floor(pane.width), height: Math.floor(pane.height) };
    const centre = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };

    // --- cold: two sizes of every portrait asked before its decode lands -----
    // No settle after boot: pinch at once between the live tier and the next
    // one in, so each portrait is wanted at two scales while it decodes.
    const start = (await readProofState(page)).camera.zoom;
    await pinchAbout(page, centre, start, 0.52);
    await pinchAbout(page, centre, 0.52, 0.9);
    await pinchAbout(page, centre, 0.9, 0.3);
    await pinchAbout(page, centre, 0.3, 0.52);
    await checkAll(page, "cold, unsettled", false);
    await settleAtlas(page);
    await checkAll(page, "cold, settled", true);
    await page.screenshot({ clip, path: join(OUT, "cold-settled.png") });

    // --- settled references, one per tier ----------------------------------
    const references: Array<{ zoom: number; camera: { x: number; y: number; zoom: number }; reference: PngImage; mask: Uint8Array }> = [];
    for (const zoom of REFERENCE_ZOOMS) {
      const camera = centred(board, pane, zoom);
      await placeCamera(page, camera, 400);
      await settleAtlas(page);
      const shots: PngImage[] = [];
      for (let n = 0; n < 4; n += 1) {
        shots.push(await shot(page, clip));
        await page.waitForTimeout(350);
      }
      await writeFile(join(OUT, `reference-${String(zoom)}.png`), PNG.sync.write(shots[0]!));
      references.push({ zoom, camera, reference: shots[0]!, mask: motionMask(shots) });
      await checkAll(page, `reference ${String(zoom)}`, true);
    }

    const compareAll = async (when: string): Promise<void> => {
      for (const ref of references) {
        await placeCamera(page, ref.camera, 400);
        await settleAtlas(page);
        const now = await shot(page, clip);
        const { changed, blocks, diff } = compare(ref.reference, ref.mask, now);
        const tag = `${when.replace(/[^a-z0-9]+/gi, "-")}-${String(ref.zoom)}`;
        log(`${when} @ ${String(ref.zoom)}: frame vs reference`, { changed, blocks });
        if (blocks > 0) {
          await writeFile(join(OUT, `${tag}-now.png`), PNG.sync.write(now));
          await writeFile(join(OUT, `${tag}-diff.png`), PNG.sync.write(diff));
          fail(`${when} @ zoom ${String(ref.zoom)}: ${String(blocks)} 16px block(s) differ from the settled reference (${String(changed)} px)`, {
            now: join(OUT, `${tag}-now.png`),
            diff: join(OUT, `${tag}-diff.png`),
          });
        }
        await checkAll(page, `${when} @ ${String(ref.zoom)}`, true);
      }
    };

    // --- the sweep: pinch about varied pointer points until reclaim + compaction
    const points = [
      { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.3 }, { x: 0.8, y: 0.7 }, { x: 0.3, y: 0.8 }, { x: 0.75, y: 0.2 }, { x: 0.5, y: 0.15 },
    ];
    let comparedAfterCompaction = false;
    let cycle = 0;
    for (; cycle < MAX_CYCLES; cycle += 1) {
      // Each cycle starts over a different part of the board, so the gestures
      // keep asking for cells the atlas has not seen, as an operator's do.
      const b = board.stats.bounds;
      const gx = ((cycle * 7) % 9) / 8;
      const gy = ((cycle * 5) % 7) / 6;
      const zoomHome = 0.52;
      const home = {
        x: pane.width / 2 - (b.x + b.width * (0.05 + 0.9 * gx)) * zoomHome,
        y: pane.height / 2 - (b.y + b.height * (0.05 + 0.9 * gy)) * zoomHome,
        zoom: zoomHome,
      };
      await placeCamera(page, home, 50);
      let zoom = (await readProofState(page)).camera.zoom;
      const legs = cycle % 3 === 2 ? [...CYCLE, 0.15] : CYCLE;
      for (let leg = 0; leg < legs.length; leg += 1) {
        const p = points[(cycle + leg) % points.length]!;
        await pinchAbout(page, { x: pane.x + pane.width * p.x, y: pane.y + pane.height * p.y }, zoom, legs[leg]!);
        await page.waitForTimeout(60);
        zoom = (await readProofState(page)).camera.zoom;
      }
      await checkAll(page, `cycle ${String(cycle)}, mid-gesture`, false);
      const atlas = (await readProofState(page)).atlas as { evictions: number; compactions?: number } | null;
      const evicted = (atlas?.evictions ?? 0) > 0;
      const compacted = (atlas?.compactions ?? 0) > 0;
      if (compacted && !comparedAfterCompaction) {
        comparedAfterCompaction = true;
        await settleAtlas(page);
        await checkAll(page, `cycle ${String(cycle)}, first compaction, settled`, true);
        await compareAll(`after first compaction (cycle ${String(cycle)})`);
      }
      // The atlas no longer compacts (61dbe0378): reclaim is eviction.
      if (evicted && cycle >= 3) break;
    }
    const final = (await readProofState(page)).atlas as { evictions: number; compactions?: number } | null;
    log("sweep done", { cycles: cycle + 1, evictions: final?.evictions, compactions: final?.compactions });
    if ((final?.evictions ?? 0) === 0) fail(`the sweep never reclaimed a plot in ${String(cycle + 1)} cycles: the gate did not exercise eviction`);
    await settleAtlas(page);
    await compareAll("after the sweep");
  } finally {
    await writeFile(join(OUT, "report.json"), JSON.stringify({ failures, report }, null, 2));
    await junto.close();
  }
  const own = failures.filter((line) => !line.startsWith("plain launch"));
  expect(own, own.join("\n")).toEqual([]);
});
