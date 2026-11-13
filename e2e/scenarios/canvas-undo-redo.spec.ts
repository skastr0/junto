/**
 * Undo and redo, several deep, across edits of different kinds.
 *
 * The operator drags a note, deletes another, and drags a third; then takes
 * all three back with the undo key and puts all three on again with redo.
 * Every step is read from what main stores, not from what the window draws:
 * an edit is a command, and so is taking it back.
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/canvas-undo-redo.spec.ts`
 */
import type { Page } from "@playwright/test";
import { card, cameraSettled, canvasReady, pane } from "../harness/canvas";
import { expect, test } from "../harness/launch";
import { commandModel, modelFixture, modelNote, readModelNode } from "../harness/model";
import { mod } from "../harness/keys";

const fixture = modelFixture([
  modelNote("first", "first note", 40, 40),
  modelNote("second", "second note", 340, 40),
  modelNote("third", "third note", 640, 40),
]);

/** The canvas the app opened on, with the three notes put on it. */
const installBoard = async (page: Page): Promise<string> => {
  await page.waitForFunction(() => Boolean(window.junto?.modelCanvases), undefined, { timeout: 30_000 });
  const names = await page.evaluate(() => window.junto!.modelCanvases());
  const canvas = names[0]?.name ?? "undo";
  if (names.length === 0) await commandModel(page, { _tag: "CreateCanvas", canvas });
  await commandModel(page, { _tag: "Add", canvas, nodes: fixture.nodes, wires: fixture.wires });
  return canvas;
};

/** Drag a card straight down by its middle. */
const dragDown = async (page: Page, id: string, by: number): Promise<void> => {
  const box = await card(page, id).box();
  expect(box).toBeTruthy();
  if (!box) return;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + by, { steps: 12 });
  await page.mouse.up();
};

/** Where main has a note, or `gone` when it has none by that id. */
const stored = async (page: Page, canvas: string, id: string): Promise<{ x: number; y: number } | "gone"> => {
  const node = await readModelNode(page, canvas, id);
  return node === undefined ? "gone" : { x: node.x, y: node.y };
};

const undoKey = mod("z");
const redoKey = mod("Shift+z");

test("undo and redo: three deep across a drag, a delete and a drag", async ({ junto }) => {
  const { page } = junto;
  await canvasReady(page, { timeout: 30_000 });
  const canvas = await installBoard(page);
  for (const id of ["first", "second", "third"]) await card(page, id).visible({ timeout: 30_000 });
  await cameraSettled(page);

  const firstHome = { x: 40, y: 40 };
  const thirdHome = { x: 640, y: 40 };
  expect(await stored(page, canvas, "first")).toEqual(firstHome);
  expect(await stored(page, canvas, "third")).toEqual(thirdHome);

  // One: drag the first note down.
  await dragDown(page, "first", 160);
  await expect.poll(async () => {
    const at = await stored(page, canvas, "first");
    return at === "gone" ? -1 : at.y;
  }).toBeGreaterThan(firstHome.y + 40);
  const firstMoved = await stored(page, canvas, "first");

  // Two: select the second note and delete it. Deleting asks first, through
  // the window's confirm; the operator says yes.
  await page.evaluate(() => {
    window.confirm = () => true;
  });
  await card(page, "second").click();
  await expect.poll(() => card(page, "second").selected()).toBe(true);
  await page.keyboard.press("Backspace");
  await expect.poll(() => stored(page, canvas, "second")).toBe("gone");
  await expect.poll(() => card(page, "second").count()).toBe(0);

  // Three: drag the third note down.
  await dragDown(page, "third", 160);
  await expect.poll(async () => {
    const at = await stored(page, canvas, "third");
    return at === "gone" ? -1 : at.y;
  }).toBeGreaterThan(thirdHome.y + 40);
  const thirdMoved = await stored(page, canvas, "third");

  // The keys act on the canvas, not on a card that holds focus.
  await pane(page).click({ position: { x: 8, y: 8 } });

  // Back, newest first. Each undo reaches main, and only its own edit.
  await page.keyboard.press(undoKey);
  await expect.poll(() => stored(page, canvas, "third")).toEqual(thirdHome);
  expect(await stored(page, canvas, "second")).toBe("gone");

  await page.keyboard.press(undoKey);
  await expect.poll(() => stored(page, canvas, "second")).toEqual({ x: 340, y: 40 });
  await card(page, "second").visible();
  await expect.poll(() => card(page, "second").text()).toContain("second note");
  expect(await stored(page, canvas, "first")).toEqual(firstMoved);

  await page.keyboard.press(undoKey);
  await expect.poll(() => stored(page, canvas, "first")).toEqual(firstHome);

  // Nothing is left to take back: another undo changes nothing.
  await page.keyboard.press(undoKey);
  await page.waitForTimeout(300);
  expect(await stored(page, canvas, "first")).toEqual(firstHome);
  expect(await stored(page, canvas, "second")).toEqual({ x: 340, y: 40 });
  expect(await stored(page, canvas, "third")).toEqual(thirdHome);

  // Forward again, oldest first.
  await page.keyboard.press(redoKey);
  await expect.poll(() => stored(page, canvas, "first")).toEqual(firstMoved);

  await page.keyboard.press(redoKey);
  await expect.poll(() => stored(page, canvas, "second")).toBe("gone");
  await expect.poll(() => card(page, "second").count()).toBe(0);

  await page.keyboard.press(redoKey);
  await expect.poll(() => stored(page, canvas, "third")).toEqual(thirdMoved);

  // A new edit after an undo forgets what could have been redone.
  await page.keyboard.press(undoKey);
  await expect.poll(() => stored(page, canvas, "third")).toEqual(thirdHome);
  await dragDown(page, "first", -80);
  await expect.poll(async () => {
    const at = await stored(page, canvas, "first");
    return at !== "gone" && firstMoved !== "gone" && at.y < firstMoved.y - 20;
  }).toBe(true);
  await pane(page).click({ position: { x: 8, y: 8 } });
  await page.keyboard.press(redoKey);
  await page.waitForTimeout(300);
  expect(await stored(page, canvas, "third")).toEqual(thirdHome);
});
