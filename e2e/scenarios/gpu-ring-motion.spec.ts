/**
 * Section 10's ring motion and section 8 rule 2's raster rule, on the real
 * GPU canvas.
 *
 * Operator alarm 2026-11-14: every moving ring stood frozen and zoom lagged.
 * Both were unseen by the unit tests: a ring's spin cell is a sprite quad, so
 * its turn has to rotate the quad, and `prepare()` re-resolved every visible
 * run on every wheel tick while the camera was still moving.
 *
 *   1. a working seat's ring changes pixels across frames, while a still card
 *      beside it does not (the control the old canvas would have failed);
 *   2. a wheel zoom starts no new atlas cell between its ticks and the
 *      camera's rest, and starts them once at rest (so the rule is not
 *      vacuous: the exact pass still happens, just not inside the gesture).
 *
 * Every claim here is read from a Playwright PNG of the real Electron window
 * and from the engine's own atlas count, not from the hook's arithmetic.
 *
 * Run: bun run test:e2e fast e2e/scenarios/gpu-ring-motion.spec.ts
 */

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { SeatStateMachine } from "../../src/core/term/agent-state";
import { SEAT } from "../../src/window/canvas/paint/card-spec";
import { cameraSettled, canvasReady, pane } from "../harness/canvas";
import { launchJunto } from "../harness/launch";
import { modelFixture, modelNote, modelSeat } from "../harness/model";

interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  readonly PNG: { readonly sync: { read(buf: Buffer): PngImage } };
};

const CANVAS = "factory";
const SEAT_ID = "seat-ring";
const NOTE_ID = "note-still";
const CHANNEL = "junto:agent-seat-state-changed";

const fixture = modelFixture([
  modelSeat({ id: SEAT_ID, key: "local:seat-ring", bindingId: "local:seat-ring", label: "Ring", x: 0, y: 0 }),
  modelNote(NOTE_ID, "still beside the ring", 360, 0),
]);

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

const send = (app: ElectronApplication, events: ReadonlyArray<unknown>): Promise<void> =>
  app.evaluate(
    ({ BrowserWindow }, { channel, events }) => {
      for (const w of BrowserWindow.getAllWindows()) for (const e of events) w.webContents.send(channel, e);
    },
    { channel: CHANNEL, events },
  );

const hookReady = (page: Page): Promise<boolean> =>
  page.evaluate(() => typeof window.__juntoCanvas?.atlasRequests === "function").catch(() => false);

/** A card's screen rectangle, or the ring's box inside it. */
const cardRect = (page: Page, id: string): Promise<Rect | null> =>
  page.evaluate((cardId) => window.__juntoCanvas?.rectOf(cardId) ?? null, id);

const zoomNow = (page: Page): Promise<number> => page.evaluate(() => window.__juntoCanvas!.camera().zoom);

const intersecting = (a: Rect, b: Rect): Rect => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(1, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(1, Math.min(a.y + a.height, b.y + b.height) - y) };
};

/** The card's ring box on screen (the ring sits at rowLeft/rowTop, `SEAT.ring` square). */
const ringRect = async (page: Page, id: string): Promise<Rect> => {
  const rect = await cardRect(page, id);
  if (rect === null) throw new Error(`no screen rectangle for ${id}`);
  const zoom = await zoomNow(page);
  return intersecting(
    { x: rect.x + SEAT.rowLeft * zoom, y: rect.y + SEAT.rowTop * zoom, width: SEAT.ring * zoom, height: SEAT.ring * zoom },
    { ...rect },
  );
};

const shot = async (page: Page, clip: Rect): Promise<PngImage> =>
  PNG.sync.read(await page.screenshot({ clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height }, scale: "css" }));

/** How many pixels of two same-size shots differ by more than a colour step. */
const differing = (a: PngImage, b: PngImage): number => {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let changed = 0;
  for (let index = 0; index < a.width * a.height; index += 1) {
    const at = index * 4;
    const d =
      Math.abs((a.data[at] ?? 0) - (b.data[at] ?? 0)) +
      Math.abs((a.data[at + 1] ?? 0) - (b.data[at + 1] ?? 0)) +
      Math.abs((a.data[at + 2] ?? 0) - (b.data[at + 2] ?? 0));
    if (d > 18) changed += 1;
  }
  return changed;
};

