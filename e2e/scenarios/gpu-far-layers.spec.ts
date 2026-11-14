/**
 * The two far layers, proved on the real GPU canvas's pixels.
 *
 *   1. Region watermarks: a named region prints its name across its body once
 *      the camera pulls back, and an unnamed one does not. Same camera, same
 *      tier, same fill: the named region's interior carries glyph ink and the
 *      unnamed one is flat.
 *   2. Seat clusters: at a far zoom three close seats gather into one badge,
 *      whose count pill is an `ink` rounded square at the badge's lower right;
 *      three loose seats at the same zoom draw no such pill.
 *
 * The hooks give screen rectangles and the tier; every claim is read from a
 * Playwright PNG, not from the hook agreeing with itself.
 *
 * Run: bun run test:e2e fast e2e/scenarios/gpu-far-layers.spec.ts
 */

import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { farSeatScale } from "../../src/shared/canvas-tier";
import { CLUSTER } from "../../src/window/canvas/paint/cluster";
import { cameraSettled, canvasReady, canvasTier, pane } from "../harness/canvas";
import { launchJunto } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";

interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  readonly PNG: { readonly sync: { read(buf: Buffer): PngImage } };
};

const CANVAS = "factory";
type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

const shot = async (page: Page, clip: Rect): Promise<PngImage> =>
  PNG.sync.read(await page.screenshot({ clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height }, scale: "device" }));

const luma = (png: PngImage, x: number, y: number): number => {
  const at = (Math.round(y) * png.width + Math.round(x)) * 4;
  const r = png.data[at] ?? 0;
  const g = png.data[at + 1] ?? 0;
  const b = png.data[at + 2] ?? 0;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

/** Pixels per CSS pixel in this shot. */
const pixels = (png: PngImage, clip: Rect): number => png.width / clip.width;

/** The share of pixels clearly off the clip's median: glyph ink over a flat wash, whichever way the theme inks. */
const litShare = (png: PngImage): number => {
  const values: number[] = [];
  for (let y = 0; y < png.height; y += 1) for (let x = 0; x < png.width; x += 1) values.push(luma(png, x, y));
  values.sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)] ?? 0;
  let lit = 0;
  for (const value of values) if (Math.abs(value - median) > 0.06) lit += 1;
  return lit / Math.max(1, values.length);
};

const cardRect = (page: Page, id: string): Promise<Rect | null> =>
  page.evaluate((cardId) => window.__juntoCanvas?.rectOf(cardId) ?? null, id);

const centreOf = (rect: Rect): { readonly x: number; readonly y: number } => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

const meanCentre = (rects: ReadonlyArray<Rect>): { readonly x: number; readonly y: number } => ({
  x: rects.reduce((sum, rect) => sum + rect.width / 2 + rect.x, 0) / rects.length,
  y: rects.reduce((sum, rect) => sum + rect.height / 2 + rect.y, 0) / rects.length,
});

/** Zoom with real wheel input, then wait for the camera and the settle step. */
const zoomTo = async (page: Page, zoom: number): Promise<void> => {
  const deadline = Date.now() + 20_000;
  const cdp = await page.context().newCDPSession(page);
  try {
    for (;;) {
      const cam = await page.evaluate(() => window.__juntoCanvas!.camera());
      if (Math.abs(cam.zoom - zoom) < 0.004) break;
      const box = await pane(page).box();
      if (box === null) throw new Error("no pane to zoom over");
      const factor = 0.002 * 10;
      const delta = -Math.log2(zoom / cam.zoom) / factor;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        deltaX: 0,
        deltaY: Math.max(-240, Math.min(240, delta)),
        modifiers: 2,
      });
      if (Date.now() >= deadline) throw new Error(`camera never reached zoom ${zoom}`);
      await page.waitForTimeout(80);
    }
  } finally {
    await cdp.detach();
  }
  await cameraSettled(page);
  // The glance step and any far art land at rest.
  await page.waitForTimeout(400);
};

test("a named region prints its watermark at a far zoom; an unnamed one stays flat", async () => {
  test.setTimeout(180_000);
  const fixture = modelFixture([
    modelRegion({ id: "region-named", label: "Alpha", x: 0, y: 0, width: 900, height: 560 }),
    modelRegion({ id: "region-blank", x: 1000, y: 0, width: 900, height: 560 }),
    // One seat keeps the canvas from being empty: its empty-state overlay
    // would otherwise print across a region's body and read as ink.
    modelSeat({ id: "bystander", key: "local:bystander", bindingId: "local:bystander", label: "Bystander", x: 0, y: 700 }),
  ]);
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture }, seedExperimentalFeatures: ["gpuCanvas"] });
  try {
    const { page } = junto;
    await canvasReady(page);
    await page.waitForFunction(() => typeof window.__juntoCanvas?.ready === "function", undefined, { timeout: 30_000 }).catch(() => undefined);
    test.skip(!(await page.evaluate(() => typeof window.__juntoCanvas?.ready === "function")), "no GPU canvas hook in this build");

    await zoomTo(page, 0.3);
    expect(await canvasTier(page), "the camera is far out").toBe("far");

    const interior = async (id: string): Promise<Rect> => {
      const rect = await cardRect(page, id);
      if (rect === null) throw new Error(`no screen rectangle for ${id}`);
      // Inside the title bar and the frame: flat region body.
      return { x: rect.x + 18, y: rect.y + 18, width: rect.width - 36, height: rect.height - 36 };
    };
    const named = await shot(page, await interior("region-named"));
    const blank = await shot(page, await interior("region-blank"));
    const namedLit = litShare(named);
    const blankLit = litShare(blank);
    // The name is large: a tenth of its region is glyph ink at this zoom.
    expect(namedLit, `the named region's watermark inks its body (lit ${namedLit.toFixed(4)})`).toBeGreaterThan(0.01);
    expect(blankLit, `the unnamed region is flat (lit ${blankLit.toFixed(4)})`).toBeLessThan(0.004);
    expect(namedLit).toBeGreaterThan(blankLit * 10);
  } finally {
    await junto.close();
  }
});

