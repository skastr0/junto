/**
 * Dragging a group by one of its cards keeps the whole group selected.
 *
 * Select several cards, drag the group by one of them, release: every card is
 * still selected, the one under the hand included, in what is drawn (React
 * Flow's selected class) and in what is said (the card's label). Twice, since
 * the card used to drop out on one release and come back on the next.
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/drag-selection-keeps-selection.spec.ts`
 */
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../harness/launch";
import { commandModel, modelFixture, modelNote, readModelNode } from "../harness/model";

const IDS = ["one", "two", "three"] as const;
const fixture = modelFixture([
  modelNote("one", "first note", 40, 40),
  modelNote("two", "second note", 340, 40),
  modelNote("three", "third note", 640, 40),
]);

const installBoard = async (page: Page): Promise<string> => {
  await page.waitForFunction(() => Boolean(window.junto?.modelCanvases), undefined, { timeout: 30_000 });
  const names = await page.evaluate(() => window.junto!.modelCanvases());
  const canvas = names[0]?.name ?? "group";
  if (names.length === 0) await commandModel(page, { _tag: "CreateCanvas", canvas });
  await commandModel(page, { _tag: "Add", canvas, nodes: fixture.nodes, wires: fixture.wires });
  return canvas;
};

/** The camera has stopped: the viewport transform held for half a second. */
const cameraSettled = async (page: Page): Promise<void> => {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const viewport = document.querySelector(".react-flow__viewport");
        if (!viewport) {
          resolve(false);
          return;
        }
        let last = getComputedStyle(viewport).transform;
        let still = 0;
        const tick = (): void => {
          const now = getComputedStyle(viewport).transform;
          still = now === last ? still + 1 : 0;
          last = now;
          if (still >= 30) resolve(true);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    undefined,
    { timeout: 15_000 },
  );
};

const card = (page: Page, id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"]`);

/** Every card of the group shows selected and says selected. */
const expectAllSelected = async (page: Page): Promise<void> => {
  for (const id of IDS) {
    await expect(card(page, id)).toHaveClass(/selected/);
    await expect(card(page, id)).toHaveAttribute("aria-label", /, selected$/);
  }
};

/** Drag the group by one card and let go. */
const dragBy = async (page: Page, id: string, dx: number, dy: number): Promise<void> => {
  const box = await card(page, id).boundingBox();
  expect(box).toBeTruthy();
  if (!box) return;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
};

const storedY = async (page: Page, canvas: string, id: string): Promise<number> =>
  (await readModelNode(page, canvas, id))?.y ?? Number.NaN;

test("a group dragged by one of its cards stays selected, every card, twice", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  const canvas = await installBoard(page);
  for (const id of IDS) await expect(card(page, id)).toBeVisible({ timeout: 30_000 });
  await cameraSettled(page);

  // Select the first card, then add the others with a shift-press that
  // carries the modifier on the pointer event alone, with no key event before
  // it: the case where React Flow has not seen the key and the window tells it.
  await card(page, "one").click();
  for (const id of ["two", "three"]) {
    await card(page, id).dispatchEvent("pointerdown", { shiftKey: true, button: 0, bubbles: true, cancelable: true });
  }
  await expectAllSelected(page);

  // First drag, by the middle card.
  const before = await storedY(page, canvas, "two");
  await dragBy(page, "two", 0, 140);
  await expect.poll(() => storedY(page, canvas, "two")).toBeGreaterThan(before + 40);
  // The whole group moved, and the whole group is still selected.
  expect(await storedY(page, canvas, "one")).toBeGreaterThan(40 + 40);
  expect(await storedY(page, canvas, "three")).toBeGreaterThan(40 + 40);
  await page.waitForTimeout(300);
  await expectAllSelected(page);

  // Second drag, by the same card: the card under the hand stays in.
  const after = await storedY(page, canvas, "two");
  await dragBy(page, "two", 0, -100);
  await expect.poll(() => storedY(page, canvas, "two")).toBeLessThan(after - 30);
  await page.waitForTimeout(300);
  await expectAllSelected(page);
});
