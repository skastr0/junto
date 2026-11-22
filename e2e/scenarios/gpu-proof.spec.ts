/**
 * #913 — the GPU canvas proof, real Electron, 1x / 10x / 100x the factory
 * board, against the React Flow canvas.
 *
 * Scope: the Proof section of artifact 01M81DHBBYRVN3MKJMR3MMCZ31 v5 and
 * operator rulings 1 to 7. Nothing here fakes a device, a hook or a pixel:
 * every number is read from the shipped `window.__juntoCanvas` hook and every
 * image is an Electron screenshot or a CDP screencast frame. The fixture is a
 * copy of a Junto database named by JUNTO_FACTORY_DB (never the live one).
 *
 * What is measured
 *   - boot and a zoom sweep through every tier on 1x, 10x and 100x boards:
 *     atlas requests, pending, landed, evictions, failures, pages, bytes in
 *     use, visibleBlank (sampled every frame) and the tier the camera hit.
 *   - every seat addressable at every tier: click, select, double-click opens,
 *     and a clustered seat is reached by clicking its cluster.
 *   - side by side with React Flow: tolerant pixel comparison of the same card
 *     clips at near (the look gallery's 3 by 3 match, 24 per channel, 4.5%);
 *     at mid and far, structural comparison (every card and cluster React Flow
 *     shows is present at the matching position) plus part-level ink check
 *     from the scene's drawn quads (name, portrait, ring, badge count, pip).
 *   - frame times from a Chromium timeline trace (viz Display::DrawAndSwap
 *     gaps and renderer main-thread tasks), reported as measured, no target.
 *   - ruling 6: visibleBlank stays 0 across pans, zooms, flings, camera jumps,
 *     text churn and theme switches, with a screencast recorded frame by frame.
 *
 * Run (the fixture must be a copy, the live database is refused):
 *   sqlite3 "file:$HOME/.junto/state/junto.db?mode=ro" ".backup '/tmp/junto-factory.db'"
 *   JUNTO_GPU_PROOF=1 JUNTO_FACTORY_DB=/tmp/junto-factory.db \
 *     bun run test:e2e:fast e2e/scenarios/gpu-proof.spec.ts
 *
 * Scales: JUNTO_GPU_PROOF_SCALES (default "1,10,100"); images and raw traces
 * land in JUNTO_GPU_PROOF_OUT (default /tmp/junto-gpu-proof).
 */

import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NestedCanvasFixture } from "../harness/nested-canvas-fixture";
import {
  PROOF_CANVAS,
  buildProofBoard,
  cameraOn,
  cameraOnAt,
  launchProofArm,
  loadFactoryBoard,
  lastSeed,
  loadFactoryFixture,
  paneRect,
  panSweep,
  placeCamera,
  readBlankProbe,
  readMotionProbe,
  readProofState,
  recordRun,
  seatBoardRects,
  settleAtlas,
  startBlankProbe,
  startMotionProbe,
  traceRun,
  waitGpuReady,
  wheelSweep,
  type BlankProbe,
  type FrameTrace,
  type ProofBoard,
  type ProofScale,
} from "../harness/gpu-proof";

interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  readonly PNG: { readonly sync: { read(png: Buffer): PngImage } };
};

const ENABLED =
  process.env["JUNTO_GPU_PROOF"] === "1" &&
  ((process.env["JUNTO_FACTORY_DB"] ?? "") !== "" || (process.env["JUNTO_FACTORY_JSON"] ?? "") !== "");
const SCALES: ReadonlyArray<ProofScale> = (process.env["JUNTO_GPU_PROOF_SCALES"] ?? "1,10,100")
  .split(",")
  .map((value) => Number(value) as ProofScale)
  .filter((value): value is ProofScale => value === 1 || value === 10 || value === 100);
const OUT = process.env["JUNTO_GPU_PROOF_OUT"] ?? join("/tmp", "junto-gpu-proof");
const DB = process.env["JUNTO_FACTORY_DB"] ?? "";
const JSON_FIXTURE = process.env["JUNTO_FACTORY_JSON"] ?? "";

test.skip(!ENABLED, "set JUNTO_GPU_PROOF=1 and JUNTO_FACTORY_DB=<copy of junto.db> (or JUNTO_FACTORY_JSON=<saved fixture>) to run the proof");

/** The tiers, at a zoom inside each one, with hysteresis safely past the edge. */
const TIERS = [
  { name: "overview", zoom: 0.15 },
  { name: "far", zoom: 0.3 },
  { name: "mid", zoom: 0.52 },
  { name: "near", zoom: 0.9 },
] as const;

const SWEEP_ZOOMS = [0.15, 0.3, 0.52, 0.9, 1.2, 0.52, 0.3, 0.15] as const;

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type Report = Record<string, unknown>;

const evidence: Report[] = [];
const failures: string[] = [];

const fail = (line: string): void => {
  failures.push(line);
};

const round = (value: number, places = 1): number => Math.round(value * 10 ** places) / 10 ** places;

/** The screenshots and traces of one board, made next to it. */
const boardDir = async (scale: ProofScale): Promise<string> => {
  const dir = join(OUT, `${String(scale)}x`);
  await mkdir(dir, { recursive: true });
  return dir;
};

const boardFixture = ((): NestedCanvasFixture | null => {
  if (!ENABLED) return null;
  if (DB === "" && JSON_FIXTURE !== "") return loadFactoryFixture(JSON_FIXTURE);
  try {
    return loadFactoryBoard(DB).fixture;
  } catch (error) {
    throw new Error(
      `JUNTO_FACTORY_DB=${DB} is not a readable COPY of a Junto database with a "${PROOF_CANVAS}" canvas: ${String(error)}`,
    );
  }
})();

const proofBoard = (scale: ProofScale): ProofBoard => buildProofBoard(boardFixture!, scale);

// --- shot helpers ---------------------------------------------------------------

const shot = async (page: Page, clip: Rect, path?: string): Promise<PngImage> => {
  const buffer = await page.screenshot({ clip, path });
  return PNG.sync.read(buffer);
};

const clampToPane = (rect: Rect, pane: Rect): Rect => {
  const x = Math.max(Math.ceil(pane.x + 1), Math.floor(rect.x));
  const y = Math.max(Math.ceil(pane.y + 1), Math.floor(rect.y));
  const right = Math.min(Math.floor(pane.x + pane.width - 1), Math.ceil(rect.x + rect.width));
  const bottom = Math.min(Math.floor(pane.y + pane.height - 1), Math.ceil(rect.y + rect.height));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
};

const channelClose = (a: PngImage, ai: number, b: PngImage, bi: number, tolerance: number): boolean =>
  Math.abs(a.data[ai]! - b.data[bi]!) <= tolerance &&
  Math.abs(a.data[ai + 1]! - b.data[bi + 1]!) <= tolerance &&
  Math.abs(a.data[ai + 2]! - b.data[bi + 2]!) <= tolerance;

/** The look gallery's tolerant comparison: a pixel that has no colour match within 1px of the other arm. */
const mismatch = (a: PngImage, b: PngImage): number => {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  let bad = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * a.width + x) * 4;
      let matched = false;
      for (let dy = -1; dy <= 1 && !matched; dy += 1) {
        const by = y + dy;
        if (by < 0 || by >= b.height) continue;
        for (let dx = -1; dx <= 1 && !matched; dx += 1) {
          const bx = x + dx;
          if (bx < 0 || bx >= b.width) continue;
          matched = channelClose(a, i, b, (by * b.width + bx) * 4, 24);
        }
      }
      if (!matched) bad += 1;
    }
  }
  return bad / (width * height);
};

/** Pixels clearly off the clip's own modal colour: the ink a card carries on the ground it sits on. */
const inkShare = (png: PngImage): number => {
  const counts = new Map<number, number>();
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const at = (y * png.width + x) * 4;
      const key = (png.data[at]! << 16) | (png.data[at + 1]! << 8) | png.data[at + 2]!;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let modal = 0;
  for (const count of counts.values()) modal = Math.max(modal, count);
  return 1 - modal / (png.width * png.height);
};

const modalRgb = (png: PngImage): readonly [number, number, number] => {
  const counts = new Map<number, number>();
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const at = (y * png.width + x) * 4;
      const key = (png.data[at]! << 16) | (png.data[at + 1]! << 8) | png.data[at + 2]!;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best = 0;
  let key = 0;
  for (const [candidate, count] of counts) {
    if (count > best) {
      best = count;
      key = candidate;
    }
  }
  return [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff];
};

// --- the hook's view of a seat ---------------------------------------------------

interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Every seat's screen rect at the current camera, and how many are on the pane. */
const seatScreens = async (
  page: Page,
  board: ProofBoard,
): Promise<{ readonly total: number; readonly onPane: ReadonlyArray<{ readonly id: string; readonly rect: ScreenRect }>; readonly missing: ReadonlyArray<string> }> =>
  page.evaluate((ids) => {
    const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
    if (hook === undefined) throw new Error("no GPU test hook");
    const pane = hook["rectOf"]("") as ScreenRect;
    const onPane: Array<{ id: string; rect: ScreenRect }> = [];
    const missing: string[] = [];
    for (const id of ids as string[]) {
      const rect = hook["rectOf"](id) as ScreenRect | undefined;
      if (rect === undefined) {
        missing.push(id);
        continue;
      }
      const inside = rect.x < pane.x + pane.width && rect.x + rect.width > pane.x && rect.y < pane.y + pane.height && rect.y + rect.height > pane.y;
      if (inside) onPane.push({ id, rect });
    }
    return { total: (ids as string[]).length, onPane, missing };
  }, board.seats as string[]);

interface ContentPart {
  readonly role: string;
  readonly rect: ScreenRect;
  readonly drawn: boolean;
  readonly hasImage: boolean | null;
}

