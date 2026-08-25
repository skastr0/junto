import { canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

/**
 * cmd+K command bar contract.
 *
 * The palette filters a LIST and never thins the canvas graph. Enter commits
 * through the existing focus path (select + camera fit); Escape closes
 * without touching the canvas. This spec replaces the retired
 * canvas-filtering station search field behavior.
 */

const probeCanvas = canvasDoc([
  { id: "n-alpha", type: "text", x: 0, y: 0, width: 240, height: 90, text: "Alpha release\nsecond line detail" },
  { id: "n-beta", type: "text", x: 300, y: 0, width: 240, height: 90, text: "Beta task plan", ether: { flags: ["blocker"] } },
  { id: "n-region", type: "group", x: -200, y: -200, width: 900, height: 600, label: "Probe region" },
]);

test.use({
  vellumOptions: {
    seedCanvases: { probe: probeCanvas },
  },
});

test("command bar opens from the trigger and cmd+K, filters the list only, and commits a focus", async ({ vellumCommand }) => {
  const { page } = vellumCommand;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

  // Open from the top-bar trigger; the input owns focus.
  await page.locator(".station-command-trigger").click();
  const input = page.getByTestId("command-bar-input");
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();

  // Default list shows every node in document order.
  await expect(page.locator(".command-bar__row-title")).toHaveText([
    "Alpha release",
    "Beta task plan",
    "Probe region",
  ]);

  // Filtering narrows the LIST; the canvas graph never changes.
  const before = await page.locator(".react-flow__node").count();
  await input.fill("beta");
  await expect(page.locator(".command-bar__row-title")).toHaveText(["Beta task plan"]);
  expect(await page.locator(".react-flow__node").count()).toBe(before);

  // Enter commits: palette closes and the node is selected.
  await page.keyboard.press("Enter");
  await expect(input).toHaveCount(0);
  await expect(page.locator(".rts-shell")).toBeVisible({ timeout: 10_000 });

  // cmd+K reopens; Escape closes without committing.
  await page.keyboard.press("Meta+k");
  await expect(input).toBeVisible();
  await input.fill("alpha");
  await expect(page.locator(".command-bar__row-title")).toHaveText(["Alpha release"]);
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);

  // "/" is the second open chord, keeping the historical search habit.
  await page.keyboard.press("/");
  await expect(input).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
});
