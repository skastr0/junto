/**
 * The GPU seat at the zooms the operator actually works: a compact mid pill
 * (0.46 to 0.62), the held far portrait below it, and the full-detail hover
 * bloom at both. The legacy DOM is not part of this design; its look gallery
 * stays at near and the quiet overview ring.
 *
 * Every assertion reads a real Electron PNG. The hook gives the card's board
 * rectangle, the camera and the atlas queue; the pixels decide whether the
 * pill hugged its words, whether the far card is portraits-only, and whether
 * the hovered card bloomed. One seat alone on the board keeps the bloom's
 * pixels unambiguous.
 */

import { expect, test } from "../harness/launch";
import { camera, cameraSettled, card, canvasReady, pane } from "../harness/canvas";
import { modelFixture, modelSeat } from "../harness/model";
import { createRequire } from "node:module";
import type { Page } from "@playwright/test";

interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  readonly PNG: { readonly sync: { read(buf: Buffer): PngImage } };
};

const CANVAS = "factory";
const SEAT_ID = "zoom-seat";
const fixture = modelFixture([
  modelSeat({ id: SEAT_ID, key: "local:zoom-seat", bindingId: "local:zoom-seat", label: "Ada", x: 0, y: 0 }),
]);

test.use({
  juntoOptions: {
    seedModels: { [CANVAS]: fixture },
    seedExperimentalFeatures: ["gpuCanvas"],
  },
});

const atlasSettled = async (page: Page): Promise<void> => {
  await page.waitForTimeout(220);
  await expect.poll(() => page.evaluate(() => window.__juntoCanvas?.atlasPending?.() ?? 0), { timeout: 20_000 }).toBe(0);
  await page.waitForTimeout(120);
};

const placeCamera = async (page: Page, zoom: number): Promise<void> => {
  const box = await pane(page).box();
  if (box === null) throw new Error("no canvas pane");
  const target = { x: Math.round(box.width / 2), y: Math.round(box.height / 2), zoom };
  await page.evaluate((to) => {
    const hook = window.__juntoCanvas;
    if (hook?.moveCamera === undefined) throw new Error("no canvas hook");
    hook.moveCamera(to);
  }, target);
  await expect.poll(async () => {
    const at = await camera(page);
    return Math.max(Math.abs(at.x - target.x), Math.abs(at.y - target.y), Math.abs(at.zoom - zoom));
  }, { timeout: 10_000 }).toBeLessThanOrEqual(0.01);
  await page.waitForTimeout(300);
  await cameraSettled(page);
  await atlasSettled(page);
};

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type Shot = { readonly png: PngImage; readonly origin: { readonly x: number; readonly y: number } };

const shot = async (page: Page, rect: Rect, margin: number, path: string): Promise<Shot> => {
  const clip = {
    x: Math.floor(rect.x - margin),
    y: Math.floor(rect.y - margin),
    width: Math.ceil(rect.width + margin * 2),
    height: Math.ceil(rect.height + margin * 2),
  };
  const buffer = await page.screenshot({ clip, path });
  const png = PNG.sync.read(buffer);
  const sx = png.width / clip.width;
  const sy = png.height / clip.height;
  return { png, origin: { x: (rect.x - clip.x) * sx, y: (rect.y - clip.y) * sy } };
};

const diff = (image: PngImage, x: number, y: number, bg: readonly [number, number, number]): number => {
  const i = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  return Math.abs(image.data[i]! - bg[0]) + Math.abs(image.data[i + 1]! - bg[1]) + Math.abs(image.data[i + 2]! - bg[2]);
};

/** The region wash left of the seat: outside the card at every measured zoom. */
const background = (s: Shot): readonly [number, number, number] => {
  const i = (2 * s.png.width + 2) * 4;
  return [s.png.data[i]!, s.png.data[i + 1]!, s.png.data[i + 2]!];
};