test("three close seats gather into a badge with a count pill; three loose seats do not", async () => {
  test.setTimeout(180_000);
  const tightIds = ["tight-a", "tight-b", "tight-c"];
  const looseIds = ["loose-a", "loose-b", "loose-c"];
  const fixture = modelFixture([
    modelSeat({ id: "tight-a", key: "local:tight-a", bindingId: "local:tight-a", label: "A", x: 0, y: 0 }),
    modelSeat({ id: "tight-b", key: "local:tight-b", bindingId: "local:tight-b", label: "B", x: 40, y: 0 }),
    modelSeat({ id: "tight-c", key: "local:tight-c", bindingId: "local:tight-c", label: "C", x: 80, y: 0 }),
    modelSeat({ id: "loose-a", key: "local:loose-a", bindingId: "local:loose-a", label: "D", x: 0, y: -800 }),
    modelSeat({ id: "loose-b", key: "local:loose-b", bindingId: "local:loose-b", label: "E", x: 200, y: -800 }),
    // Well clear of the triplet's centroid: its own ring cannot light the
    // control point the gathered badge's count pill occupies.
    modelSeat({ id: "loose-c", key: "local:loose-c", bindingId: "local:loose-c", label: "F", x: 400, y: -1500 }),
  ]);
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture }, seedExperimentalFeatures: ["gpuCanvas"] });
  try {
    const { page } = junto;
    await canvasReady(page);
    await page.waitForFunction(() => typeof window.__juntoCanvas?.ready === "function", undefined, { timeout: 30_000 }).catch(() => undefined);
    test.skip(!(await page.evaluate(() => typeof window.__juntoCanvas?.ready === "function")), "no GPU canvas hook in this build");

    await zoomTo(page, 0.3);
    expect(await canvasTier(page)).toBe("far");

    const zoom = await page.evaluate(() => window.__juntoCanvas!.camera().zoom);
    const seatScale = farSeatScale(zoom);
    // The count pill's box: CLUSTER.count is at the disc's lower right, and
    // every badge quad rides the far seat scale about the disc's centre.
    const pill = (centroid: { readonly x: number; readonly y: number }): Rect => {
      const middle = { x: centroid.x + (CLUSTER.disc / 2 + CLUSTER.count.right - CLUSTER.count.minWidth / 2) * seatScale * zoom, y: centroid.y + (CLUSTER.disc / 2 + CLUSTER.count.bottom - CLUSTER.count.height / 2) * seatScale * zoom };
      const size = CLUSTER.count.minWidth * seatScale * zoom;
      return { x: middle.x - size / 2, y: middle.y - size / 2, width: size, height: size };
    };

    const rects = async (ids: ReadonlyArray<string>): Promise<Rect[]> => {
      const out: Rect[] = [];
      for (const id of ids) {
        const rect = await cardRect(page, id);
        if (rect === null) throw new Error(`no screen rectangle for ${id}`);
        out.push(rect);
      }
      return out;
    };

    const tight = await rects(tightIds);
    const loose = await rects(looseIds);

    // Sample the pill: with a badge it is a filled rounded square in `ink`
    // with a `ground` digit, so the box carries two inks; without a badge
    // that board point is flat ground.
    const boxStats = async (centroid: { readonly x: number; readonly y: number }): Promise<{ median: number; contrast: number }> => {
      const box = pill(centroid);
      const clip = { x: box.x, y: box.y, width: Math.max(3, box.width), height: Math.max(3, box.height) };
      const png = await shot(page, clip);
      const scale = pixels(png, clip);
      const values: number[] = [];
      for (let iy = 1; iy <= 5; iy += 1) {
        for (let ix = 1; ix <= 5; ix += 1) {
          values.push(luma(png, ((clip.width * ix) / 6) * scale, ((clip.height * iy) / 6) * scale));
        }
      }
      values.sort((a, b) => a - b);
      return { median: values[Math.floor(values.length / 2)] ?? 0, contrast: (values[values.length - 1] ?? 0) - (values[0] ?? 0) };
    };

    const tightBox = await boxStats(meanCentre(tight));
    const looseBox = await boxStats(meanCentre(loose));
    expect(tightBox.contrast, `the gathered badge's count is an inked pill with a ground digit (${JSON.stringify(tightBox)})`).toBeGreaterThan(0.25);
    expect(Math.abs(tightBox.median - looseBox.median), `the pill's fill is not the ground (${JSON.stringify({ tightBox, looseBox })})`).toBeGreaterThan(0.15);
    expect(looseBox.contrast, `loose seats draw no pill (${JSON.stringify(looseBox)})`).toBeLessThan(0.1);
  } finally {
    await junto.close();
  }
});
