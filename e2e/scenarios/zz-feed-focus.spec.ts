/**
 * The focus cone on the GPU canvas, proved against rendered pixels.
 *
 * canvas-lead's audit: SelectionFact.focusMode was never populated, so the
 * engine's root/member/lead/outsider dimming never ran. The feed now derives
 * it (lib/canvas-focus.ts, same cone as Canvas.tsx) and hands.ts sends it.
 * This spec drives the real path — click a seat, press the selection
 * toolbar's "Focus node" button — and reads the dimming off a Playwright PNG
 * of the real Electron window: the wired partner stays lit, the unrelated
 * notes drop to the cone's outsider treatment.
 *
 * Run: bun run test:e2e fast e2e/scenarios/zz-feed-focus.spec.ts
 */

import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchJunto, type JuntoHandle } from "../harness/launch";
import { modelFixture, modelMessagesWire, modelNote, modelSeat } from "../harness/model";
import { cameraSettled } from "../harness/canvas";

interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  readonly PNG: { readonly sync: { read(buf: Buffer): PngImage } };
};

const CANVAS = "factory";
const OUT = join(tmpdir(), "junto-feed-focus");

const SEAT_A = "focus-seat-a";
const SEAT_B = "focus-seat-b";
const NOTE_1 = "focus-note-1";
const NOTE_2 = "focus-note-2";

// Two wired seats (the cone's members) above two unrelated notes (outsiders).
const nodes = [
  modelSeat({ id: SEAT_A, label: "Ada", x: 0, y: 0 }),
  modelSeat({ id: SEAT_B, label: "Bex", x: 480, y: 0 }),
  modelNote(NOTE_1, "Lonely note one", 0, 280),
  modelNote(NOTE_2, "Lonely note two", 480, 280),
];
const fixture = modelFixture(nodes, [modelMessagesWire("focus-w1", SEAT_A, SEAT_B, nodes)]);

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type Point = { readonly x: number; readonly y: number };
type Rgb = readonly [number, number, number];

const centre = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

const rgbAt = (image: PngImage, point: Point): Rgb => {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(point.x)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(point.y)));
  const at = (y * image.width + x) * 4;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
};

/** Mean luminance over a grid inside `rect` — the dimming measure. */
const luminance = (image: PngImage, rect: Rect): number => {
  let sum = 0;
  let count = 0;
  for (let iy = 2; iy <= 6; iy += 1) {
    for (let ix = 2; ix <= 6; ix += 1) {
      const [r, g, b] = rgbAt(image, { x: rect.x + (rect.width * ix) / 8, y: rect.y + (rect.height * iy) / 8 });
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      count += 1;
    }
  }
  return sum / count;
};

const shot = async (page: Page, name: string): Promise<PngImage> => {
  const buffer = await page.screenshot({ scale: "css" });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${name}.png`), buffer);
  return PNG.sync.read(buffer);
};

const hook = (page: Page) =>
  page.evaluate(() => {
    const canvas = window.__juntoCanvas!;
    return {
      rects: Object.fromEntries(canvas.cardIds().map((id) => [id, canvas.rectOf(id) ?? null])),
      camera: canvas.camera(),
      selected: canvas.selection(),
      stats: canvas.stats(),
    };
  });

const rectOf = async (page: Page, id: string): Promise<Rect> => {
  const rect = (await hook(page)).rects[id];
  if (rect === null || rect === undefined) throw new Error(`no rect for ${id}`);
  return rect;
};

test("the focus cone dims outsiders on the GPU canvas", async () => {
  test.setTimeout(300_000);
  const junto: JuntoHandle = await launchJunto({ seedModels: { [CANVAS]: fixture } });
  try {
    const { page } = junto;
    const adapter = await page.evaluate(async () => (navigator.gpu === undefined ? false : (await navigator.gpu.requestAdapter()) !== null));
    test.skip(!adapter, "this host has no WebGPU adapter, so the GPU canvas cannot run");
    // The operator's own path: the experimental switch turns the GPU canvas on
    // live, in the open window (gpu-pointer-pixels.spec.ts's proven order).
    await page.waitForFunction(() => Boolean(window.junto?.settingsPatch), undefined, { timeout: 30_000 });
    await page.evaluate(() => window.junto!.settingsPatch({ advanced: { experimental: { gpuCanvas: true } } }));
    await expect.poll(() => page.evaluate(() => typeof window.__juntoCanvas?.ready === "function"), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__juntoCanvas!.ready()), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__juntoCanvas!.cardIds().length), { timeout: 30_000 }).toBe(4);
    // One ground for the luminance math: the sandbox can inherit the
    // operator's appearance.
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset["theme"] ?? "dark"), { timeout: 10_000 }).toBe("dark");
    await cameraSettled(page, { timeout: 20_000 });
    await page.waitForTimeout(400);

    const before = await shot(page, "01-before-focus");
    const rects = {
      a: await rectOf(page, SEAT_A),
      b: await rectOf(page, SEAT_B),
      n1: await rectOf(page, NOTE_1),
      n2: await rectOf(page, NOTE_2),
    };

    // 1. Click the seat's drawn centre: the real pointer selects it and the
    // DOM selection toolbar appears over the card.
    await page.mouse.click(centre(rects.a).x, centre(rects.a).y);
    await expect.poll(async () => (await hook(page)).selected, { timeout: 5_000 }).toEqual([SEAT_A]);
    const selectedShot = await shot(page, "02-selected");

    // 2. The toolbar's Focus node button is the operator's connection-focus
    // gesture; it writes state$.connectionFocusNodeId, the feed cones it.
    const focusButton = page.getByTestId("node-toolbar-focus");
    await expect(focusButton).toBeVisible({ timeout: 5_000 });
    await focusButton.click();
    // The selection op is synchronous through applyScene; frames keep coming.
    await page.waitForTimeout(500);
    await cameraSettled(page, { timeout: 10_000 });

    const after = await shot(page, "03-focus-cone");
    const hookDump = await hook(page);
    await writeFileSync(join(OUT, "hook.json"), JSON.stringify({ rects, camera: hookDump.camera, selected: hookDump.selected, stats: hookDump.stats }, null, 2));

    // 3. Pixels decide: outsiders dropped toward the cone's 0.22 treatment,
    // members and the root kept their brightness.
    const lum = (image: PngImage, rect: Rect) => luminance(image, rect);
    for (const [name, rect] of [["note-1", rects.n1], ["note-2", rects.n2]] as const) {
      const was = lum(selectedShot, rect);
      const now = lum(after, rect);
      expect(now, `${name} dims under the cone (${was.toFixed(1)} -> ${now.toFixed(1)})`).toBeLessThan(was * 0.72);
    }
    for (const [name, rect] of [["root", rects.a], ["member", rects.b]] as const) {
      const was = lum(selectedShot, rect);
      const now = lum(after, rect);
      expect(now, `${name} stays lit inside the cone (${was.toFixed(1)} -> ${now.toFixed(1)})`).toBeGreaterThan(was * 0.8);
    }
    // And the dimming is new: the pre-focus frame did not already look like it.
    expect(lum(before, rects.n1), "the outsider was bright before any focus").toBeGreaterThan(lum(after, rects.n1) * 1.25);
  } finally {
    await junto.close();
  }
});