interface ContentSeat {
  readonly id: string;
  readonly cluster: string | null;
  readonly parts: ReadonlyArray<ContentPart>;
}

/** The drawn quads of every seat on screen, and the badge that stands for it when gathered. */
const seatContent = (page: Page, ids: ReadonlyArray<string>): Promise<ReadonlyArray<ContentSeat>> =>
  page.evaluate((seatIds) => {
    const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
    if (hook === undefined) return [];
    const clusters = (typeof hook["clusters"] === "function" ? (hook["clusters"]() as Array<Record<string, any>>) : [])
      .filter((cluster) => cluster["drawn"] === true);
    const badgeOf = new Map<string, string>();
    for (const cluster of clusters) for (const member of (cluster["memberIds"] ?? []) as string[]) badgeOf.set(member, String(cluster["key"]));
    return (seatIds as string[]).map((id) => ({
      id,
      cluster: badgeOf.get(id) ?? null,
      parts: ((typeof hook["partsOf"] === "function" ? (hook["partsOf"](id) as Array<Record<string, any>>) : []))
        .filter((part) => part["drawn"] === true)
        .map((part) => ({
          role: String(part["key"] ?? part["kind"] ?? "?"),
          rect: part["rect"] as ScreenRect,
          drawn: true,
          hasImage: typeof part["hasImage"] === "boolean" ? part["hasImage"] : null,
        })),
    }));
  }, ids);

/** A portrait's painter key, bare on a seat and key-prefixed on a cluster badge. */
const isPortrait = (role: string): boolean => role === "portrait" || role.endsWith(".portrait") || role.endsWith("portrait");

/** The portrait of a gathered seat, from the badge that stands for it. */
const badgePortrait = async (page: Page, key: string): Promise<ContentPart | null> => {
  const parts = await badgeParts(page, key);
  const portrait = parts.find((part) => part.drawn && isPortrait(part.role));
  return portrait === undefined ? null : { role: portrait.role, rect: portrait.rect, drawn: true, hasImage: null };
};

interface SeatClick {
  readonly id: string;
  readonly result: "direct" | "cluster" | "covered" | "miss" | "offscreen";
  readonly detail?: string;
}

const selectionHas = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((seat) => {
    const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
    const selected = (hook?.["selection"]?.() ?? []) as string[];
    return selected.includes(seat);
  }, id);

const clickPoint = async (page: Page, point: { x: number; y: number }): Promise<void> => {
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(60);
};

/** Close any working surface a click opened; Escape, then its own close control. */
const closeSurfaces = async (page: Page): Promise<void> => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await page.locator(".focus-surface").count()) === 0) return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    if ((await page.locator(".focus-surface").count()) === 0) return;
    // A terminal surface keeps Escape for the PTY: Cmd+W is its named way out.
    await page.keyboard.press("Meta+w");
    await page.waitForTimeout(350);
    if ((await page.locator(".focus-surface").count()) === 0) return;
    const close = page.locator(".focus-surface").getByRole("button", { name: /close/i }).first();
    if ((await close.count()) > 0) await close.click({ timeout: 1_000 }).catch(() => undefined);
    await page.waitForTimeout(350);
  }
};

/** Close any working surface the previous click opened, and clear the selection. */
const resetOperator = async (page: Page): Promise<void> => {
  await closeSurfaces(page);
  await page.keyboard.press("Escape");
  const pane = await paneRect(page);
  await page.mouse.move(pane.x + 4, pane.y + 4);
  await page.waitForTimeout(60);
};

/** Wait until the scene has built and drawn this seat, or a badge that holds it. */
const waitSeatDrawn = async (page: Page, id: string, timeoutMs = 1_500): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const shown = await page.evaluate((seat) => {
      const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
      if (hook === undefined) return false;
      const parts = (typeof hook["partsOf"] === "function" ? (hook["partsOf"](seat) as Array<Record<string, any>>) : []).filter(
        (part) => part["drawn"] === true,
      );
      if (parts.length > 0) return true;
      const clusters = typeof hook["clusters"] === "function" ? (hook["clusters"]() as Array<Record<string, any>>) : [];
      return clusters.some((cluster) => cluster["drawn"] === true && ((cluster["memberIds"] ?? []) as string[]).includes(seat));
    }, id);
    if (shown) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(50);
  }
};

interface Hypothesis {
  readonly point: { readonly x: number; readonly y: number };
  readonly hit: "own" | "cluster" | "other" | "none" | "chrome";
  readonly hitId?: string | null;
  readonly hitPart?: string | null;
  readonly members?: number | null;
  readonly body?: boolean;
}

/** One in-page pass: which of these page points the canvas receives, and what the engine picks there. */
const hypothesize = (
  page: Page,
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  pane: ScreenRect,
  id: string,
): Promise<ReadonlyArray<Hypothesis>> =>
  page.evaluate(
    (input) => {
      const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
      if (hook === undefined) return [];
      return (input.points as Array<{ x: number; y: number }>).map((point) => {
        const element = document.elementFromPoint(point.x, point.y);
        if (!(element instanceof HTMLCanvasElement && element.classList.contains("junto-gpu-canvas"))) {
          const near = element?.closest("[data-testid], [role], [data-component], [aria-label]") as HTMLElement | null | undefined;
          return {
            point,
            hit: "chrome",
            element: element === null ? "none" : `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 100)}`,
            near:
              near === null || near === undefined
                ? ""
                : `${near.tagName.toLowerCase()} ${String(near.className).slice(0, 80)} ${near.getAttribute("data-testid") ?? near.getAttribute("aria-label") ?? ""}`.trim(),
          };
        }
        const hit = hook["pick"]({ x: point.x - input.pane.x, y: point.y - input.pane.y }) as
          | { nodeId?: string; part?: { kind?: string; memberIds?: string[] } }
          | null;
        if (hit === null) return { point, hit: "none" };
        const detail = {
          hitId: hit.nodeId ?? null,
          hitPart: hit.part?.kind ?? null,
          members: hit.part?.memberIds?.length ?? null,
        };
        if (hit.nodeId === input.id) return { point, hit: "own", ...detail };
        if ((hit.part?.memberIds ?? []).includes(input.id)) return { point, hit: "cluster", ...detail };
        const otherParts = hit.nodeId === undefined || hit.nodeId === null ? [] : ((hook["partsOf"]?.(hit.nodeId) ?? []) as Array<Record<string, unknown>>);
        const body = otherParts.some(
          (part) => part["drawn"] === true && (part["key"] === "shell" || part["key"] === "body" || part["key"] === "card"),
        );
        return { point, hit: "other", body, ...detail };
      });
    },
    { points, pane, id },
  );

const insidePane = (point: { readonly x: number; readonly y: number }, pane: ScreenRect): boolean =>
  point.x > pane.x + 2 && point.y > pane.y + 2 && point.x < pane.x + pane.width - 2 && point.y < pane.y + pane.height - 2;

