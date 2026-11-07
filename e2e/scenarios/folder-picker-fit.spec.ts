/**
 * The starting-folder picker in Add item fits its popover.
 *   bun run test:e2e:fast e2e/scenarios/folder-picker-fit.spec.ts
 *
 * The picker opens on a folder whose path is longer than the field, on any
 * platform's temp dir. With the picker open:
 *   - the popover stays inside the Add item frame
 *   - nothing scrolls sideways, and every control is inside the popover
 *   - both path lines clip from the left, so the folder's own name is readable
 *
 * The frame lands in test-results/folder-picker-fit/.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { modelFixture } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "folder-picker-fit");

/** Longer than the field on any temp dir: Linux /tmp homes are short. */
const LONG = ["client-engagements", "northwind-platform-rebuild", "services-and-workers"];

const inside = async (control: Locator, frame: Locator): Promise<void> => {
  const [box, bounds] = [await control.boundingBox(), await frame.boundingBox()];
  expect(box).not.toBeNull();
  expect(bounds).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
  expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
};

test("the folder picker shows every control and the end of a long path", async () => {
  let longPath = "";
  const junto = await launchJunto({
    seedModels: { "folder-picker": modelFixture([]) },
    afterSeed: async (sandbox) => {
      longPath = join(sandbox.homeDir, ...LONG);
      await mkdir(longPath, { recursive: true });
    },
    // The add-item palette lists only installed harnesses.
    seedHarnessInstalls: ["claude"],
  });

  try {
    const { page } = junto;
    await mkdir(SHOTS, { recursive: true });
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));

    await page.getByRole("button", { name: "Add canvas item" }).click();
    const deck = page.getByRole("region", { name: "Add canvas item" });
    await deck.getByRole("button", { name: "Claude Code", exact: true }).hover();
    await page.getByRole("menu", { name: "Claude Code models" }).waitFor({ state: "visible" });
    await deck
      .getByRole("region", { name: "Launch context" })
      .getByRole("button", { name: "Choose starting folder" })
      .click();

    const folder = page.getByRole("dialog", { name: "Choose starting folder" });
    const field = folder.getByLabel("Agent working directory");
    await expect(field).toHaveValue(/^\//, { timeout: 10_000 });
    await field.fill(`${longPath}/`);
    await expect(folder.getByRole("listbox", { name: `Folders in ${longPath}` })).toBeAttached({ timeout: 10_000 });
    await page.waitForTimeout(350);

    await inside(folder, deck);

    // Nothing to reach by scrolling sideways.
    expect(await folder.evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(true);
    for (const name of ["Open parent directory", "Open directory", "use this folder", "Close folder picker"]) {
      await inside(folder.getByRole("button", { name, exact: true }), folder);
    }

    // The field is longer than it can show, and shows its end.
    const scroll = await field.evaluate((input: HTMLInputElement) => ({
      left: input.scrollLeft,
      most: input.scrollWidth - input.clientWidth,
    }));
    expect(scroll.most).toBeGreaterThan(0);
    expect(scroll.left).toBeGreaterThanOrEqual(scroll.most - 1);

    await page.screenshot({ path: join(SHOTS, "folder-picker-dark.png") });
  } finally {
    await junto.close();
  }
});
