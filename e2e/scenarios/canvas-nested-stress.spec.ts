/**
 * Nested-region stress board boots at the operator's display.
 *
 * Smoke for the fixture every level-of-detail and raster check builds on: the
 * `nested` preset (44 regions, four levels, about 250 members) seeded through
 * `launchJunto({ nestedCanvas })`, in a 1726x1083 window at device-pixel-ratio
 * 2. Asserts the board mounts whole and leaves one screenshot at fit and one at
 * minZoom for eyes.
 *
 * Run: bun run test:e2e:fast e2e/scenarios/canvas-nested-stress.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { expect, test } from "../harness/launch";
import { buildNestedCanvasFixture, OPERATOR_DISPLAY } from "../harness/nested-canvas-fixture";
import { zoomOutToTarget } from "../harness/pan-flicker-evidence";

const fixture = buildNestedCanvasFixture("nested");
const SHOTS = "test-results/nested-stress";

test.use({
  juntoOptions: {
    nestedCanvas: { fixture },
    ...OPERATOR_DISPLAY,
  },
});

test("the nested stress board mounts whole at the operator's display", async ({ junto }) => {
  test.setTimeout(180_000);
  const { page } = junto;
  await mkdir(SHOTS, { recursive: true });

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".react-flow__node")).toHaveCount(fixture.doc.nodes.length, { timeout: 60_000 });
  await expect(page.locator(".react-flow__node-group")).toHaveCount(fixture.stats.regions);
  await expect(page.locator(".react-flow__edge")).toHaveCount(fixture.stats.edges, { timeout: 30_000 });

  const display = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));
  expect(display).toEqual({ ...OPERATOR_DISPLAY.windowContentSize, dpr: 2 });

  await page.waitForTimeout(1_000);
  await page.screenshot({ path: `${SHOTS}/nested-fit.png` });
  const scale = await zoomOutToTarget(page, 0.15);
  expect(scale).toBeLessThanOrEqual(0.155);
  await page.screenshot({ path: `${SHOTS}/nested-min-zoom.png` });
});