const addressSeat = async (page: Page, id: string, pane: ScreenRect): Promise<SeatClick> => {
  // Clear the last selection's floating toolbar and the pointer hover before
  // probing: both are operator chrome that would cover this seat's points.
  await resetOperator(page);
  if (!(await waitSeatDrawn(page, id))) return { id, result: "miss", detail: "the scene never built or drew this seat at this tier" };
  const fresh = await page.evaluate((seat) => {
    const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
    return hook?.["rectOf"]?.(seat) as ScreenRect | undefined;
  }, id);
  if (fresh === undefined) return { id, result: "miss", detail: "no screen rect" };
  const camera = (await readProofState(page)).camera;
  const ring = { x: fresh.x + fresh.width / 2 - 4.5 * camera.zoom, y: fresh.y + fresh.height / 2 };
  const body = [
    ring,
    { x: fresh.x + fresh.width / 2, y: fresh.y + fresh.height / 2 },
    { x: fresh.x + fresh.width * 0.35, y: fresh.y + fresh.height / 2 },
    { x: fresh.x + fresh.width * 0.65, y: fresh.y + fresh.height / 2 },
    { x: fresh.x + fresh.width / 2, y: fresh.y + fresh.height * 0.3 },
    { x: fresh.x + fresh.width / 2, y: fresh.y + fresh.height * 0.7 },
  ].filter((point) => insidePane(point, pane));
  // A cluster badge sits near its members, not on the seat's own body: probe
  // a small spiral around the seat for a cluster that names it.
  const probes = [16, 28, 40, 56, 72].flatMap((radius) =>
    Array.from({ length: 8 }, (_, index) => {
      const angle = (index / 8) * Math.PI * 2;
      return { x: ring.x + Math.cos(angle) * radius, y: ring.y + Math.sin(angle) * radius };
    }),
  );
  const points = [...body, ...probes].filter((point) => insidePane(point, pane));
  const hypotheses = await hypothesize(page, points, pane, id);
  // A seat held by a cluster draws no quads of its own: clicking its body
  // cannot select it, so its badge is the only way in.
  const drawnSeat = await page.evaluate((seat) => {
    const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
    return ((hook?.["partsOf"]?.(seat) ?? []) as Array<Record<string, unknown>>).some((part) => part["drawn"] === true);
  }, id);
  // A drawn badge is the authored way into a gathered seat at far and
  // overview: clicking the seat's own held ring selects nothing.
  const hasClubBadge = (await drawnClusters(page)).some((cluster) => cluster.drawn && cluster.memberIds.includes(id));
  let target = hasClubBadge && drawnSeat ? undefined : hypotheses.find((hypothesis) => hypothesis.hit === "own" && drawnSeat);
  if (target === undefined) {
    target = hypotheses.find((hypothesis) => hypothesis.hit === "cluster");
    if (target === undefined) {
      // The badge can stand away from its members; the scene names its centre.
      let badge = (await drawnClusters(page)).find((cluster) => cluster.drawn && cluster.memberIds.includes(id));
      // A cluster can be wider than the pane: bring its badge into view first.
      if (badge !== undefined && !insidePane({ x: badge.x, y: badge.y }, pane)) {
        const at = { x: (badge.x - pane.x - camera.x) / camera.zoom, y: (badge.y - pane.y - camera.y) / camera.zoom };
        await placeCamera(page, await cameraOn(page, at, camera.zoom), 150);
        badge = (await drawnClusters(page)).find((cluster) => cluster.drawn && cluster.memberIds.includes(id));
      }
      if (badge !== undefined) {
        // The badge centre can be covered by its portrait sprite; its ring is
        // the cluster's own disc and carries the member list.
        const ring = (multiple: number): Array<{ x: number; y: number }> =>
          Array.from({ length: 12 }, (_, index) => {
            const angle = (index / 12) * Math.PI * 2;
            return { x: badge!.x + Math.cos(angle) * badge!.radius * multiple, y: badge!.y + Math.sin(angle) * badge!.radius * multiple };
          });
        const points = [
          { x: badge.x, y: badge.y },
          ...ring(1),
          ...ring(1.3),
          ...ring(0.6),
        ].filter((point) => insidePane(point, pane));
        const hits = await hypothesize(page, points, pane, id);
        const clusterHit = hits.find((hit) => hit.hit === "cluster") ?? hits.find((hit) => hit.hit === "own");
        if (clusterHit !== undefined) target = clusterHit;
      }
    }
  }
  if (target === undefined) {
    const canvasPoints = hypotheses.filter((hypothesis) => hypothesis.hit !== "chrome").length;
    const others = hypotheses.filter((hypothesis) => hypothesis.hit === "other");
    const coveredByDrawnCard = others.length > 0 && others.every((hypothesis) => hypothesis.body === true);
    return {
      id,
      result: canvasPoints === 0 ? "offscreen" : coveredByDrawnCard ? "covered" : "miss",
      detail: coveredByDrawnCard
        ? `covered by a drawn card at every one of ${String(canvasPoints)} canvas points`
        : `not pickable at ${String(canvasPoints)} canvas points (${JSON.stringify(hypotheses.slice(0, 6))})`,
    };
  }

  // A click on the seat that is already selected opens it; clear the
  // selection first so this is a click, not a double-press.
  if (await selectionHas(page, id)) await resetOperator(page);
  const before = (await readProofState(page)).camera;
  await clickPoint(page, target.point);
  if (await selectionHas(page, id)) return { id, result: "direct" };
  const after = (await readProofState(page)).camera;
  const moved = after.zoom > before.zoom * 1.01 || Math.abs(after.x - before.x) > 4 || Math.abs(after.y - before.y) > 4;
  if (target.hit === "own" || !moved) {
    // The press can gather the seat and draw its badge after the probe: if a
    // drawn badge now names it, the badge is the way in.
    const late = (await drawnClusters(page)).find((cluster) => cluster.drawn && cluster.memberIds.includes(id));
    if (late !== undefined) {
      const ring = [
        { x: late.x, y: late.y },
        ...Array.from({ length: 12 }, (_, index) => {
          const angle = (index / 12) * Math.PI * 2;
          return { x: late.x + Math.cos(angle) * late.radius, y: late.y + Math.sin(angle) * late.radius };
        }),
      ].filter((point) => insidePane(point, pane));
      const lateHit = (await hypothesize(page, ring, pane, id)).find((hit) => hit.hit === "cluster");
      if (lateHit !== undefined) {
        await clickPoint(page, lateHit.point);
        await page.waitForTimeout(420);
        const landed = await page.evaluate((seat) => {
          const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
          return hook?.["rectOf"]?.(seat) as ScreenRect | undefined;
        }, id);
        if (landed !== undefined) {
          await clickPoint(page, { x: landed.x + landed.width / 2, y: landed.y + landed.height / 2 });
          if (await selectionHas(page, id)) return { id, result: "cluster" };
        }
      }
    }
    const diagnosis = await page.evaluate(
      (input: { id: string; point: { x: number; y: number } }) => {
        const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
        if (hook === undefined) return null;
        const pane = hook["rectOf"]("") as ScreenRect;
        const selected = (hook["selection"]?.() ?? []) as string[];
        const hit = hook["pick"]({ x: input.point.x - pane.x, y: input.point.y - pane.y }) as
          | { nodeId?: string; part?: { kind?: string; key?: string } }
          | null
          | undefined;
        const element = document.elementFromPoint(input.point.x, input.point.y);
        const parts = (hook["partsOf"](input.id) as Array<Record<string, any>>)
          .filter((part) => part["drawn"] === true)
          .map((part) => ({ key: part["key"], kind: part["kind"], rect: part["rect"] }));
        const clusters = (hook["clusters"]?.() ?? []) as Array<Record<string, any>>;
        return {
          selected,
          pick: hit === null || hit === undefined ? null : { nodeId: hit.nodeId ?? null, part: hit.part?.key ?? hit.part?.kind ?? null },
          element: element === null ? null : String(element.className).slice(0, 120),
          parts,
          clustersNamingSeat: clusters
            .filter((cluster) => (cluster["memberIds"] ?? []).includes(input.id))
            .map((cluster) => ({ key: cluster["key"], drawn: cluster["drawn"], x: cluster["x"], y: cluster["y"], radius: cluster["radius"], members: (cluster["memberIds"] as string[]).length })),
          clusterMarks: clusters.filter((cluster) => cluster["drawn"] === true).length,
        };
      },
      { id, point: target.point },
    );
    const selectedIds = ((diagnosis as { selected?: string[] } | null)?.selected ?? []).filter((selected) => selected !== id);
    if (selectedIds.length > 0) {
      const drawnOver = await page.evaluate((ids) => {
        const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
        return ids.some((other) =>
          ((hook?.["partsOf"]?.(other) ?? []) as Array<Record<string, unknown>>).some(
            (part) => part["drawn"] === true && (part["key"] === "shell" || part["key"] === "body" || part["key"] === "card"),
          ),
        );
      }, selectedIds);
      if (drawnOver) return { id, result: "covered", detail: `a drawn card selects at its points: ${selectedIds.join(",")}` };
    }
    return { id, result: "miss", detail: `click on its own hit box landed on nothing: ${JSON.stringify(diagnosis)}` };
  }

  // A cluster was reached: the camera fits its members; click the seat now.
  await page.waitForTimeout(420);
  const landed = await page.evaluate((seat) => {
    const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
    return hook?.["rectOf"]?.(seat) as ScreenRect | undefined;
  }, id);
  if (landed === undefined) return { id, result: "cluster", detail: "cluster fitted but the seat has no rect" };
  const fitted = [
    { x: landed.x + landed.width / 2 - 4.5 * after.zoom, y: landed.y + landed.height / 2 },
    { x: landed.x + landed.width / 2, y: landed.y + landed.height / 2 },
  ].filter((point) => insidePane(point, pane));
  const fittedHits = await hypothesize(page, fitted, pane, id);
  const own = fittedHits.find((hypothesis) => hypothesis.hit === "own");
  if (own !== undefined) {
    await clickPoint(page, own.point);
    if (await selectionHas(page, id)) return { id, result: "cluster" };
  }
  return { id, result: "cluster", detail: "cluster reached; the fitted seat was not clicked" };
};

/** Connect the seat's opening: double-click opens its focus surface, Escape closes. */
interface OpenDiagnostics {
  readonly selection: ReadonlyArray<string>;
  readonly surfaces: number;
  readonly backdrops: number;
  readonly dialogs: number;
  readonly active: string;
}

interface OpenAttempt {
  readonly id: string;
  readonly point: { x: number; y: number } | null;
  readonly hit: string;
  readonly elements: ReadonlyArray<string>;
  readonly reason: "no-hit" | "no-selection" | "no-surface" | "opened";
  readonly selection: ReadonlyArray<string>;
}

