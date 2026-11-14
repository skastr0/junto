/**
 * Shell polish QA on the GPU canvas: the canvas takes focus without a blue
 * ring, a double click is a double click on PointerEvent (where `detail` is
 * always 0), a multi-selection opens as a grid from both the context menu and
 * the RTS bar, and dragging an unselected seat mounts no card toolbar until
 * the drop.
 *
 * Run: `bun run test:e2e:fast e2e/scenarios/canvas-shell-polish.spec.ts`
 */
import type { Page, TestInfo } from "@playwright/test";
import { cameraSettled, card, canvasReady, pane } from "../harness/canvas";
import { expect, test } from "../harness/launch";
import { commandModel, modelFixture, modelSeat, readModelCanvas } from "../harness/model";

const CANVAS = "shell-polish";

const seats = [
  modelSeat({ id: "alpha", key: "local:shell-polish-alpha", label: "Alpha", x: -420, y: -40 }),
  modelSeat({ id: "bravo", key: "local:shell-polish-bravo", label: "Bravo", x: 40, y: -40 }),
];
const fixture = modelFixture(seats);

test.use({
  juntoOptions: {
    seedModels: { [CANVAS]: fixture },
    seedExperimentalFeatures: ["gpuCanvas"],
  },
});

const TOOLBAR = "[data-canvas-overlay='selection-toolbar']";
const GRID = "[data-testid='terminal-grid-focus']";

const shot = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  await page.screenshot({ path: testInfo.outputPath(name) });
};

/** A point on the pane no card covers: 20 to 80 percent, away from the cards. */
const emptyPoint = async (page: Page): Promise<{ readonly x: number; readonly y: number }> => {
  const box = await pane(page).box();
  if (box === null) throw new Error("the canvas pane has no box");
  const rects = await page.evaluate(() => {
    const hook = window.__juntoCanvas;
    if (hook === undefined) return [];
    return hook.cardIds().flatMap((id) => {
      const rect = hook.rectOf(id);
      return rect === undefined ? [] : [rect];
    });
  });
  for (const fy of [0.2, 0.35, 0.5, 0.65]) {
    for (const fx of [0.15, 0.3, 0.5, 0.7, 0.85]) {
      const at = { x: box.x + box.width * fx, y: box.y + box.height * fy };
      const clear = rects.every(
        (rect) =>
          at.x < rect.x - 24 ||
          at.x > rect.x + rect.width + 24 ||
          at.y < rect.y - 24 ||
          at.y > rect.y + rect.height + 24,
      );
      if (clear) return at;
    }
  }
  throw new Error("every pane point is covered by a card");
};

