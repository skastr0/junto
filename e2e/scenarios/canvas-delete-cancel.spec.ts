/**
 * The delete key asks before it deletes. Refusing the confirm leaves the card
 * on the canvas; accepting removes it.
 */
import { card } from "../harness/canvas";
import { modelNote, modelFixture } from "../harness/model";
import { expect, test } from "../harness/launch";

test.use({
  juntoOptions: {
    seedModels: {
      "delete-cancel": modelFixture([modelNote("note", "A note to keep", 0, 0)]),
    },
  },
});

test("refusing the delete confirm keeps the note; accepting removes it", async ({ junto }) => {
  const { page } = junto;
  const note = card(page, "note");
  await note.visible({ timeout: 30_000 });

  // The delete asks in the app's own confirm dialog: Cancel keeps the note.
  const question = page.getByRole("alertdialog");

  // The locator click waits for the opening fit to settle under the note.
  await note.click({ position: { x: 6, y: 6 } });
  await expect.poll(() => note.selected()).toBe(true);

  await page.keyboard.press("Backspace");
  await expect(question).toBeVisible();
  await expect(question).toContainText(/^Delete /);
  await question.getByRole("button", { name: "Cancel" }).click();
  await expect(question).toHaveCount(0);
  await page.waitForTimeout(1_500);
  await note.visible();

  await page.keyboard.press("Backspace");
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: "Delete node" }).click();
  await expect.poll(() => note.count()).toBe(0);
});