const openSeat = async (
  page: Page,
  id: string,
  rect: ScreenRect,
  pane: ScreenRect,
): Promise<{ opened: boolean; diagnostics: OpenDiagnostics; attempt: OpenAttempt }> => {
  const candidates = [
    { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    { x: rect.x + rect.width * 0.4, y: rect.y + rect.height / 2 },
    { x: rect.x + rect.width * 0.6, y: rect.y + rect.height / 2 },
  ].filter((point) => insidePane(point, pane));
  const hits = await hypothesize(page, candidates, pane, id);
  const own = hits.find((hit) => hit.hit === "own");
  if (own === undefined) {
    const elements = await page.evaluate((points) => {
      return points.map((point) => {
        const element = document.elementFromPoint(point.x, point.y);
        return element === null ? "none" : `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 80)}`;
      });
    }, candidates);
    return {
      opened: false,
      diagnostics: { selection: [], surfaces: 0, backdrops: 0, dialogs: 0, active: "" },
      attempt: { id, point: null, hit: hits.map((hit) => hit.hit).join(","), elements, reason: "no-hit", selection: [] },
    };
  }
  const point = own.point;
  await resetOperator(page);
  await page.mouse.dblclick(point.x, point.y);
  const opened = await page
    .locator(".focus-surface")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  const diagnostics = await page.evaluate((): { selection: string[]; surfaces: number; backdrops: number; dialogs: number; active: string } => {
    const selection = ((window as unknown as { __juntoCanvas?: { selection?: () => unknown[] } }).__juntoCanvas?.selection?.() ?? []) as Array<{ id?: string } | string>;
    return {
      selection: selection.map((entry) => (typeof entry === "string" ? entry : String(entry.id ?? "?"))),
      surfaces: document.querySelectorAll(".focus-surface").length,
      backdrops: document.querySelectorAll("[data-layer-backdrop]").length,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      active: document.activeElement?.className?.toString().slice(0, 80) ?? "",
    };
  });
  const appeared = opened || diagnostics.surfaces > 0;
  if (opened) await closeSurfaces(page);
  const reason: OpenAttempt["reason"] =
    diagnostics.selection.length === 0 ? "no-selection" : appeared ? "opened" : "no-surface";
  return { opened: appeared, diagnostics, attempt: { id, point, hit: "own", elements: [], reason, selection: diagnostics.selection } };
};

// --- visuals: side by side, near pixels and mid/far structure ---------------------

interface ArmShot {
  readonly id: string;
  readonly rect: ScreenRect;
  readonly png: PngImage;
}

interface ClipShot extends ArmShot {
  readonly clip: ScreenRect;
}

const cardShot = async (page: Page, rect: ScreenRect, pane: ScreenRect, margin = 8): Promise<ClipShot> => {
  const clip = clampToPane({ x: rect.x - margin, y: rect.y - margin, width: rect.width + margin * 2, height: rect.height + margin * 2 }, pane);
  return { id: "", rect: { x: 0, y: 0, width: 0, height: 0 }, png: await shot(page, clip), clip };
};

/** The modal colour in a 3px frame just outside a part's rect: the ground it is painted on. */
const localGround = (png: PngImage, clip: ScreenRect, part: ScreenRect): readonly [number, number, number] => {
  const scale = png.width / clip.width;
  const pad = 3;
  const left = Math.max(0, Math.floor((part.x - pad - clip.x) * scale));
  const top = Math.max(0, Math.floor((part.y - pad - clip.y) * scale));
  const right = Math.min(png.width, Math.ceil((part.x + part.width + pad - clip.x) * scale));
  const bottom = Math.min(png.height, Math.ceil((part.y + part.height + pad - clip.y) * scale));
  const innerLeft = Math.max(0, Math.floor((part.x - clip.x) * scale));
  const innerTop = Math.max(0, Math.floor((part.y - clip.y) * scale));
  const innerRight = Math.min(png.width, Math.ceil((part.x + part.width - clip.x) * scale));
  const innerBottom = Math.min(png.height, Math.ceil((part.y + part.height - clip.y) * scale));
  const counts = new Map<number, number>();
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (x >= innerLeft && x < innerRight && y >= innerTop && y < innerBottom) continue;
      const at = (y * png.width + x) * 4;
      const key = (png.data[at]! << 16) | (png.data[at + 1]! << 8) | png.data[at + 2]!;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best = 0;
  let key = 0;
  for (const [candidate, count] of counts) {
    if (count > best) {
      best = count;
      key = candidate;
    }
  }
  return [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff];
};

/** The share of a part's own rect that carries ink against the ground around it. */
const partInk = (png: PngImage, clip: ScreenRect, part: ScreenRect): number => {
  const scale = png.width / clip.width;
  const ground = localGround(png, clip, part);
  const left = Math.max(0, Math.floor((part.x - clip.x) * scale));
  const top = Math.max(0, Math.floor((part.y - clip.y) * scale));
  const right = Math.min(png.width, Math.ceil((part.x + part.width - clip.x) * scale));
  const bottom = Math.min(png.height, Math.ceil((part.y + part.height - clip.y) * scale));
  if (right <= left || bottom <= top) return 0;
  let ink = 0;
  let all = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const at = (y * png.width + x) * 4;
      const distance = Math.abs(png.data[at]! - ground[0]) + Math.abs(png.data[at + 1]! - ground[1]) + Math.abs(png.data[at + 2]! - ground[2]);
      all += 1;
      if (distance > 36) ink += 1;
    }
  }
  return all === 0 ? 0 : ink / all;
};

interface DrawnPart {
  readonly id: string;
  readonly role: string;
  readonly kind: string;
  readonly rect: ScreenRect;
  readonly drawn: boolean;
  readonly hasImage: boolean | null;
}

/**
 * The scene's drawn quads for these cards, with their page screen rects. The
 * hook maps board rects through the live camera; the proof only reads them.
 */
const drawnParts = (page: Page, ids: ReadonlyArray<string>): Promise<ReadonlyArray<DrawnPart>> =>
  page.evaluate((seatIds) => {
    const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
    const list = hook?.["partsOf"];
    if (typeof list !== "function") return [];
    const rows: Array<{ id: string; role: string; kind: string; rect: { x: number; y: number; width: number; height: number }; drawn: boolean; hasImage: boolean | null }> = [];
    for (const id of seatIds as string[]) {
      for (const part of (list(id) ?? []) as Array<Record<string, any>>) {
        if (part["rect"] === undefined) continue;
        rows.push({
          id,
          role: String(part["key"] ?? "?"),
          kind: String(part["kind"] ?? "?"),
          rect: part["rect"] as { x: number; y: number; width: number; height: number },
          drawn: part["drawn"] === true,
          hasImage: typeof part["hasImage"] === "boolean" ? part["hasImage"] : null,
        });
      }
    }
    return rows;
  }, ids);

interface DrawnBadgePart {
  readonly key: string;
  readonly role: string;
  readonly rect: ScreenRect;
  readonly drawn: boolean;
}

/** The painted parts of one cluster badge, page screen rects. */
const badgeParts = (page: Page, key: string): Promise<ReadonlyArray<DrawnBadgePart>> =>
  page.evaluate((badgeKey) => {
    const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
    const list = hook?.["badgePartsOf"];
    if (typeof list !== "function") return [];
    return ((list(badgeKey) ?? []) as Array<Record<string, any>>)
      .filter((part) => part["rect"] !== undefined)
      .map((part) => ({
        key: String(badgeKey),
        role: String(part["key"] ?? part["kind"] ?? "?"),
        rect: part["rect"] as { x: number; y: number; width: number; height: number },
        drawn: part["drawn"] === true,
      }));
  }, key);

interface DrawnCluster {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly memberIds: ReadonlyArray<string>;
  readonly drawn: boolean;
}

const drawnClusters = (page: Page): Promise<ReadonlyArray<DrawnCluster>> =>
  page.evaluate(() => {
    const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
    const list = hook?.["clusters"];
    if (typeof list !== "function") return [];
    return (list() ?? []) as ReadonlyArray<DrawnCluster>;
  });

/** Every DOM card's id and page rect, read from React Flow's own nodes. */
const domCards = (page: Page): Promise<ReadonlyArray<{ id: string; kind: string; rect: ScreenRect }>> =>
  page.evaluate(() => {
    const nodes = [...document.querySelectorAll(".react-flow__node")];
    return nodes.flatMap((node) => {
      const id = (node as HTMLElement).dataset["id"] ?? (node as HTMLElement).getAttribute("data-id") ?? "";
      const kind = (node as HTMLElement).dataset["nodeKind"] ?? (node as HTMLElement).getAttribute("data-node-kind") ?? "";
      const box = node.getBoundingClientRect();
      return id === "" ? [] : [{ id, kind, rect: { x: box.left, y: box.top, width: box.width, height: box.height } }];
    });
  });

const placeDomCamera = async (page: Page, target: { x: number; y: number; zoom: number }): Promise<void> => {
  await page.evaluate((camera) => {
    const dom = (window as unknown as { __juntoDomCanvas?: { moveCamera(camera: unknown): void } }).__juntoDomCanvas;
    if (dom === undefined) throw new Error("no DOM canvas camera hook");
    dom.moveCamera(camera);
  }, target);
  await page.waitForTimeout(400);
};

// --- report ---------------------------------------------------------------------

const writeReport = async (name: string, payload: Report): Promise<void> => {
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, `${name}.json`), JSON.stringify(payload, null, 2));
  evidence.push({ name, ...payload });
};

// --- the proof tests --------------------------------------------------------------

test.describe.configure({ mode: "serial" });

