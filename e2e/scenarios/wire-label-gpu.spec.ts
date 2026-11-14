/**
 * A wire on the GPU canvas is selected from its midpoint label, as it is on
 * today's canvas: the stroke is deaf at rest, so the invisible 14 px target at
 * the label point is the pointer and screen-reader way in. The shell carries
 * that target for the GPU canvas (shell/wire-labels.ts) and the edge card at
 * the bottom names the relation once it is selected.
 *
 * Real Electron input only: the click is a Playwright click on the label's
 * box, and the assertion is the operator-visible edge card. The screenshot in
 * the test's output directory is the visual proof that the selected wire and
 * its glow are drawn on the WebGPU canvas.
 */
import { expect, test } from "../harness/launch";
import { camera, canvasReady, card, pane } from "../harness/canvas";
import { modelFixture, modelSeat, modelWire } from "../harness/model";

const CANVAS = "wire-label";

const seats = [
  modelSeat({ id: "left", label: "Left seat", x: -360, y: -60 }),
  modelSeat({ id: "right", label: "Right seat", x: 320, y: -60 }),
];
const fixture = modelFixture(seats, [modelWire("left-right", "left", "right", "messages", seats)]);

test.use({
  juntoOptions: {
    seedModels: { [CANVAS]: fixture },
    seedExperimentalFeatures: ["gpuCanvas"],
  },
});

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

const rectOf = (page: import("@playwright/test").Page, id: string): Promise<Rect | null> =>
  page.evaluate((node) => {
    const hook = (window as unknown as { __juntoCanvas?: { rect: (id: string) => Rect | null } }).__juntoCanvas;
    return hook?.rect(node) ?? null;
  }, id);

test("a wire is selected from its midpoint label on the GPU canvas", async ({ junto }, testInfo) => {
  test.setTimeout(120_000);
  const { page } = junto;
  await canvasReady(page);
  const hooked = await page.evaluate(() => typeof (window as unknown as { __juntoCanvas?: { ready?: () => boolean } }).__juntoCanvas?.ready === "function");
  test.skip(!hooked, "window.__juntoCanvas absent — the GPU canvas is not in this build yet");
  await card(page, "left").visible();
  await card(page, "right").visible();
  await page.waitForTimeout(400);

  const left = await rectOf(page, "left");
  const right = await rectOf(page, "right");
  expect(left).not.toBeNull();
  expect(right).not.toBeNull();
  const midpoint = {
    x: (left!.x + left!.width + right!.x) / 2,
    y: left!.y + left!.height / 2,
  };

  // The invisible select target sits on the wire, as the DOM's midpoint
  // button does, and names the relation for a screen reader.
  const label = page.getByRole("button", { name: "Select edge - messages" });
  await expect(label).toHaveCount(1);
  const labelBox = await label.boundingBox();
  expect(labelBox).not.toBeNull();
  expect(Math.abs((labelBox!.x + labelBox!.width / 2) - midpoint.x)).toBeLessThan(6);
  expect(Math.abs((labelBox!.y + labelBox!.height / 2) - midpoint.y)).toBeLessThan(6);

  // Clicking it selects the wire: the edge card at the bottom names both
  // seats and the relation, and offers the delete command.
  await label.click();
  await expect(page.getByRole("button", { name: "Delete relation" })).toBeVisible();
  await expect(page.getByText("Left seat → Right seat")).toBeVisible();

  // The pixels: a real screenshot of the WebGPU canvas with the selected
  // wire and its glow. Kept in the test output for visual inspection.
  const box = await pane(page).box();
  expect(box).not.toBeNull();
  await page.screenshot({ path: testInfo.outputPath("selected-wire.png"), clip: box! });
  const cam = await camera(page);
  expect(cam.zoom).toBeGreaterThan(0);
});

test("holding Alt shows the wires and lets the pointer pick one", async ({ junto }, testInfo) => {
  test.setTimeout(120_000);
  const { page } = junto;
  await canvasReady(page);
  const hooked = await page.evaluate(() => typeof (window as unknown as { __juntoCanvas?: { ready?: () => boolean } }).__juntoCanvas?.ready === "function");
  test.skip(!hooked, "window.__juntoCanvas absent — the GPU canvas is not in this build yet");
  await card(page, "left").visible();
  await card(page, "right").visible();
  await page.waitForTimeout(400);

  const left = await rectOf(page, "left");
  const right = await rectOf(page, "right");
  expect(left).not.toBeNull();
  expect(right).not.toBeNull();
  // A point on the wire, well away from the midpoint label.
  const at = { x: left!.x + left!.width + 80, y: left!.y + left!.height / 2 };

  // Alt is the canvas's loupe: wires show at full strength and become
  // pickable (engine/wires viewOfMode("loupe")). Pick the stroke itself.
  await page.mouse.move(at.x, at.y + 60);
  await page.keyboard.down("Alt");
  await page.waitForTimeout(250);
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(250);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(400);
  await expect(page.getByRole("button", { name: "Delete relation" })).toBeVisible();
  await page.keyboard.up("Alt");
  await page.waitForTimeout(400);

  const box = await pane(page).box();
  expect(box).not.toBeNull();
  await page.screenshot({ path: testInfo.outputPath("loupe-picked-wire.png"), clip: box! });
});
