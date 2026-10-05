/**
 * The delete key asks before it deletes. Refusing the confirm leaves the card
 * on the canvas; accepting removes it.
 */
import { canvasDoc, textNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

test.use({
  juntoOptions: {
    seedCanvases: {
      "delete-cancel": canvasDoc([textNode("note", "A note to keep", 0, 0)]),
    },
  },
});

test("refusing the delete confirm keeps the note; accepting removes it", async ({ junto }) => {
  const { page } = junto;
  const note = page.getByTestId("rf__node-note");
  await expect(note).toBeVisible({ timeout: 30_000 });

  // Electron's native confirm is not drivable from here: answer it in page.
  const answerWith = (accept: boolean): Promise<void> =>
    page.evaluate((answer) => {
      const host = window as unknown as { __asked?: string[] };
      host.__asked ??= [];
      window.confirm = (message?: string) => {
        host.__asked?.push(message ?? "");
        return answer;
      };
    }, accept);
  const asked = (): Promise<string[]> =>
    page.evaluate(() => (window as unknown as { __asked?: string[] }).__asked ?? []);
  await answerWith(false);

  // The locator click waits for the opening fit to settle under the note.
  await note.click({ position: { x: 6, y: 6 } });
  await expect(note).toHaveClass(/selected/);

  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await asked()).length).toBe(1);
  expect((await asked())[0]).toContain("Delete this node?");
  await page.waitForTimeout(1_500);
  await expect(note).toBeVisible();

  await answerWith(true);
  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await asked()).length).toBe(2);
  await expect(note).toHaveCount(0);
});