const atlasRequests = (page: Page): Promise<number> =>
  page.evaluate(() => window.__juntoCanvas?.atlasRequests?.() ?? -1);

const frames = (page: Page): Promise<number> => page.evaluate(() => window.__juntoCanvas!.stats().frames);

test("a working seat's ring turns on the GPU canvas; a still card does not", async () => {
  test.setTimeout(180_000);
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture }, seedExperimentalFeatures: ["gpuCanvas"] });
  try {
    const { app, page } = junto;
    await canvasReady(page);
    await page.waitForFunction(() => typeof window.__juntoCanvas?.ready === "function", undefined, { timeout: 30_000 }).catch(() => undefined);
    test.skip(!(await page.evaluate(() => typeof window.__juntoCanvas?.ready === "function")), "no GPU canvas hook in this build");

    // Working: the seat carries the `work` ring, whose comet turns a lap in 1440 ms.
    const machine = new SeatStateMachine({ now: () => Date.now() });
    machine.bind("local:seat-ring", { harness: "codex", epoch: "probe" });
    await send(app, [machine.force("local:seat-ring", "working", "probe:working")]);
    await page.waitForTimeout(1_200);

    const angle = await page.evaluate((id) => window.__juntoCanvas?.ringAngle?.(id) ?? null, SEAT_ID);
    expect(angle, "the seat's ring is turning").not.toBeNull();

    const ring = await ringRect(page, SEAT_ID);
    const note = await cardRect(page, NOTE_ID);
    if (note === null) throw new Error("no screen rectangle for the still note");
    // The note's inner box: its text and shell, no edge.
    const control = intersecting(note, { x: note.x + 12, y: note.y + 12, width: note.width - 24, height: note.height - 24 });

    // Six shots a beat apart, a third of the lap across the set.
    const firstRing = await shot(page, ring);
    const firstControl = await shot(page, control);
    let mostChanged = 0;
    let controlChanged = 0;
    for (let sample = 0; sample < 5; sample += 1) {
      await page.waitForTimeout(110);
      mostChanged = Math.max(mostChanged, differing(firstRing, await shot(page, ring)));
      controlChanged += differing(firstControl, await shot(page, control));
    }
    const ringPixels = firstRing.width * firstRing.height;
    expect(mostChanged, `a turning ring changes its pixels (${mostChanged} of ${ringPixels})`).toBeGreaterThan(
      Math.max(12, ringPixels * 0.004),
    );
    expect(controlChanged, "a still card's pixels never change").toBe(0);
  } finally {
    await junto.close();
  }
});

test("a wheel zoom rasters nothing until the camera rests, then rasters once", async () => {
  test.setTimeout(180_000);
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture }, seedExperimentalFeatures: ["gpuCanvas"] });
  try {
    const { page } = junto;
    await canvasReady(page);
    await page.waitForFunction(() => typeof window.__juntoCanvas?.atlasRequests === "function", undefined, { timeout: 30_000 }).catch(() => undefined);
    test.skip(!(await hookReady(page)), "the hook carries no atlas count in this build");

    await cameraSettled(page);
    await page.waitForTimeout(400);
    const before = await atlasRequests(page);
    const framesBefore = await frames(page);
    expect(before).toBeGreaterThan(0);

    // A pinch out: six small wheel ticks, back to back, inside one gesture.
    const box = await pane(page).box();
    if (box === null) throw new Error("no canvas pane to zoom over");
    const cdp = await page.context().newCDPSession(page);
    try {
      for (let tick = 0; tick < 6; tick += 1) {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
          deltaX: 0,
          deltaY: 8,
          modifiers: 2,
        });
      }
    } finally {
      await cdp.detach();
    }

    // Still inside the 160 ms settle window: the raster in hand is scaled.
    expect(await atlasRequests(page), "no cell asked between the ticks").toBe(before);
    expect(await frames(page), "the gesture drew frames").toBeGreaterThan(framesBefore);

    // At rest every visible run takes its exact cell at the new scale.
    await cameraSettled(page);
    await page.waitForTimeout(600);
    expect(await atlasRequests(page), "the exact pass happens once the camera rests").toBeGreaterThan(before);
  } finally {
    await junto.close();
  }
});