const contentBox = (s: Shot, bg: readonly [number, number, number], tolerance = 20) => {
  let left = s.png.width;
  let right = -1;
  let top = s.png.height;
  let bottom = -1;
  for (let y = 0; y < s.png.height; y += 1) {
    for (let x = 0; x < s.png.width; x += 1) {
      if (diff(s.png, x, y, bg) <= tolerance) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return { left, right, top, bottom, width: right - left + 1, height: bottom - top + 1 };
};

const inkPixels = (s: Shot, x: number, y: number, width: number, height: number, bg: readonly [number, number, number], tolerance = 55): number => {
  let n = 0;
  for (let iy = Math.max(0, Math.floor(y)); iy < Math.min(s.png.height, Math.ceil(y + height)); iy += 1) {
    for (let ix = Math.max(0, Math.floor(x)); ix < Math.min(s.png.width, Math.ceil(x + width)); ix += 1) {
      if (diff(s.png, ix, iy, bg) > tolerance) n += 1;
    }
  }
  return n;
};

test("the GPU seat is a compact mid pill, a far portrait, and a full hover bloom", async ({ junto }, testInfo) => {
  test.setTimeout(180_000);
  const { page } = junto;
  await canvasReady(page);
  await expect.poll(() => page.evaluate(() => typeof window.__juntoCanvas?.ready === "function"), { timeout: 30_000 }).toBe(true);
  await canvasReady(page);
  await atlasSettled(page);

  // --- mid: 0.52, the short name hugs a narrow pill ---------------------------
  await placeCamera(page, 0.52);
  const midCard = await card(page, SEAT_ID).box();
  if (midCard === null) throw new Error("no seat card at mid");
  const mid = await shot(page, midCard, 20, "/tmp/gpu-seat-zoom-mid-0.52.png");
  const midScale = mid.png.width / (midCard.width + 40);
  const midBg = background(mid);
  const midBox = contentBox(mid, midBg);
  const midInk = inkPixels(mid, midBox.left + midBox.width * 0.5, midBox.top, midBox.width * 0.5, midBox.height, midBg);
  console.log(`MID 0.52 card=${midCard.width.toFixed(1)} scale=${midScale.toFixed(2)} content=${JSON.stringify(midBox)} ink=${midInk}`);
  expect(midInk).toBeGreaterThan(30);
  expect(midBox.width).toBeLessThan(midCard.width * midScale * 0.85);
  expect(midBox.height).toBeGreaterThan(20);

  // --- mid hover: the full near-detail card blooms ----------------------------
  await page.mouse.move(midCard.x + midCard.width / 2, midCard.y + midCard.height / 2);
  await page.waitForTimeout(350);
  await atlasSettled(page);
  const midHover = await shot(page, midCard, midCard.width * 1.6, "/tmp/gpu-seat-zoom-mid-0.52-hover.png");
  const midHoverBg = background(midHover);
  const midHoverBox = contentBox(midHover, midHoverBg);
  const midHoverInk = inkPixels(midHover, midHoverBox.left, midHoverBox.top, midHoverBox.width, midHoverBox.height, midHoverBg);
  console.log(`MID 0.52 hover content=${JSON.stringify(midHoverBox)} ink=${midHoverInk} cardW=${(midCard.width * midScale).toFixed(1)}`);
  expect(midHoverBox.width).toBeGreaterThan(midCard.width * midScale * 1.25);
  expect(midHoverInk).toBeGreaterThan(80);

  // --- far: 0.40, the held ring alone at rest, the full card on hover ---------
  await page.mouse.move(8, 8);
  await page.waitForTimeout(250);
  await placeCamera(page, 0.40);
  const farCard = await card(page, SEAT_ID).box();
  if (farCard === null) throw new Error("no seat card at far");
  const far = await shot(page, farCard, 30, "/tmp/gpu-seat-zoom-far-0.40.png");
  const farScale = far.png.width / (farCard.width + 60);
  const farBg = background(far);
  const farBox = contentBox(far, farBg);
  const farInk = inkPixels(far, farBox.right + 2, far.origin.y, Math.max(0, far.png.width - farBox.right - 3), farCard.height * farScale, farBg);
  console.log(`FAR 0.40 card=${farCard.width.toFixed(1)} scale=${farScale.toFixed(2)} content=${JSON.stringify(farBox)} ink=${farInk}`);
  expect(farInk).toBeLessThan(30);

  await page.mouse.move(farCard.x + farCard.width / 2, farCard.y + farCard.height / 2);
  await page.waitForTimeout(350);
  await atlasSettled(page);
  const farHover = await shot(page, farCard, farCard.width * 6, "/tmp/gpu-seat-zoom-far-0.40-hover.png");
  const farHoverBg = background(farHover);
  const farHoverBox = contentBox(farHover, farHoverBg);
  const farHoverInk = inkPixels(farHover, farHoverBox.left, farHoverBox.top, farHoverBox.width, farHoverBox.height, farHoverBg);
  console.log(`FAR 0.40 hover content=${JSON.stringify(farHoverBox)} ink=${farHoverInk} cardW=${(farCard.width * farScale).toFixed(1)}`);
  expect(farHoverBox.width).toBeGreaterThan(farBox.width * 2);
  expect(farHoverInk).toBeGreaterThan(80);
  testInfo.attach("mid.png", { path: "/tmp/gpu-seat-zoom-mid-0.52.png" });
});
