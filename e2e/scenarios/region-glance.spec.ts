/**
 * Region glance capture — the pulled-back camera must still name the regions.
 *
 * Installs a three-region canvas through the app-owned canvas API, then
 * screenshots the same board at readable zoom and at strategic zoom, asserting
 * the glance opacity the ReactFlow root publishes at each.
 *
 * Run: `bun run test:e2e:fast e2e/scenarios/region-glance.spec.ts` (after a build).
 */
import type { CanvasDoc, CanvasNode } from "../../src/shared/canvas";
import { canvasDoc, textNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const region = (
  id: string,
  label: string,
  x: number,
  y: number,
  color?: string,
): CanvasNode => ({
  id,
  type: "group",
  label,
  x,
  y,
  width: 900,
  height: 560,
  ...(color ? { color } : {}),
});

const card = (id: string, text: string, x: number, y: number): CanvasNode => ({
  ...textNode(id, text, x, y),
  width: 240,
  height: 120,
});

const fixtureDoc: CanvasDoc = canvasDoc([
  region("r-build", "Build floor", 0, 0, "4"),
  card("b1", "PTY parser\nsubagent counter", 60, 90),
  card("b2", "Fleet presents\nWebGL lease", 360, 90),
  card("b3", "Claim delivery\ncontract", 60, 300),
  card("b4", "Compact policy", 360, 300),
  region("r-review", "Review lane", 1000, 0, "6"),
  card("v1", "Design audit", 1060, 90),
  card("v2", "Product stupidity\naudit", 1360, 90),
  card("v3", "Verification\nreviewer", 1060, 300),
  region("r-ship", "Ship dock", 0, 660, "2"),
  card("s1", "Release notes", 60, 750),
  card("s2", "Notarize", 360, 750),
]);

const install = async (page: import("@playwright/test").Page): Promise<string> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const runtime = globalThis as unknown as {
            readonly vellumCommand?: { readonly listCanvases: () => Promise<unknown[]> };
          };
          return Boolean(runtime.vellumCommand?.listCanvases);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  return page.evaluate(async (document) => {
    const api = (
      globalThis as unknown as {
        readonly vellumCommand: {
          readonly listCanvases: () => Promise<ReadonlyArray<{ name: string }>>;
          readonly createCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly readCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly writeCanvas: (
            name: string,
            doc: unknown,
            expectedRevision?: string,
          ) => Promise<unknown>;
        };
      }
    ).vellumCommand;
    const list = await api.listCanvases();
    let name = list[0]?.name;
    if (!name) name = (await api.createCanvas("glance")).name;
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
    return name;
  }, fixtureDoc);
};

const glanceOpacity = async (page: import("@playwright/test").Page): Promise<number> =>
  page.evaluate(() => {
    const root = document.querySelector(".react-flow") as HTMLElement | null;
    const raw = root?.style.getPropertyValue("--vellum-region-glance") ?? "";
    return raw === "" ? 0 : Number(raw);
  });

/** panOnScroll is on, so plain wheel pans — zoom is ctrl+wheel (pinch). */
const pinch = async (
  page: import("@playwright/test").Page,
  deltaY: number,
  ticks: number,
): Promise<void> => {
  await page.keyboard.down("Control");
  for (let i = 0; i < ticks; i += 1) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(40);
  }
  await page.keyboard.up("Control");
  await page.waitForTimeout(500);
};

test("region names appear as the camera pulls back and vanish up close", async ({
  vellumCommand,
}) => {
  const { page } = vellumCommand;
  await install(page);
  await expect(page.locator(".react-flow__node", { hasText: "Build floor" }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Readable zoom: cards carry their own names, glance must stay dark.
  await page.mouse.move(700, 400);
  await pinch(page, -120, 8);
  await page.screenshot({ path: "test-results/region-glance/close.png" });
  expect(await glanceOpacity(page)).toBe(0);

  // Strategic zoom: pinch out over the board until the glance inks.
  await pinch(page, 120, 18);
  await page.screenshot({ path: "test-results/region-glance/far.png" });
  expect(await glanceOpacity(page)).toBeGreaterThan(0);

  // Back in: the watermark must clear again.
  await pinch(page, -120, 18);
  await page.screenshot({ path: "test-results/region-glance/back.png" });
  expect(await glanceOpacity(page)).toBe(0);
});
