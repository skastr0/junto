/**
 * The 480px WebGPU magnifier proof: at zoom 0.15 with Alt held, the lens
 * draws the real scene — cards, portraits, turning rings, status lines,
 * wires — at 0.70x near tier, and clicks through it resolve the card the
 * lens shows, even where the main canvas gathers seats into clusters.
 *
 *   bun run test:e2e:fast e2e/scenarios/zz-magnifier-lens.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { launchJunto } from "../harness/launch";
import { galleryFixture } from "../harness/gallery-fixture";
import { modelWire } from "../harness/model";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { card, canvasReady, pane, selectedIds } from "../harness/canvas";

const CANVAS = "factory";
const STILL = "gal-agent-a";
const RUNNER = "gal-agent-b";
const VISUAL_DIR = "/tmp/magnifier-lens";

// The gallery canvas plus one mail wire between the two seats, so the lens
// has a real wire to draw in loupe mode. The shared fixture stays untouched:
// look-gallery's pixel pairs must not move.
const lensFixture = {
  ...galleryFixture,
  wires: [modelWire("gal-wire-ab", STILL, RUNNER, "messages", galleryFixture.nodes)],
};

interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  readonly PNG: { readonly sync: { read(buf: Buffer): PngImage; write(img: PngImage): Buffer } };
};

const LENS = 480;
const LENS_RADIUS = LENS / 2;

/** Pixels inside the lens circle only — the square clip's corners are the canvas beneath. */
const inLens = (img: PngImage, x: number, y: number): boolean => {
  const dx = x - img.width / 2;
  const dy = y - img.height / 2;
  return dx * dx + dy * dy <= (LENS_RADIUS - 6) * (LENS_RADIUS - 6);
};

const rgbAt = (img: PngImage, x: number, y: number): readonly [number, number, number] => {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
};

const dist = (a: readonly [number, number, number], b: readonly [number, number, number]): number =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

/**
 * What a real scene leaves behind: many distinct colours (portraits, antialiased
 * text, the ring, the wire), and a healthy lit fraction over the ground. The
 * retired wireframe boxes drew a handful of colours on flat field.
 */
const richness = (img: PngImage): { readonly distinct: number; readonly lit: number; readonly total: number } => {
  const counts = new Map<number, number>();
  let dominant = 0;
  let dominantCount = 0;
  let lit = 0;
  let total = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      if (!inLens(img, x, y)) continue;
      total += 1;
      const [r, g, b] = rgbAt(img, x, y);
      const key = (r << 16) | (g << 8) | b;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count > dominantCount) {
        dominantCount = count;
        dominant = key;
      }
    }
  }
  const ground: readonly [number, number, number] = [(dominant >> 16) & 255, (dominant >> 8) & 255, dominant & 255];
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      if (!inLens(img, x, y)) continue;
      if (dist(rgbAt(img, x, y), ground) > 48) lit += 1;
    }
  }
  return { distinct: counts.size, lit, total };
};

/** Pixels that changed between two lens frames — the turning ring's proof. */
const moved = (a: PngImage, b: PngImage): number => {
  let bad = 0;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      if (!inLens(a, x, y)) continue;
      const ai = (y * a.width + x) * 4;
      const bi = (y * b.width + x) * 4;
      if (dist([a.data[ai]!, a.data[ai + 1]!, a.data[ai + 2]!], [b.data[bi]!, b.data[bi + 1]!, b.data[bi + 2]!]) > 60) bad += 1;
    }
  }
  return bad;
};

const lensShot = async (page: Page, cx: number, cy: number, name: string): Promise<PngImage> => {
  const clip = {
    x: Math.round(cx - LENS_RADIUS),
    y: Math.round(cy - LENS_RADIUS),
    width: LENS,
    height: LENS,
  };
  const buffer = await page.screenshot({ clip });
  await writeFile(join(VISUAL_DIR, name), buffer);
  return PNG.sync.read(buffer);
};

const centreOf = async (page: Page, id: string): Promise<{ x: number; y: number }> => {
  const rect = await card(page, id).box();
  if (rect === null) throw new Error(`card ${id} has no rect`);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
};

