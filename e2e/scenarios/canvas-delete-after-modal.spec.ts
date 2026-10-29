/**
 * The canvas delete chord and what is in front of the canvas.
 *
 * A delete pressed inside a modal must not reach the card behind it. And the
 * chord must come back in one press when the modal closes: it does, because
 * the chord is never unbound, only refused. Unbinding it (the first fix, one
 * release ago) left React Flow's pressed-key set holding the keys of the
 * modal that opened, so the first Backspace after it closed matched nothing
 * and needed a second press (11, Q6 walk).
 */
import { expect, test } from "../harness/launch";
import { modelFixture, modelNote } from "../harness/model";

const CANVAS = "delete-after-modal";

test.use({
  juntoOptions: {
    seedModels: {
      [CANVAS]: modelFixture([
        modelNote("note-behind", "Behind the modal", 0, 0),
        modelNote("note-after", "After the modal", 320, 0),
        modelNote("note-control", "No modal", 640, 0),
      ]),
    },
  },
});

test("the delete chord stands down under a modal and comes back in one press", async ({ junto }) => {
  test.setTimeout(240_000);
  const { page } = junto;
  const note = (id: string) => page.getByTestId(`rf__node-${id}`);
  await expect(note("note-control")).toBeVisible({ timeout: 30_000 });
  // The delete asks first; this walk accepts.
  const asked: string[] = [];
  await page.evaluate(() => {
    const host = window as unknown as { __asked?: string[] };
    host.__asked = [];
    window.confirm = (message?: string) => {
      host.__asked?.push(message ?? "");
      return true;
    };
  });
  const confirmations = (): Promise<string[]> =>
    page.evaluate(() => (window as unknown as { __asked?: string[] }).__asked ?? []);
  const select = async (id: string): Promise<void> => {
    await note(id).click({ position: { x: 6, y: 6 } });
    await expect(note(id)).toHaveClass(/selected/, { timeout: 5_000 });
  };

  await page.locator(".react-flow__pane").click({ position: { x: 1200, y: 700 } });

  // No modal: one press deletes, as it always did.
  await select("note-control");
  await page.keyboard.press("Backspace");
  await expect(note("note-control")).toHaveCount(0, { timeout: 10_000 });

  // A modal in front: the card behind it is not the delete's.
  await select("note-behind");
  await page.keyboard.press("Meta+t");
  await expect(page.getByRole("dialog", { name: "Quick capture" })).toBeVisible({ timeout: 10_000 });
  await page.locator(".quick-capture__list-label").click();
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(800);
  await expect(note("note-behind")).toHaveCount(1);
  expect((await confirmations()).length).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Quick capture" })).toBeHidden({ timeout: 5_000 });

  // The modal closed: one press, not two.
  await select("note-after");
  await page.keyboard.press("Backspace");
  await expect(note("note-after")).toHaveCount(0, { timeout: 10_000 });
  expect((await confirmations()).length).toBe(2);
  await junto.close();
});
