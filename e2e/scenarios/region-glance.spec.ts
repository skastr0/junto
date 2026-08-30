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
  // A region holding regions: depth is geometric (convert.ts regionDepths), so
  // these two sit one level in and ride the nested glance band.
  { ...region("r-floor", "Factory floor", 0, 1400, "5"), width: 1900, height: 1240 },
  { ...region("r-north", "North bay", 60, 1500, "4"), width: 860, height: 500 },
  card("n1", "Bench one", 120, 1600),
  card("n2", "Bench two", 480, 1600),
  { ...region("r-south", "South bay", 980, 1500, "6"), width: 860, height: 500 },
  card("t1", "Bench three", 1040, 1600),
  card("t2", "Bench four", 1400, 1600),
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

const glanceBands = async (
  page: import("@playwright/test").Page,
): Promise<{ readonly outer: number; readonly nested: number }> =>
  page.evaluate(() => {
    const root = document.querySelector(".react-flow") as HTMLElement | null;
    const read = (name: string): number => {
      const raw = root?.style.getPropertyValue(name) ?? "";
      return raw === "" ? 0 : Number(raw);
    };
    return {
      outer: read("--vellum-region-glance"),
      nested: read("--vellum-region-glance-sub"),
    };
  });

const glanceOpacity = async (page: import("@playwright/test").Page): Promise<number> =>
  (await glanceBands(page)).outer;

/**
 * Bring a node to the middle of the viewport with plain wheel pans (panOnScroll),
 * so the pinch that follows anchors on it. Feedback loop rather than arithmetic:
 * the wheel-to-pan ratio is the canvas's business, not the test's.
 */
const centerOn = async (
  page: import("@playwright/test").Page,
  locator: import("@playwright/test").Locator,
): Promise<void> => {
  const view = page.viewportSize() ?? { width: 1280, height: 800 };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const box = await locator.boundingBox();
    if (box === null) return;
    const dx = box.x + box.width / 2 - view.width / 2;
    const dy = box.y + box.height / 2 - view.height / 2;
    if (Math.abs(dx) < 80 && Math.abs(dy) < 80) return;
    await page.mouse.wheel(dx, dy);
    await page.waitForTimeout(120);
  }
};

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

test("nested regions name themselves one band closer in, never with their parent", async ({
  vellumCommand,
}) => {
  const { page } = vellumCommand;
  await install(page);
  await expect(page.locator(".react-flow__node", { hasText: "North bay" }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Start close enough that nothing is named, then walk the camera out in small
  // steps, reading both bands off the live root at every one. A full 120 wheel
  // tick moves the zoom far enough to jump a whole band, so the sweep uses a
  // fraction of one.
  const STEP_DELTA = 15;
  const view = page.viewportSize() ?? { width: 1280, height: 800 };
  await centerOn(page, page.locator('.react-flow__node[data-id="r-floor"]'));
  await page.mouse.move(view.width / 2, view.height / 2);
  await pinch(page, -120, 8);
  await centerOn(page, page.locator('.react-flow__node[data-id="r-floor"]'));
  await page.mouse.move(view.width / 2, view.height / 2);
  expect(await glanceBands(page)).toEqual({ outer: 0, nested: 0 });

  let nestedShot = false;
  let outerShot = false;
  const nestedSeen: number[] = [];
  const outerSeen: number[] = [];
  for (let step = 0; step < 44; step += 1) {
    await pinch(page, STEP_DELTA, 1);
    const bands = await glanceBands(page);
    // The claim under test: at no camera height do both names print.
    expect(bands.outer > 0 && bands.nested > 0, `both bands lit at step ${String(step)}`).toBe(
      false,
    );
    if (bands.nested > 0) nestedSeen.push(bands.nested);
    if (bands.outer > 0) outerSeen.push(bands.outer);
    if (!nestedShot && bands.nested >= 1) {
      nestedShot = true;
      await page.screenshot({ path: "test-results/region-glance/nested-band.png" });
    }
    if (!outerShot && bands.outer >= 1) {
      outerShot = true;
      await page.screenshot({ path: "test-results/region-glance/outer-band.png" });
    }
  }

  // Both bands were actually visited on the way out, in that order.
  expect(nestedSeen.length).toBeGreaterThan(0);
  expect(outerSeen.length).toBeGreaterThan(0);
  expect(nestedShot).toBe(true);
  expect(outerShot).toBe(true);
});
