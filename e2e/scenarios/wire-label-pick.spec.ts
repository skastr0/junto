/**
 * A wire's select button is a hit-test target for the engine's pick, not a
 * DOM element over the canvas (src/window/canvas/engine/pick.ts,
 * `PickWorld.labelAt`).
 *
 * The bug: the shell placed a 14 px transparent button at every visible wire
 * label with `pointer-events: auto`. A press on a seat's ring point that the
 * button covered went to the button, so the seat could not be selected, and a
 * press on the button itself selected nothing at all on the GPU canvas. The
 * button now takes no pointer; the engine answers the label point itself, in
 * every wire mode, after cards and clusters.
 *
 * The button lives at near only, as the old canvas's label does (it hides at
 * mid and below): past near the press goes at the label point, where the
 * button would be, and no button is mounted.
 *
 * Run: `bunx electron-vite build && scripts/run-e2e.sh e2e/scenarios/wire-label-pick.spec.ts`
 */
import type { Page } from "@playwright/test";
import { cameraSettled, canvasReady, pane } from "../harness/canvas";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNote, modelSeat, modelWire } from "../harness/model";

const seats = [
  modelSeat({ id: "a", key: "local:label-alpha", label: "Alpha", x: 0, y: 0 }),
  modelSeat({ id: "b", key: "local:label-bravo", label: "Bravo", x: 900, y: 0 }),
];
const fixture = modelFixture(seats, [modelWire("a-b", "a", "b", "messages", seats)]);

const selectedWire = (page: Page) => page.evaluate(() => window.__juntoCanvas?.selectedWire?.() ?? "");

const labelButton = (page: Page) => page.locator(".junto-edge-label").first();

/** Put the camera at a zoom with the wire's middle in the pane's centre. */
const placeCamera = async (page: Page, zoom: number): Promise<void> => {
  const box = (await pane(page).box())!;
  await page.evaluate(
    ({ at, zoom }) => window.__juntoCanvas?.moveCamera?.(at),
    {
      at: { x: Math.round(box.width / 2 - 450 * zoom), y: Math.round(box.height / 2 - 48 * zoom), zoom },
      zoom,
    },
  );
  await cameraSettled(page);
};

test("a wire label point selects its wire at every tier, by press or by keyboard", async ({ junto }) => {
  const { page } = junto;
  await canvasReady(page);
  await expect(labelButton(page)).toBeAttached({ timeout: 30_000 });

  for (const zoom of [1.0, 0.52, 0.3]) {
    await placeCamera(page, zoom);
    let box: { x: number; y: number; width: number; height: number };
    if (zoom >= 0.62) box = (await labelButton(page).boundingBox())!;
    else {
      // Past near there is no button; the label point sits at the pane's centre.
      await expect(page.locator(".junto-edge-label")).toHaveCount(0);
      const at = (await pane(page).box())!;
      box = { x: at.x + at.width / 2, y: at.y + at.height / 2, width: 0, height: 0 };
    }
    // Clear first, so the wire's selection is this press's.
    await page.mouse.click(5, 5);
    await page.waitForTimeout(150);
    expect(await selectedWire(page)).toBe("");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => selectedWire(page), { timeout: 5_000 }).toBe("a-b");
    // The engine's pick at the same point says the wire too, in the resting
    // mode this press ran in.
    const hit = await page.evaluate(
      ({ x, y }) => (window.__juntoCanvas as any)?.pick?.({ x, y }) ?? null,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(hit).toMatchObject({ wireId: "a-b" });
  }

  // A keyboard reaches the button and Enter selects the wire: the button
  // stays focusable even though it takes no pointer. It lives at near.
  await placeCamera(page, 1.0);
  await expect(labelButton(page)).toBeAttached({ timeout: 5_000 });
  await page.keyboard.press("Tab");
  let reached = false;
  for (let i = 0; i < 40; i += 1) {
    reached = await page.evaluate(() => document.activeElement?.classList.contains("junto-edge-label") ?? false);
    if (reached) break;
    await page.keyboard.press("Tab");
  }
  expect(reached).toBe(true);
  await page.mouse.click(5, 5);
  await page.waitForTimeout(150);
  expect(await selectedWire(page)).toBe("");
  await page.keyboard.press("Enter");
  await expect.poll(() => selectedWire(page), { timeout: 5_000 }).toBe("a-b");
});
