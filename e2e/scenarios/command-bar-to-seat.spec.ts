/**
 * The command bar takes the operator to a seat.
 *
 * On the canvas, the modifier plus K opens search; typing part of a seat's
 * name and pressing the modifier plus Enter closes search and opens that
 * seat's view, and no other seat's.
 *   scripts/run-e2e.sh e2e/scenarios/command-bar-to-seat.spec.ts
 */
import { expect, launchJunto, test } from "../harness/launch";
import { mod } from "../harness/keys";
import { modelFixture, modelSeat } from "../harness/model";

const ada = modelSeat({ id: "ada", label: "Ada", x: 40, y: 40 });
const bea = modelSeat({ id: "bea", label: "Bea", x: 440, y: 40 });

test("search finds a seat by name and opens its view", async () => {
  const junto = await launchJunto({ seedModels: { "command-bar-to-seat": modelFixture([ada, bea]) } });
  try {
    const { page } = junto;
    await expect(page.getByText("Bea", { exact: true })).toBeVisible({ timeout: 30_000 });

    // The window may still be settling its keyboard when the canvas first paints: press until search answers.
    const search = page.getByRole("combobox", { name: "Search nodes" });
    await expect(async () => {
      await page.keyboard.press(mod("K"));
      await expect(search).toBeFocused({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    await search.fill("be");
    await expect(page.getByRole("option", { name: /Bea/, selected: true })).toBeVisible();
    await page.keyboard.press(mod("Enter"));

    await expect(search).toBeHidden();
    const view = page.getByRole("dialog").filter({ hasText: "Bea" });
    await expect(view).toBeVisible({ timeout: 20_000 });
    await expect(view).not.toContainText("Ada");
  } finally {
    await junto.close();
  }
});
