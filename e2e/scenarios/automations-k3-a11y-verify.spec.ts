/**
 * Real app, plan 0.11 05, K3's accessibility fixes (ff38478a8, 3fd4809f7),
 * the walk product-lead asked for, dark and bright.
 *
 * The automation is saved first, so the question is the code's own.
 * (1) With unsaved code, Escape twice and a backdrop click ask before the
 * Automations pane closes, and the code is still there after the cancel.
 * (2) Revert asks before dropping typed code. (3) Back does not ask once the
 * code is saved. (4) Insert value on a mail reads "Insert value into the mail".
 * Each check is reported on its own.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/automations-k3-a11y-verify.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode } from "../harness/model";

const CANVAS = "automations-k3-a11y";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/automations-k3-a11y-verify";
const KEEP = /^(Keep|Cancel)$/u;

const shoot = async (page: Page, name: string): Promise<void> => {
  for (const theme of ["dark", "bright"] as const) {
    mkdirSync(join(SHOTS, theme), { recursive: true });
    await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  }
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
};

type Result = { row: string; pass: boolean; detail?: string };

test("automations K3: unsaved code asks before Escape, backdrop and Revert drop it, saved code does not, Insert value names its words", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [CANVAS]: modelFixture([modelNode({ kind: "automations", id: "auto", label: "Automations", x: 40, y: 40, width: 260, height: 120, z: 0 })]) },
  });
  const results: Result[] = [];
  const check = async (row: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      results.push({ row, pass: true });
    } catch (error) {
      results.push({ row, pass: false, detail: String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 4).join(" ") });
    }
  };
  try {
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    const card = page.locator('.react-flow__node[data-id="auto"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.dblclick();
    const pane = page.getByTestId("automations-node");
    await expect(pane).toBeVisible({ timeout: 20_000 });
    const editor = pane.getByTestId("automation-editor");
    const dialog = page.getByRole("alertdialog", { name: "Discard this code?" }).or(page.getByRole("dialog", { name: "Discard this code?" }));

    await pane.getByRole("button", { name: "New automation" }).first().click();
    await editor.getByLabel("Automation name").fill("Nightly check");

    // (4) Insert value on the default mail action.
    await check("Insert value reads Insert value into the mail", () =>
      expect(editor.getByRole("button", { name: "Insert value into the mail", exact: true })).toBeVisible({ timeout: 5_000 }),
    );

    await editor.getByRole("button", { name: "Action 1", exact: true }).click();
    await page.getByRole("option", { name: "Run code" }).click();
    await editor.getByRole("button", { name: "Write code" }).click();
    const code = pane.getByTestId("automation-code");
    const surface = code.getByRole("textbox");
    await expect(surface).toContainText("import { input, cont }", { timeout: 15_000 });
    const typeCode = async (marker: string): Promise<void> => {
      await surface.click();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type(`import { cont } from "junto/automation";\ncont({ ${marker}: "yes" });\n`);
      await expect(surface).toContainText(marker);
    };
    await typeCode("typed");

    // (3) Save, then Back does not ask.
    await code.getByRole("button", { name: "Save", exact: true }).click();
    await expect(pane.getByRole("button", { name: /Nightly check/u }).first()).toBeVisible({ timeout: 10_000 });
    await expect(pane.getByRole("button", { name: /Nightly check, not saved/u })).toHaveCount(0, { timeout: 10_000 });
    await check("Back does not ask once the code is saved", async () => {
      await code.getByRole("button", { name: "Back", exact: true }).click();
      await page.waitForTimeout(400);
      await expect(page.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
      await expect(editor.getByRole("button", { name: "Edit code" })).toBeVisible({ timeout: 5_000 });
    });
    await shoot(page, "1-back-after-save");

    // Unsaved code in a saved automation.
    await editor.getByRole("button", { name: "Edit code" }).click();
    await expect(surface).toContainText("typed", { timeout: 10_000 });
    await typeCode("unsaved");

    // (1a) Escape twice asks; Cancel leaves the code.
    await check("Escape twice with unsaved code asks Discard this code? before closing", async () => {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      if ((await dialog.count()) === 0) await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(pane).toBeVisible();
    });
    await shoot(page, "2-escape-asks");
    await check("after Cancel on Escape the code is still there", async () => {
      await dialog.getByRole("button", { name: KEEP }).click();
      await expect(dialog).toHaveCount(0);
      await expect(pane).toBeVisible();
      await expect(surface).toContainText("unsaved");
    });

    // (1b) A backdrop click asks; Cancel leaves the code.
    await check("backdrop click with unsaved code asks before closing", async () => {
      await page.mouse.click(6, 450);
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(pane).toBeVisible();
    });
    await shoot(page, "3-backdrop-asks");
    await check("after Cancel on the backdrop the code is still there", async () => {
      await dialog.getByRole("button", { name: KEEP }).click();
      await expect(dialog).toHaveCount(0);
      await expect(surface).toContainText("unsaved");
    });

    // (2) Revert asks before dropping typed code, and Discard puts the saved program back.
    await check("Revert asks before dropping typed code", async () => {
      await code.getByRole("button", { name: "Revert", exact: true }).click();
      await expect(dialog).toBeVisible({ timeout: 5_000 });
    });
    await shoot(page, "4-revert-asks");
    await check("Cancel on Revert keeps the typed code", async () => {
      await dialog.getByRole("button", { name: KEEP }).click();
      await expect(surface).toContainText("unsaved");
    });
    await check("Discard on Revert puts the saved program back", async () => {
      await code.getByRole("button", { name: "Revert", exact: true }).click();
      await dialog.getByRole("button", { name: "Discard", exact: true }).click();
      await expect(surface).toContainText("typed", { timeout: 5_000 });
      await expect(surface).not.toContainText("unsaved");
    });
    await shoot(page, "5-reverted");
  } finally {
    console.log("K3", JSON.stringify(results));
    await junto.close();
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});