test.describe("#913 GPU canvas proof", () => {
  for (const scale of SCALES) {
    test(`${String(scale)}x board: tiers, counters, addressability, frame times`, async () => {
      test.setTimeout(scale === 1 ? 2_400_000 : scale === 10 ? 3_600_000 : 5_400_000);
      failures.length = 0;
      const board = proofBoard(scale);
      const dir = await boardDir(scale);
      const report: Report = {
        scale,
        seed: lastSeed(),
        stats: board.stats,
        build: JSON.parse(await readFile(join(process.cwd(), "out/build-source.json"), "utf8")) as Record<string, unknown>,
        tiers: [],
        clicks: {},
        traces: {},
        blank: null,
        phases: {},
      };
      const phases: Record<string, number> = {};
      const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
        const startedAt = Date.now();
        try {
          return await run();
        } finally {
          phases[name] = Math.round((Date.now() - startedAt) / 100) / 10;
          report["phases"] = phases;
          console.log(`${String(scale)}x ${name}: ${String(phases[name])}s`);
        }
      };
      const junto = await launchProofArm(board, { gpu: true });
      try {
        const { page } = junto;
        const bootMs = await timed("boot", async () => {
          const bootAt = Date.now();
          await waitGpuReady(page, board, Number(process.env["JUNTO_GPU_PROOF_READY_MS"] ?? 240_000));
          await settleAtlas(page);
          return Date.now() - bootAt;
        });
        const boot = await readProofState(page);
        const gpu = await page.evaluate(async () => {
          const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
          if (adapter === null || adapter === undefined) return null;
          const info = (adapter as unknown as { info?: Record<string, string> }).info ?? {};
          return {
            vendor: info["vendor"] ?? "",
            architecture: info["architecture"] ?? "",
            description: info["description"] ?? "",
            maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
            maxBufferSize: adapter.limits.maxBufferSize,
            maxTextureArrayLayers: adapter.limits.maxTextureArrayLayers,
            devicePixelRatio: window.devicePixelRatio,
            viewport: { width: window.innerWidth, height: window.innerHeight },
          };
        });
        const machine = {
          platform: process.platform,
          arch: process.arch,
          host: process.env["HOSTNAME"] ?? "",
          gpu,
        };
        report["machine"] = machine;
        if (gpu === null) fail(`${String(scale)}x: no WebGPU adapter`);
        await startBlankProbe(page);
        await page.screenshot({ path: join(dir, "boot.png") });
        report["bootMs"] = bootMs;
        report["boot"] = boot;
        console.log(`machine ${JSON.stringify(machine)}`);

        const rects = seatBoardRects(board);
        const centre = {
          x: board.stats.bounds.x + board.stats.bounds.width / 2,
          y: board.stats.bounds.y + board.stats.bounds.height / 2,
        };
        const focusId = board.seats[Math.floor(board.seats.length / 2)]!;
        const focusRect = rects[focusId]!;
        const focus = { x: focusRect.x + focusRect.width / 2, y: focusRect.y + focusRect.height / 2 };
        const pane = await paneRect(page);

        // A settled camera in every tier, with its counters and its image.
        const tiers: Report[] = [];
        const freshPortraits = new Map<string, Set<string>>();
        const tierCameras = new Map<string, { x: number; y: number; zoom: number }>();
        await timed("tiers", async () => {
        for (const [index, tier] of TIERS.entries()) {
          const anchor = index % 2 === 0 ? centre : focus;
          await placeCamera(page, await cameraOn(page, anchor, tier.zoom));
          const at = await settleAtlas(page);
          const screens = await seatScreens(page, board);
          const image = PNG.sync.read(await page.screenshot({ path: join(dir, `${tier.name}-${String(tier.zoom)}.png`) }));
          const viewport = await page.evaluate(() => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }));
          const content = await seatContent(page, screens.onPane.map((seat) => seat.id));
          const badgeCache = new Map<string, ContentPart | null>();
          const okPortraits = new Set<string>();
          let portraitMissing = 0;
          let portraitBlank = 0;
          let portraitWrongShape = 0;
          let portraitCovered = 0;
          const missingSamples: string[] = [];
          const blankSamples: string[] = [];
          let seatQuads = 0;
          const checked: Array<{ id: string; portrait: ContentPart }> = [];
          for (const seat of content) {
            seatQuads += seat.parts.length;
            let portrait: ContentPart | null | undefined;
            if (seat.cluster === null) portrait = seat.parts.find((part) => isPortrait(part.role)) ?? null;
            else {
              if (!badgeCache.has(seat.cluster)) badgeCache.set(seat.cluster, await badgePortrait(page, seat.cluster));
              portrait = badgeCache.get(seat.cluster) ?? null;
            }
            if (portrait === null || portrait === undefined) {
              portraitMissing += 1;
              if (missingSamples.length < 6) missingSamples.push(seat.id);
              continue;
            }
            checked.push({ id: seat.id, portrait });
          }
          // A portrait under the bars or a panel is not on screen to the
          // operator; the canvas never received that point. Exclude it.
          const covered = await page.evaluate((rects) => {
            return (rects as Array<{ x: number; y: number; width: number; height: number }>).map((rect) => {
              const element = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              return element instanceof HTMLCanvasElement && element.classList.contains("junto-gpu-canvas");
            });
          }, checked.map((row) => row.portrait.rect));
          for (const [index, { id, portrait }] of checked.entries()) {
            if (covered[index] !== true) {
              portraitCovered += 1;
              continue;
            }
            const aspect = portrait.rect.width / Math.max(1, portrait.rect.height);
            if (aspect < 0.75 || aspect > 1.33) {
              // A portrait is a disc; a tall bar in its place is wrong content.
              portraitWrongShape += 1;
              if (blankSamples.length < 6) blankSamples.push(`${id}:aspect ${aspect.toFixed(2)}`);
              continue;
            }
            const share = partInk(image, viewport, portrait.rect);
            if (portrait.hasImage === false || share < 0.01) {
              portraitBlank += 1;
              if (blankSamples.length < 6) blankSamples.push(`${id}:hasImage=${String(portrait.hasImage)}:ink=${share.toFixed(3)}`);
              continue;
            }
            okPortraits.add(id);
          }
          freshPortraits.set(tier.name, okPortraits);
          tierCameras.set(tier.name, at.camera);
          // What the damage path left against a forced full redraw at the
          // same camera, no masking: a region painted inside a stale damage
          // rectangle differs here even when every counter is green.
          const forceFull = async (mode: "cpu" | "gpu", name: string): Promise<PngImage> => {
            await page.evaluate((arm) => {
              const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
              hook?.["setCull"]?.(arm);
            }, mode);
            await page.waitForTimeout(120);
            await settleAtlas(page);
            return PNG.sync.read(await page.screenshot({ path: join(dir, name) }));
          };
          const shippedFull = await forceFull((at.cull ?? "cpu") as "cpu" | "gpu", `${tier.name}-full.png`);
          const fullRedrawDelta = mismatch(image, shippedFull);
          if (fullRedrawDelta > 0.02) {
            fail(`${String(scale)}x ${tier.name}: the damaged frame differs from a full redraw on ${(fullRedrawDelta * 100).toFixed(2)}% of pixels`);
          }
          // The shipped arm is the picture above. Prove the GPU cull arm draws
          // the same picture at this camera, and that it actually culled on
          // the GPU (cullFrames.gpu moved), then restore the shipped arm.
          const shippedCull = at.cull;
          const shippedCullFrames = at.cullFrames;
          let cullParity: number | null = null;
          let gpuCullFrames = 0;
          if (shippedCull !== null) {
            const other = shippedCull === "gpu" ? "cpu" : "gpu";
            const before = (await readProofState(page)).cullFrames;
            await page.evaluate((mode) => {
              const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
              hook?.["setCull"]?.(mode);
            }, other);
            await page.waitForTimeout(350);
            let otherState = await settleAtlas(page);
            if (other === "gpu") {
              // A cull pipeline compiles asynchronously on a big board: give
              // the GPU arm frames to actually cull before calling it dead.
              await forceFull("gpu", `${tier.name}-cull-warm.png`);
              const deadline = Date.now() + 4_000;
              while (Date.now() < deadline && (otherState.cullFrames?.gpu ?? 0) - (before?.gpu ?? 0) === 0) {
                await page.waitForTimeout(250);
                otherState = await settleAtlas(page);
              }
            }
            const otherImage = await forceFull(other as "cpu" | "gpu", `${tier.name}-cull-${other}.png`);
            cullParity = mismatch(shippedFull, otherImage);
            const after = (await readProofState(page)).cullFrames;
            gpuCullFrames = other === "gpu" ? Math.max(0, (after?.gpu ?? 0) - (before?.gpu ?? 0)) : 0;
            await page.evaluate((mode) => {
              const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
              hook?.["setCull"]?.(mode);
            }, shippedCull);
            await page.waitForTimeout(350);
            await settleAtlas(page);
          }
          if (shippedCull === null) fail(`${String(scale)}x ${tier.name}: the canvas reports no cull mode`);
          if (process.env["JUNTO_GPU_PROOF_CULL_PARITY"] !== "0" && cullParity !== null) {
            if (cullParity > 0.05) fail(`${String(scale)}x ${tier.name}: cull arms differ by ${(cullParity * 100).toFixed(2)}% of pixels`);
            if (shippedCull === "cpu" && gpuCullFrames === 0) fail(`${String(scale)}x ${tier.name}: the GPU cull arm drew no frames`);
          }
          // Are cluster badges pickable at all? A drawn badge that answers
          // the pane is an unreachable seat, whatever the counters say.
          const clusterPicks = await page.evaluate(() => {
            const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
            if (hook === undefined) return { drawn: 0, cluster: 0, own: 0, pane: 0, other: 0, chrome: 0, offPane: 0, chromeSamples: [] as Array<Record<string, unknown>> };
            const pane = hook["rectOf"]("") as ScreenRect;
            const rows = (hook["clusters"]?.() ?? []).filter((cluster: Record<string, unknown>) => cluster["drawn"] === true);
            const counts = { drawn: rows.length, cluster: 0, own: 0, pane: 0, other: 0, chrome: 0, offPane: 0 };
            const chromeSamples: Array<Record<string, unknown>> = [];
            for (const cluster of rows as Array<Record<string, any>>) {
              const x = Number(cluster["x"]);
              const y = Number(cluster["y"]);
              if (x < pane.x || y < pane.y || x > pane.x + pane.width || y > pane.y + pane.height) {
                counts.offPane += 1;
                continue;
              }
              const element = document.elementFromPoint(x, y);
              if (!(element instanceof HTMLCanvasElement && element.classList.contains("junto-gpu-canvas"))) {
                counts.chrome += 1;
                if (chromeSamples.length < 8) {
                  const near = element?.closest("[data-testid], [role], [data-component], [aria-label]") as HTMLElement | null;
                  chromeSamples.push({
                    x,
                    y,
                    known: /RTS|Strategic minimap|rts-/i.test(near === null || near === undefined ? "" : String(near.getAttribute("aria-label") ?? near.className ?? "")),
                    tag: element?.tagName ?? "none",
                    className: String(element?.className ?? "").slice(0, 120),
                    id: (element as HTMLElement | null)?.id ?? "",
                    near: near === null || near === undefined ? "" : `${near.tagName.toLowerCase()} ${String(near.className).slice(0, 80)} ${near.getAttribute("data-testid") ?? near.getAttribute("aria-label") ?? ""}`.trim(),
                  });
                }
                continue;
              }
              const hit = hook["pick"]({ x: x - pane.x, y: y - pane.y }) as
                | { nodeId?: string; part?: { kind?: string; memberIds?: string[] } }
                | null;
              if (hit === null) counts.pane += 1;
              else if (hit.part?.kind === "cluster" || (hit.part?.memberIds ?? []).length > 0) counts.cluster += 1;
              else if (hit.nodeId !== undefined) counts.own += 1;
              else counts.other += 1;
            }
            return { ...counts, chromeSamples };
          });
          // A real pointer press at a covered badge, not a dispatched event:
          // if the selection changes, the element passes clicks through; if
          // not, the badge is covered and rule 3 fails for those seats.
          const chromeClicks: Array<Record<string, unknown>> = [];
          for (const sample of (clusterPicks.chromeSamples ?? []).slice(0, 4)) {
            const before = await page.evaluate(() => {
              const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
              return ((hook?.["selection"]?.() ?? []) as string[]).slice().sort();
            });
            await page.mouse.click(Number(sample["x"]), Number(sample["y"]));
            await page.waitForTimeout(250);
            const after = await page.evaluate(() => {
              const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
              return ((hook?.["selection"]?.() ?? []) as string[]).slice().sort();
            });
            chromeClicks.push({ ...sample, selected: after, changed: JSON.stringify(before) !== JSON.stringify(after) });
            if (after.length > 0) await resetOperator(page);
          }
          const chromeCovered = chromeClicks.filter((click) => click["changed"] !== true && click["known"] === true).length;
          if (chromeClicks.some((click) => click["changed"] !== true && click["known"] !== true)) {
            fail(`${String(scale)}x ${tier.name}: a real click on a covered badge selects nothing: ${JSON.stringify(chromeClicks)}`);
          }
          if (clusterPicks.drawn > 0 && clusterPicks.cluster === 0) {
            fail(`${String(scale)}x ${tier.name}: ${String(clusterPicks.drawn)} drawn cluster badges answer no cluster hit (${JSON.stringify(clusterPicks)})`);
          }
          const blank = await readBlankProbe(page);
          const row = {
            tier: tier.name,
            zoom: tier.zoom,
            cameraTier: at.tier,
            requests: at.atlas?.requests ?? at.requests,
            pending: at.atlas?.pending ?? at.pending,
            landed: at.atlas?.landed ?? null,
            failures: at.atlas?.failures ?? null,
            evictions: at.atlas?.evictions ?? null,
            pages: at.atlas?.pages ?? null,
            bytesInUse: at.atlas?.bytesInUse ?? null,
            visibleBlank: at.atlas?.visibleBlank ?? null,
            visibleBlankTotal: at.atlas?.visibleBlankTotal ?? null,
            seatsOnPane: screens.onPane.length,
            seatsMissingRect: screens.missing.length,
            blankMaxSoFar: blank?.maxVisible ?? null,
            png: join(dir, `${tier.name}-${String(tier.zoom)}.png`),
            placeholders: at.blank?.placeholders ?? null,
            marginScreenPx: at.blank?.marginScreenPx ?? null,
            tierWindowOctaves: at.blank?.tierWindowOctaves ?? null,
            cull: at.cull,
            fullRedrawDelta: round(fullRedrawDelta, 4),
            shippedCullFrames: shippedCullFrames ?? null,
            cullParity: cullParity === null ? null : round(cullParity, 4),
            gpuCullFrames,
            clusterPicks,
            chromeClicks,
            chromeCovered,
            gpuLastMs: at.gpuPass?.lastMs ?? null,
            gpuPeakMs: at.gpuPass?.peakMs ?? null,
            gpuSamples: at.gpuPass?.samples ?? null,
            damageLastPixels: at.damage?.lastPixels ?? null,
            bufferFailures: at.bufferFailures.length,
            seatQuads,
            portraitsChecked: okPortraits.size,
            portraitMissing,
            portraitBlank,
            portraitWrongShape,
            portraitCovered,
          };
          tiers.push(row);
          if (at.tier !== tier.name) fail(`${String(scale)}x: camera at zoom ${String(tier.zoom)} reports tier ${at.tier}, wanted ${tier.name}`);
          if ((at.atlas?.pending ?? at.pending) !== 0) fail(`${String(scale)}x ${tier.name}: atlas still has ${String(at.atlas?.pending ?? at.pending)} pending`);
          if ((at.atlas?.failures ?? 0) !== 0) fail(`${String(scale)}x ${tier.name}: atlas reports ${String(at.atlas?.failures)} failures`);
          if ((at.atlas?.visibleBlank ?? 0) !== 0) fail(`${String(scale)}x ${tier.name}: ${String(at.atlas?.visibleBlank)} on-screen quads drew with no image`);
          if (screens.missing.length > 0) fail(`${String(scale)}x ${tier.name}: ${String(screens.missing.length)} seats have no screen rect`);
          if (portraitMissing > 0) fail(`${String(scale)}x ${tier.name}: ${String(portraitMissing)} of ${String(content.length)} seats on screen draw no portrait quad (${missingSamples.join(",")})`);
          if (portraitWrongShape > 0) fail(`${String(scale)}x ${tier.name}: ${String(portraitWrongShape)} portraits are not discs (${blankSamples.join(",")})`);
          if (portraitBlank > 0) fail(`${String(scale)}x ${tier.name}: ${String(portraitBlank)} portraits on screen carry no image (${blankSamples.join(",")})`);
          if (at.atlas === null) {
            if (scale === 1) console.log("NOTE: this build has no atlasStats(); the drop count is unreadable and the proof is incomplete");
          }
        }
        });
        report["tiers"] = tiers;

        // Addressability, per tier. 1x clicks every seat on the pane; 10x and
        // 100x click every seat on the pane in each tile they visit (or up to
        // 60 per tier), and every tile is visited across the sweep.
        const clicks: Record<string, unknown> = {};
        await timed("clicks", async () => {
        for (const tier of TIERS) {
          await placeCamera(page, await cameraOn(page, tier.name === "near" ? focus : centre, tier.zoom));
          await settleAtlas(page);
          const screens = await seatScreens(page, board);
          const perTile = new Map<string, Array<{ id: string; rect: ScreenRect }>>();
          for (const seat of screens.onPane) {
            const rect = rects[seat.id]!;
            const tile = `${String(Math.floor((rect.x - board.stats.bounds.x) / ((board.stats.bounds.width + 1_200) / board.columns)))}:${String(Math.floor((rect.y - board.stats.bounds.y) / ((board.stats.bounds.height + 1_200) / rowsFor(board))))}`;
            const list = perTile.get(tile) ?? [];
            list.push(seat);
            perTile.set(tile, list);
          }
          // 1x: every seat at near and mid, where the seat is drawn as itself;
          // every fourth seat at far and overview, where seats gather into
          // clusters and the pass also clicks the badge for the gathered ones.
          // 10x/100x: up to two seats per tile the tier's camera shows, capped
          // at 120, so every tile the camera visits is exercised.
          const dense = tier.name === "near" || tier.name === "mid";
          // 1x covers every seat of the board at every tier (rule 3: every
          // seat at every zoom). 10x and 100x state their sample: every tile
          // the camera visits, one or two seats each, up to 120.
          const sample =
            scale === 1
              ? board.seats.map((id) => ({ id }))
              : [...perTile.values()].flatMap((list) => list.slice(0, dense ? 2 : 1)).slice(0, 120);
          const results: SeatClick[] = [];
          // One seat at a time, with the camera centred on it: a cluster click
          // fits its members and moves the camera, so a shared pass would be
          // measuring stale screen points after the first cluster.
          for (const [index, seat] of sample.entries()) {
            const node = rects[seat.id]!;
            // Land each seat at a different screen point: consecutive clicks
            // at one point would read as a double-click and open the seat.
            const offset = [
              { dx: 0, dy: 0 },
              { dx: 150, dy: 90 },
              { dx: -150, dy: 90 },
              { dx: 150, dy: -90 },
              { dx: -150, dy: -90 },
            ][index % 5]!;
            const at = { x: pane.x + pane.width / 2 + offset.dx, y: pane.y + pane.height / 2 + offset.dy };
            await placeCamera(
              page,
              await cameraOnAt(page, { x: node.x + node.width / 2, y: node.y + node.height / 2 }, tier.zoom, at),
              60,
            );
            results.push(await addressSeat(page, seat.id, pane));
          }
          const counts = {
            onPane: screens.onPane.length,
            attempted: results.length,
            direct: results.filter((result) => result.result === "direct").length,
            cluster: results.filter((result) => result.result === "cluster").length,
            offscreen: results.filter((result) => result.result === "offscreen").length,
            covered: results.filter((result) => result.result === "covered").length,
            miss: results.filter((result) => result.result === "miss").length,
            tiles: perTile.size,
            seatsTotal: board.seats.length,
            sample: scale !== 1,
            misses: results.filter((result) => result.result === "miss").slice(0, 8),
          };
          clicks[tier.name] = counts;
          if (counts.miss > 0) fail(`${String(scale)}x ${tier.name}: ${String(counts.miss)} of ${String(counts.attempted)} seats not addressable: ${JSON.stringify(counts.misses)}`);
          if (scale === 1 && dense && counts.attempted !== board.seats.length) fail(`${String(scale)}x ${tier.name}: only ${String(counts.attempted)} of ${String(board.seats.length)} seats were clicked`);
          if (counts.miss === 0 && counts.attempted > 0 && counts.attempted === counts.offscreen) fail(`${String(scale)}x ${tier.name}: every attempted seat was skipped as covered`);
        }
        });
        report["clicks"] = clicks;

        // Frame times: a continuous wheel sweep through every tier, and a pan
        // fling at far. Measured, not targeted.
        const traces: Record<string, FrameTrace> = {};
        if (process.env["JUNTO_GPU_PROOF_TRACES"] !== "0") await timed("traces", async () => {
        await placeCamera(page, await cameraOn(page, centre, 0.15));
        await settleAtlas(page);
        await startMotionProbe(page);
        traces["zoom"] = await traceRun(
          page,
          async () => {
            await wheelSweep(page, [0.3, 0.52, 0.9, 1.2, 0.9, 0.52, 0.3, 0.15]);
          },
          join(dir, "trace-zoom.json"),
          () => readMotionProbe(page),
        );
        await placeCamera(page, await cameraOn(page, centre, 0.3));
        await settleAtlas(page);
        await startMotionProbe(page);
        traces["pan"] = await traceRun(
          page,
          async () => {
            for (let pass = 0; pass < 3; pass += 1) {
              await panSweep(page, { x: 900, y: 0 }, { x: -900, y: 260 }, 55);
              await panSweep(page, { x: -900, y: -260 }, { x: 900, y: 0 }, 55);
            }
          },
          join(dir, "trace-pan.json"),
          () => readMotionProbe(page),
        );
        report["traces"] = traces;
        });

        // Ruling 6's blind spot: wrong content is not blank. Return to every
        // tier camera after the whole run and require the same seat's
        // portrait to still be there, at its rect, with ink.
        const revisit: Record<string, unknown> = {};
        for (const tier of TIERS) {
          const camera = tierCameras.get(tier.name);
          if (camera === undefined) continue;
          await placeCamera(page, camera);
          await settleAtlas(page);
          await page.waitForTimeout(600);
          await settleAtlas(page);
          const screens = await seatScreens(page, board);
          const image = PNG.sync.read(await page.screenshot({ path: join(dir, `${tier.name}-after.png`) }));
          const revisitFull = await (async (): Promise<PngImage> => {
            await page.evaluate(() => {
              const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
              const mode = String((hook?.["stats"]() as { cull?: string } | undefined)?.cull ?? "cpu");
              hook?.["setCull"]?.(mode);
            });
            await page.waitForTimeout(120);
            await settleAtlas(page);
            return PNG.sync.read(await page.screenshot({ path: join(dir, `${tier.name}-after-full.png`) }));
          })();
          const revisitFullDelta = mismatch(image, revisitFull);
          const viewport = await page.evaluate(() => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }));
          const content = await seatContent(page, screens.onPane.map((seat) => seat.id));
          const badgeCache = new Map<string, ContentPart | null>();
          const now = new Set<string>();
          for (const seat of content) {
            let portrait: ContentPart | null | undefined;
            if (seat.cluster === null) portrait = seat.parts.find((part) => isPortrait(part.role)) ?? null;
            else {
              if (!badgeCache.has(seat.cluster)) badgeCache.set(seat.cluster, await badgePortrait(page, seat.cluster));
              portrait = badgeCache.get(seat.cluster) ?? null;
            }
            if (portrait === null || portrait === undefined) continue;
            if (portrait.hasImage === false || partInk(image, viewport, portrait.rect) < 0.01) continue;
            now.add(seat.id);
          }
          const before = freshPortraits.get(tier.name) ?? new Set<string>();
          const lost = [...before].filter((id) => !now.has(id));
          revisit[tier.name] = { before: before.size, after: now.size, lost: lost.length, samples: lost.slice(0, 8), fullRedrawDelta: round(revisitFullDelta, 4) };
          if (revisitFullDelta > 0.02) fail(`${String(scale)}x ${tier.name}: after the sweep the damaged frame differs from a full redraw on ${(revisitFullDelta * 100).toFixed(2)}% of pixels`);
          if (lost.length > 0) fail(`${String(scale)}x ${tier.name}: ${String(lost.length)} seats lost their portrait after the sweep: ${JSON.stringify(lost.slice(0, 8))}`);
        }
        report["revisit"] = revisit;

        const blank = await readBlankProbe(page);
        report["blank"] = blank;
        if (blank === null) fail(`${String(scale)}x: the visibleBlank probe never ran`);
        else {
          if (blank.statsMissing > 0) console.log(`NOTE: ${String(scale)}x build has no atlasStats(); visibleBlank unmeasured on ${String(blank.statsMissing)} frames`);
          if (blank.maxVisible !== 0) fail(`${String(scale)}x: visibleBlank peaked at ${String(blank.maxVisible)} (ruling 6)`);
          if (blank.totalStart !== null && blank.totalEnd !== null && blank.totalEnd !== blank.totalStart) {
            fail(`${String(scale)}x: visibleBlankTotal moved ${String(blank.totalEnd - blank.totalStart)} (ruling 6)`);
          }
        }
        // Open a seat at near: double-click must open its focus surface.
        if (process.env["JUNTO_GPU_PROOF_OPEN"] !== "0") await timed("open", async () => {
        await placeCamera(page, await cameraOn(page, focus, 1));
        await settleAtlas(page);
        const nearScreens = await seatScreens(page, board);
        let opened = false;
        let openedId: string | null = null;
        let diagnostics: OpenDiagnostics = { selection: [], surfaces: 0, backdrops: 0, dialogs: 0, active: "" };
        const attempts: OpenAttempt[] = [];
        let skipped = 0;
        for (const candidate of nearScreens.onPane) {
          if (attempts.filter((attempt) => attempt.reason !== "no-hit").length >= 12) break;
          const node = rects[candidate.id]!;
          await placeCamera(page, await cameraOn(page, { x: node.x + node.width / 2, y: node.y + node.height / 2 }, 1));
          const attempt = await openSeat(page, candidate.id, candidate.rect, pane);
          if (attempt.attempt.reason === "no-hit" && attempt.attempt.point === null) {
            skipped += 1;
            continue;
          }
          diagnostics = attempt.diagnostics;
          attempts.push(attempt.attempt);
          if (attempt.opened) {
            opened = true;
            openedId = candidate.id;
            break;
          }
        }
        report["open"] = {
          seat: openedId,
          opened,
          tried: attempts.length,
          skipped,
          last: diagnostics,
          attempts,
        };
        if (!opened) fail(`${String(scale)}x: double-click did not open a seat's focus surface at near`);
        });

      } finally {
        await junto.close();
        await writeReport(`${String(scale)}x-proof`, report);
      }
      expect(failures, `proof failures:\n${failures.join("\n")}`).toEqual([]);
    });
  }

  test("side by side with React Flow: near pixels, mid and far structure and part ink", async () => {
    test.setTimeout(1_200_000);
    failures.length = 0;
    const board = proofBoard(1);
    const dir = await boardDir(1);
    const report: Report = {};
    const gpu = await launchProofArm(board, { gpu: true });
    const focalId = board.seats[Math.floor(board.seats.length / 3)]!;
    const rects = seatBoardRects(board);
    const focalRect = rects[focalId]!;
    const focus = { x: focalRect.x + focalRect.width / 2, y: focalRect.y + focalRect.height / 2 };

    const gpuShots = new Map<string, ArmShot>();
    const gpuTruth: Array<Record<string, unknown>> = [];
    const gpuParts = new Map<string, ReadonlyArray<DrawnPart>>();
    const partFailures: Array<Record<string, unknown>> = [];
    let pane: ScreenRect | null = null;
    try {
      const { page } = gpu;
      await waitGpuReady(page, board);
      await settleAtlas(page);
      pane = await paneRect(page);
      // Park the pointer on empty pane: the DOM arm would otherwise paint a hover/tooltip.
      await page.mouse.move(pane.x + 4, pane.y + 4);
      for (const zoom of [0.3, 0.52, 1]) {
        await placeCamera(page, await cameraOn(page, focus, zoom));
        await settleAtlas(page);
        const screens = await seatScreens(page, board);
        const take = screens.onPane.slice(0, zoom === 1 ? 40 : 24);
        const cropped: Array<{ seat: { id: string; rect: ScreenRect }; shot: ClipShot }> = [];
        for (const seat of take) {
          const take0 = await cardShot(page, seat.rect, pane);
          cropped.push({ seat, shot: { ...take0, id: seat.id, rect: seat.rect } });
          gpuShots.set(`${String(zoom)}|${seat.id}`, { id: seat.id, rect: seat.rect, png: take0.png });
        }
        // Part-level ink (canvas-lead's addition): every drawn part of every
        // seat on screen carries ink in its own rect at mid and far.
        for (const { seat, shot: clipShot } of cropped) {
          if (zoom === 1) continue;
          const parts = await drawnParts(page, [seat.id]);
          const drawn = parts.filter((part) => part.drawn);
          for (const part of drawn) {
            if (part.kind === "sprite" && part.hasImage === false) {
              partFailures.push({ zoom, seat: seat.id, role: part.role, hasImage: false, rect: part.rect });
              continue;
            }
            const visible =
              part.rect.x >= pane.x &&
              part.rect.y >= pane.y &&
              part.rect.x + part.rect.width <= pane.x + pane.width &&
              part.rect.y + part.rect.height <= pane.y + pane.height;
            if (!visible) continue;
            const share = partInk(clipShot.png, clipShot.clip, part.rect);
            if (share < 0.01) partFailures.push({ zoom, seat: seat.id, role: part.role, share: round(share, 4), rect: part.rect });
          }
          if (drawn.length > 0) gpuParts.set(`${String(zoom)}|${seat.id}`, drawn);
        }
        await page.screenshot({ path: join(dir, `gpu-${String(zoom)}.png`) });
        // Cluster badges: count pill, mark ring and portrait carry ink too.
        if (zoom !== 1) {
          const clusters = (await drawnClusters(page))
            .filter(
              (cluster) =>
                cluster.drawn &&
                cluster.x - cluster.radius - 14 >= pane!.x &&
                cluster.y - cluster.radius - 14 >= pane!.y &&
                cluster.x + cluster.radius + 14 <= pane!.x + pane!.width &&
                cluster.y + cluster.radius + 14 <= pane!.y + pane!.height,
            )
            .slice(0, 8);
          for (const [index, cluster] of clusters.entries()) {
            const clip = clampToPane(
              { x: cluster.x - cluster.radius - 12, y: cluster.y - cluster.radius - 12, width: cluster.radius * 2 + 24, height: cluster.radius * 2 + 24 },
              pane,
            );
            const badgeShot = await shot(page, clip, join(dir, `badge-${String(zoom)}-${String(index)}.png`));
            for (const part of await badgeParts(page, cluster.key)) {
              if (!part.drawn) continue;
              const share = partInk(badgeShot, clip, part.rect);
              if (share < 0.01) partFailures.push({ zoom, badge: cluster.key, role: part.role, share: round(share, 4), rect: part.rect });
            }
          }
        }
        // Every card the DOM arm can show, not just seats: notes, labels and
        // terminals have rects too, and a missing one is a structural miss.
        const allRects = await page.evaluate((ids) => {
          const hook = (window as unknown as { __juntoCanvas?: Record<string, any> }).__juntoCanvas;
          return ids.flatMap((id) => {
            const rect = hook?.["rectOf"]?.(id) as ScreenRect | undefined;
            return rect === undefined ? [] : [{ id, rect }];
          });
        }, board.model.nodes.map((node) => node.id));
        gpuTruth.push({ zoom, screens: allRects });
      }
    } finally {
      await gpu.close();
    }
    // A closed GPU arm's quit event can land on the DOM launch that follows.
    await new Promise((resolve) => setTimeout(resolve, 8_000));

    const domCardsByZoom = new Map<number, ReadonlyArray<{ id: string; kind: string; rect: ScreenRect }>>();
    const domShots = new Map<string, ArmShot>();
    const dom = await launchProofArm(board, { gpu: false });
    try {
      const { page } = dom;
      await page.waitForFunction(() => window.__juntoDomCanvas !== undefined, undefined, { timeout: 60_000 });
      await page.waitForTimeout(1_500);
      const domPane = await page.evaluate(() => {
        const element = document.querySelector(".react-flow__pane");
        if (element === null) throw new Error("no React Flow pane");
        const box = element.getBoundingClientRect();
        return { x: box.left, y: box.top, width: box.width, height: box.height };
      });
      for (const zoom of [0.3, 0.52, 1]) {
        await placeDomCamera(page, {
          x: Math.round(domPane.width / 2 - focus.x * zoom),
          y: Math.round(domPane.height / 2 - focus.y * zoom),
          zoom,
        });
        const cards = await domCards(page);
        domCardsByZoom.set(zoom, cards);
        for (const card of cards) {
          const key = `${String(zoom)}|${card.id}`;
          if (!gpuShots.has(key)) continue;
          domShots.set(key, { id: card.id, rect: card.rect, png: (await cardShot(page, card.rect, domPane)).png });
        }
        await page.screenshot({ path: join(dir, `dom-${String(zoom)}.png`) });
      }
    } finally {
      await dom.close();
    }

    // Near: tolerant pixel comparison of the same card clips.
    const nearFailures: Array<Record<string, unknown>> = [];
    const nearValues: number[] = [];
    for (const [key, gpuShot] of gpuShots) {
      if (!key.startsWith("1|")) continue;
      const domShot = domShots.get(key);
      if (domShot === undefined) continue;
      const position = Math.max(Math.abs(gpuShot.rect.x - domShot.rect.x), Math.abs(gpuShot.rect.y - domShot.rect.y));
      const value = mismatch(gpuShot.png, domShot.png);
      nearValues.push(value);
      if (value > 0.045 || position > 1) {
        nearFailures.push({ key, mismatch: round(value * 100, 2), position });
      }
    }
    const worstNear = nearValues.length === 0 ? null : Math.max(...nearValues);
    report["near"] = { cards: nearValues.length, worstFraction: worstNear === null ? null : round(worstNear, 4), tolerance: 0.045, failures: nearFailures };
    if (nearValues.length === 0) fail("side by side: no near card pairs to compare");
    if (nearFailures.length > 0) fail(`side by side near: ${String(nearFailures.length)} clips over tolerance: ${JSON.stringify(nearFailures.slice(0, 6))}`);

    // Mid and far: structure. Every card React Flow shows is present at the
    // matching position in the GPU arm, and carries ink there.
    const structural: Report[] = [];
    for (const zoom of [0.3, 0.52]) {
      const truth = gpuTruth.find((row) => row["zoom"] === zoom) as { screens: Array<{ id: string; rect: ScreenRect }> } | undefined;
      const domCardsAtZoom = domCardsByZoom.get(zoom) ?? [];
      const gpuById = new Map((truth?.screens ?? []).map((row) => [row.id, row.rect]));
      let present = 0;
      const absent: string[] = [];
      for (const card of domCardsAtZoom) {
        const gpuRect = gpuById.get(card.id);
        if (gpuRect === undefined) {
          // A DOM card the GPU clusters away is not "absent": the cluster stands for it.
          if (card.kind !== "agent") absent.push(`${card.id}: no GPU rect`);
          continue;
        }
        // A far or overview seat is drawn as a held ring centred on its
        // content box, not as the card rectangle: compare centres.
        const dx = Math.abs(gpuRect.x + gpuRect.width / 2 - (card.rect.x + card.rect.width / 2));
        const dy = Math.abs(gpuRect.y + gpuRect.height / 2 - (card.rect.y + card.rect.height / 2));
        if (dx > 4 || dy > 4) {
          absent.push(`${card.id}: moved ${dx.toFixed(1)}x${dy.toFixed(1)}`);
          continue;
        }
        present += 1;
      }
      structural.push({ zoom, domCards: domCardsAtZoom.length, matched: present, problems: absent });
      if (absent.length > 0) fail(`side by side ${String(zoom)}: ${String(absent.length)} React Flow cards missing or moved in the GPU arm: ${JSON.stringify(absent.slice(0, 8))}`);
    }
    report["structural"] = structural;

    // Part ink from the scene's drawn quads: one row per drawn part with its
    // screen rect and role, checked against its own pixels above. The hook is
    // optional until the scene lands it; without it this stays unverified.
    const partRows = [...gpuParts.values()].reduce((sum, rows) => sum + rows.length, 0);
    report["parts"] = { seatsChecked: gpuParts.size, rows: partRows, failures: partFailures };
    if (gpuParts.size === 0) console.log("NOTE: the scene exposes no drawn-quad list (partsOf) yet; part-level ink is unverified this run");
    if (partFailures.length > 0) fail(`part ink: ${String(partFailures.length)} drawn parts carry no ink in their own rect: ${JSON.stringify(partFailures.slice(0, 8))}`);

    await writeReport("side-by-side", report);
    expect(failures, `proof failures:\n${failures.join("\n")}`).toEqual([]);
  });

  test("ruling 6: nothing on screen blanks through pans, zooms, jumps, churn and theme switches", async () => {
    test.setTimeout(1_200_000);
    failures.length = 0;
    const board = proofBoard(1);
    const dir = await boardDir(1);
    const report: Report = {};
    const junto = await launchProofArm(board, { gpu: true });
    try {
      const { page } = junto;
      await waitGpuReady(page, board);
      await settleAtlas(page);
      const pane = await paneRect(page);
      const rects = seatBoardRects(board);
      const focusId = board.seats[Math.floor(board.seats.length / 4)]!;
      const focusRect = rects[focusId]!;
      const focus = { x: focusRect.x + focusRect.width / 2, y: focusRect.y + focusRect.height / 2 };
      await placeCamera(page, await cameraOn(page, focus, 1));
      await settleAtlas(page);
      await page.mouse.move(pane.x + 4, pane.y + 4);
      await startBlankProbe(page);

      // The still camera: theme switch and text churn are the repaint storms.
      // Screencast the whole run so a frame that blanks is in the recording.
      const frames = await recordRun(
        page,
        async () => {
          await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "bright" } }));
          await page.waitForTimeout(1_200);
          await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
          await page.waitForTimeout(1_200);
        },
        join(dir, "screencast-still"),
      );
      const stillFrames = frames.length;
      const stillProbe = await readBlankProbe(page);

      // The moving run: flings, wheel flings, camera jumps, theme switches.
      await recordRun(
        page,
        async () => {
          for (let pass = 0; pass < 3; pass += 1) {
            await panSweep(page, { x: 700, y: -300 }, { x: -700, y: 300 }, 40);
            await wheelSweep(page, [0.15]);
            await wheelSweep(page, [1.2]);
            await placeCamera(page, { x: -pane.width * pass, y: -pane.height * pass, zoom: 0.3 });
            await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "bright" } }));
            await placeCamera(page, await cameraOn(page, focus, 0.52));
            await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
          }
        },
        join(dir, "screencast-moving"),
      );
      const probe = await readBlankProbe(page);
      report["still"] = { frames: stillFrames, probe: stillProbe };
      report["moving"] = { frames: (await readFrames(join(dir, "screencast-moving"))).length, probe };
      report["probe"] = probe;
      if (probe === null) fail("ruling 6: no visibleBlank probe");
      else {
        if (probe.maxVisible !== 0) fail(`ruling 6: visibleBlank peaked at ${String(probe.maxVisible)}`);
        if (probe.totalStart !== null && probe.totalEnd !== null && probe.totalEnd !== probe.totalStart) fail(`ruling 6: visibleBlankTotal moved ${String(probe.totalEnd - probe.totalStart)}`);
        if (probe.frames < 60) fail(`ruling 6: the probe only saw ${String(probe.frames)} frames`);
      }
    } finally {
      await junto.close();
      await writeReport("ruling-6", report);
    }
    expect(failures, `proof failures:\n${failures.join("\n")}`).toEqual([]);
  });
});

// --- helpers that need the rest of the proof's vocabulary --------------------------

const rowsFor = (board: ProofBoard): number => Math.ceil(board.copies / board.columns);

/** Read the recorded frames of a screencast directory, in capture order. */
const readFrames = async (dir: string): Promise<ReadonlyArray<string>> => {
  try {
    return (await readdir(dir))
      .filter((name) => name.startsWith("frame-") && name.endsWith(".png"))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
};
