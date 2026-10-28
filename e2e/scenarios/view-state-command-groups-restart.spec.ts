/**
 * 0.11 view state, V2, in the real app: the operator's command groups survive a
 * quit. Arrange a group on digit 1, a node on each of digits 2 to 9, and a
 * group past nine; quit Junto fully; relaunch on the same store; every digit
 * recalls what it held and the group past nine is still there. Shots in both
 * themes.
 *   scripts/with-app-run-lock.sh scripts/run-e2e.sh e2e/scenarios/view-state-command-groups-restart.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode } from "../harness/model";
import { createSandbox, destroySandbox } from "../harness/sandbox";

const CANVAS = "restart";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? join(process.cwd(), "test-results", "view-state-command-groups-restart");

const note = (id: string, text: string, x: number) =>
  modelNode({ id, kind: "note", z: 0, text, x, y: 40, width: 180, height: 80 });

const fixture = modelFixture(
  Array.from({ length: 10 }, (_, index) => note(`n${index + 1}`, `note ${index + 1}`, index * 200)),
);

const bar = (page: Page) => page.locator("header.station-bar").getByRole("toolbar", { name: "Command groups" });
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const slot = (page: Page, index: number) => bar(page).getByTestId(`hotbar-slot-${index}`);

const board = async (page: Page): Promise<void> => {
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await expect(node(page, "n1")).toBeVisible({ timeout: 30_000 });
};

/** Every digit and the group past nine, as the bar shows them. */
const expectArrangement = async (page: Page): Promise<void> => {
  await expect(slot(page, 1)).toHaveAttribute("data-tenure", "group");
  await expect(slot(page, 1).locator(".group-chip__face")).toHaveCount(2);
  for (let index = 2; index <= 9; index += 1) {
    await expect(slot(page, index)).toHaveAttribute("data-tenure", "fixed");
    await expect(slot(page, index)).toContainText(`note ${index + 1}`);
  }
  await expect(bar(page).getByTestId("command-group-extra-1")).toHaveAttribute("data-hotkey", "none");
  await expect(bar(page).getByTestId("command-group-extra-1")).toContainText("note 1 +1");
};

test("command groups survive a full quit and relaunch", async () => {
  test.setTimeout(300_000);
  const sandbox = await createSandbox();
  mkdirSync(SHOTS, { recursive: true });
  try {
    // --- arrange -----------------------------------------------------------
    const first = await launchJunto({
      sandbox,
      windowContentSize: { width: 1500, height: 900 },
      seedModels: { [CANVAS]: fixture },
    });
    try {
      const { page } = first;
      await board(page);
      await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
      const mod = process.platform === "darwin" ? "Meta" : "Control";

      // Digit 1: two notes as a group.
      await node(page, "n1").click();
      await node(page, "n2").click({ modifiers: ["Shift"] });
      await page.keyboard.press(`${mod}+Digit1`);
      await expect(slot(page, 1)).toHaveAttribute("data-tenure", "group");

      // Digits 2 to 9: one note each, note 3 to note 10.
      for (let index = 2; index <= 9; index += 1) {
        await page.keyboard.press("Escape");
        await node(page, `n${index + 1}`).click();
        await page.keyboard.press(`${mod}+Digit${index}`);
        await expect(slot(page, index)).toHaveAttribute("data-tenure", "fixed");
      }

      // All nine held: two notes go past nine, with no digit.
      await page.keyboard.press("Escape");
      await node(page, "n2").click();
      await node(page, "n1").click({ modifiers: ["Shift"] });
      await bar(page).getByRole("button", { name: "Save the selection as a new group" }).click();
      await expect(bar(page).getByTestId("command-group-extra-1")).toBeVisible();

      await expectArrangement(page);
      await page.waitForTimeout(400);
      await bar(page).screenshot({ path: join(SHOTS, "arranged-dark.png") });
    } finally {
      // A full quit, not a window close: the rows must be on disk before this returns.
      await first.close();
    }

    // --- relaunch ----------------------------------------------------------
    const second = await launchJunto({ sandbox, windowContentSize: { width: 1500, height: 900 } });
    try {
      const { page } = second;
      await board(page);
      // The arrangement is back before anything is touched.
      await expectArrangement(page);
      await page.waitForTimeout(400);
      await bar(page).screenshot({ path: join(SHOTS, "restarted-dark.png") });

      // Each digit recalls what it held: 1 the group, 2 to 9 their note.
      for (let index = 2; index <= 9; index += 1) {
        await page.keyboard.press("Escape");
        await page.keyboard.press(String(index));
        await expect(node(page, `n${index + 1}`)).toHaveClass(/selected/);
        await expect(node(page, "n1")).not.toHaveClass(/selected/);
      }
      await page.keyboard.press("Escape");
      await page.keyboard.press("1");
      await expect(node(page, "n1")).toHaveClass(/selected/);
      await expect(node(page, "n2")).toHaveClass(/selected/);

      await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "bright" } }));
      await page.waitForTimeout(400);
      await bar(page).screenshot({ path: join(SHOTS, "restarted-bright.png") });
    } finally {
      await second.close();
    }
  } finally {
    await destroySandbox(sandbox);
  }
});
