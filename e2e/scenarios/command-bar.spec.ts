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
  juntoOptions: {
    seedCanvases: { probe: probeCanvas },
  },
});

test("command bar opens from the trigger and cmd+K, filters the list only, and commits a focus", async ({ junto }) => {
  const { page } = junto;
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


test("actions mode catalogs commands, Enter runs them, Tab toggles modes", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

  // Select a node first: copy-node-reference only appears with a selection,
  // and the palette must not clear it on open.
  await page.locator('.react-flow__node[data-id="n-beta"]').click();
  await expect(page.locator(".rts-shell")).toBeVisible();

  // ">" switches to the actions catalog.
  await page.keyboard.press("Meta+k");
  const input = page.getByTestId("command-bar-input");
  await expect(input).toBeVisible();
  await input.fill(">");
  const actionRows = page.locator(".command-bar__row--action");
  const list = page.locator(".command-bar__list");
  await expect(actionRows.first()).toBeVisible();
  await expect(list).toContainText("Open settings");
  await expect(list).toContainText("Fit view");
  await expect(list).toContainText("Clear selection");

  // Filtering narrows the action list.
  await input.fill(">fit");
  await expect(actionRows).toHaveCount(1);
  await expect(list).toContainText("Fit view");

  // Enter runs and closes the palette.
  await page.keyboard.press("Enter");
  await expect(input).toHaveCount(0);

  // Selection survived the palette open: copy-node-reference is reachable.
  await page.keyboard.press("Meta+k");
  await expect(input).toBeVisible();
  await input.fill(">copy");
  await expect(actionRows).toHaveCount(1);
  await expect(list).toContainText("Copy node reference");
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);

  // Tab toggles into actions and back to nodes.
  await page.keyboard.press("Meta+k");
  await expect(input).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(actionRows.first()).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator(".command-bar__row-title").first()).toHaveText("Alpha release");
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
});