test("shell polish: no focus ring, real double clicks, grid from both surfaces, no toolbar on the first drag pixel", async ({ junto }, testInfo) => {
  const { page } = junto;
  await canvasReady(page, { timeout: 30_000 });
  await card(page, "alpha").visible({ timeout: 30_000 });
  await card(page, "bravo").visible({ timeout: 30_000 });

  // 1. The canvas takes the keyboard without Chromium's blue focus ring.
  const canvas = page.locator("[data-testid='gpu-canvas']");
  const blank = await emptyPoint(page);
  await page.mouse.click(blank.x, blank.y);
  await expect.poll(async () =>
    canvas.evaluate((element) => document.activeElement === element),
  ).toBe(true);
  const outline = await canvas.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, color: style.outlineColor };
  });
  // A none outline draws no ring whatever width and colour it would carry.
  expect(outline.style).toBe("none");
  await shot(page, testInfo, "01-canvas-focus-no-ring.png");

  // 2. A double click on the pane adds a note: the pointer event's computed
  //    click count reached the engine as 2.
  const before = await readModelCanvas(page, CANVAS);
  await page.mouse.dblclick(blank.x, blank.y);
  await expect.poll(async () => (await readModelCanvas(page, CANVAS)).nodes.length, {
    timeout: 10_000,
  }).toBe(before.nodes.length + 1);
  await shot(page, testInfo, "02-pane-double-click-note.png");
  // The proof is the note; take it off the field so it cannot cover the drag.
  const added = (await readModelCanvas(page, CANVAS)).nodes.find(
    (node) => !before.nodes.some((held) => held.id === node.id),
  );
  if (added === undefined) throw new Error("the double click added no note");
  await commandModel(page, { _tag: "Remove", canvas: CANVAS, nodes: [added.id], wires: [] });
  // A new note takes the camera; bring the field back to both seats.
  await page.getByRole("button", { name: "Fit all nodes" }).click();
  await cameraSettled(page);

  // 3. Dragging an unselected seat mounts no selection toolbar while the
  //    pointer is down; the toolbar appears on the drop.
  const cleared = await emptyPoint(page);
  await page.mouse.click(cleared.x, cleared.y);
  await expect(page.locator(TOOLBAR)).toHaveCount(0);
  const alpha = await card(page, "alpha").box();
  if (alpha === null) throw new Error("alpha has no box");
  const from = { x: alpha.x + alpha.width / 2, y: alpha.y + alpha.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 24, from.y + 8, { steps: 1 });
  // The canvas was told the grabbed card at once (it is drawn selected in the
  // screenshot below); the row the React chrome reads waits for the drop.
  const selectedDuringDrag = await page.evaluate(() => window.__juntoCanvas?.selection() ?? []);
  expect(selectedDuringDrag).not.toContain("alpha");
  await expect(page.locator(TOOLBAR)).toHaveCount(0);
  await shot(page, testInfo, "03-first-drag-pixel-no-toolbar.png");
  await page.mouse.move(from.x + 84, from.y + 8, { steps: 3 });
  await expect(page.locator(TOOLBAR)).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator(TOOLBAR)).toHaveCount(1);
  await expect.poll(async () => page.evaluate(() => window.__juntoCanvas?.selection() ?? [])).toContain("alpha");
  await shot(page, testInfo, "04-drop-mounts-toolbar.png");

  // 4a. With two agents selected the RTS bar opens them as a grid, one click.
  await card(page, "alpha").click();
  // Shift adds to the selection (the canvas's multi-select modifier).
  await card(page, "bravo").click({ modifiers: ["Shift"] });
  await expect.poll(async () => page.evaluate(() => window.__juntoCanvas?.selection())).toHaveLength(2);
  const barGrid = page.getByTestId("rts-open-grid");
  await expect(barGrid).toBeVisible();
  await expect(barGrid).toHaveAttribute("aria-label", "Open selected agents in a grid");
  await barGrid.click();
  const grid = page.locator(GRID);
  await expect(grid).toBeVisible();
  await expect(page.getByTestId("terminal-grid-count")).toHaveText("2 agents");
  await shot(page, testInfo, "05-grid-from-rts-bar.png");
  await page.getByRole("button", { name: "Close grid" }).click();
  await expect(grid).toHaveCount(0);

  // 4b. The same from the selection context menu's open row.
  await card(page, "bravo").rightClick();
  const menu = page.getByRole("toolbar", { name: "Actions for 2 nodes" });
  await expect(menu).toBeVisible();
  const row = menu.getByRole("button", { name: "Open the selected agents in a grid" });
  await expect(row).toBeVisible();
  await shot(page, testInfo, "06-selection-menu-open-row.png");
  await row.click();
  await expect(grid).toBeVisible();
  await expect(page.getByTestId("terminal-grid-count")).toHaveText("2 agents");
  await shot(page, testInfo, "07-grid-from-selection-menu.png");
  await page.getByRole("button", { name: "Close grid" }).click();
  await expect(grid).toHaveCount(0);

  // 2b. A double click on the seat opens its terminal.
  await card(page, "alpha").dblclick();
  await expect(page.locator(".native-terminal-surface")).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, "08-seat-double-click-opens-terminal.png");
  await page.getByRole("button", { name: "Close view" }).click();
  await expect(page.locator(".native-terminal-surface")).toHaveCount(0);
});