test("the 480px GPU lens draws the real scene at 0.70x and picks through it", async () => {
  test.setTimeout(300_000);
  await mkdir(VISUAL_DIR, { recursive: true });
  const junto = await launchJunto({
    seedModels: { [CANVAS]: lensFixture },
    afterSeed: installCrewSeatHarness,
    seedExperimentalFeatures: ["gpuCanvas" as const],
  });
  try {
    const { page } = junto;
    await canvasReady(page);
    await page.waitForFunction(() => typeof window.__juntoCanvas?.ready === "function", undefined, { timeout: 30_000 });
    await canvasReady(page);
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await crewPlayFactory(page);
    const runner = crewSeat(junto.sandbox, CANVAS, RUNNER);
    await crewOccupySeat(page, CANVAS, { id: RUNNER }, runner);
    await runner.ready();
    await runner.control({ screen: { mode: "working" } });
    await page.waitForTimeout(3_000);

    // Zoom 0.15: the whole board, where seats gather into far-tier clusters.
    const box = await pane(page).box();
    if (box === null) throw new Error("no canvas pane");
    // gal-agent-b's board centre is (-30, -352): seat cards are 240x96 at
    // (-150, -400). Centre the camera on it so both seats sit in view.
    const camera = { x: box.width / 2 + 4.5, y: box.height / 2 + 52.8, zoom: 0.15 };
    await page.evaluate((to) => window.__juntoCanvas?.moveCamera?.(to), camera);
    await expect
      .poll(() => page.evaluate(() => window.__juntoCanvas?.camera().zoom ?? 0), { timeout: 10_000 })
      .toBeCloseTo(0.15, 2);
    await page.waitForTimeout(800);

    const runnerAt = await centreOf(page, RUNNER);
    const stillAt = await centreOf(page, STILL);

    // Alt over the runner seat: the lens opens centred on the cursor.
    await page.mouse.move(runnerAt.x, runnerAt.y);
    await page.keyboard.down("Alt");
    await page.waitForTimeout(900);
    const magnifier = page.getByTestId("canvas-magnifier");
    await expect(magnifier).toHaveAttribute("data-active", "true");
    await expect(magnifier).toHaveAttribute("data-gpu", "true");
    await expect(magnifier.locator(".canvas-magnifier__mode")).toContainText("0.7");
    // Portraits, text and sprites rasterize into the shared atlas off the
    // frame path; wait for the cells to land before reading pixels.
    await expect
      .poll(() => page.evaluate(() => window.__juntoCanvas?.atlasPending?.() ?? 0), { timeout: 15_000 })
      .toBe(0);
    await page.waitForTimeout(300);

    const first = await lensShot(page, runnerAt.x, runnerAt.y, "lens-runner-a.png");
    await page.waitForTimeout(900);
    const second = await lensShot(page, runnerAt.x, runnerAt.y, "lens-runner-b.png");

    const rich = richness(first);
    console.log(`LENS richness: distinct=${rich.distinct} lit=${((rich.lit / rich.total) * 100).toFixed(1)}%`);
    expect(rich.distinct, "the lens shows a handful of flat colours — the wireframe, not the scene").toBeGreaterThan(80);
    expect(rich.lit / rich.total, "the lens is mostly empty field").toBeGreaterThan(0.02);

    // The ring turns inside the lens: the scene's own ring angle moves, and
    // the pixels under it move with it.
    const angleA = await page.evaluate((id) => window.__juntoCanvas?.ringAngle?.(id) ?? -1, RUNNER);
    await page.waitForTimeout(700);
    const angleB = await page.evaluate((id) => window.__juntoCanvas?.ringAngle?.(id) ?? -1, RUNNER);
    expect(angleB, "the runner's ring angle never moved").not.toBe(angleA);
    const movedPixels = moved(first, second);
    console.log(`LENS motion: moved=${movedPixels}px ringAngle ${angleA.toFixed(2)} -> ${angleB.toFixed(2)}`);
    expect(movedPixels, "two lens frames are identical — nothing turns inside").toBeGreaterThan(10);

    // Click through the lens: the still seat selects even though the main
    // canvas at 0.15x shows it gathered, not as a card.
    await page.mouse.click(stillAt.x, stillAt.y);
    await expect
      .poll(() => selectedIds(page), { timeout: 10_000 })
      .toContain(STILL);

    // Shift+Alt toggles a second seat into the selection.
    await page.keyboard.down("Shift");
    await page.mouse.click(runnerAt.x, runnerAt.y);
    await page.keyboard.up("Shift");
    await expect
      .poll(async () => [...(await selectedIds(page))].sort(), { timeout: 10_000 })
      .toEqual([RUNNER, STILL].sort());

    // Double-click through the lens opens the seat's terminal surface, and
    // the magnifier stands down for it.
    await page.mouse.dblclick(runnerAt.x, runnerAt.y);
    await expect(page.getByTestId("native-terminal-surface")).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => magnifier.getAttribute("data-active"), { timeout: 10_000 })
      .toBe("false");

    await page.keyboard.up("Alt");
    await page.screenshot({ path: join(VISUAL_DIR, "after-terminal.png") });
  } finally {
    await junto.close();
  }
});
