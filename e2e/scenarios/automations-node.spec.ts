import { modelFixture, modelNode, modelSeat } from "../harness/model";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, launchJunto, test } from "../harness/launch";

/**
 * The Automations node in the real app (0.10 plan 07): create, edit, a stale
 * edit that loses to a second writer, toggle, run now, history, archive.
 * Frames in both themes land in test-results/automations-node/.
 *
 *   scripts/with-app-run-lock.sh scripts/run-e2e.sh e2e/scenarios/automations-node.spec.ts
 */

const SHOTS = join(process.cwd(), "test-results", "automations-node");
const CANVAS = "automations";
const NODE = "auto";

const fixture = modelFixture([
  modelSeat({ id: "lead", key: "local:auto-lead", label: "lead", x: 40, y: 40 }),
  modelNode({ kind: "automations", id: NODE, label: "Automations", x: 360, y: 40, width: 260, height: 120, z: 0 }),
]);

const shot = async (page: Page, name: string): Promise<void> => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

/** The same state in both themes; dark is where the run lives. */
const bothThemes = async (page: Page, name: string): Promise<void> => {
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
  await shot(page, `${name}-dark`);
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "bright" } }));
  await shot(page, `${name}-light`);
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
};

test("the Automations node: create, edit, stale edit, toggle, run now, history, archive", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture } });
  try {
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator(`.react-flow__node[data-id="${NODE}"]`)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /fit all/i }).click();
    await page.locator(`.react-flow__node[data-id="${NODE}"]`).dblclick();
    const pane = page.getByTestId("automations-node");
    await expect(pane).toBeVisible({ timeout: 20_000 });

    // Empty.
    await expect(pane.getByText("No automations yet")).toBeVisible();
    await bothThemes(page, "01-empty");

    // Create: the default draft is a weekday schedule that mails nobody yet.
    await pane.getByRole("button", { name: "New automation" }).first().click();
    const editor = pane.getByTestId("automation-editor");
    await expect(editor).toBeVisible();
    await editor.getByLabel("Automation name").fill("Morning standup");
    const mailTo = editor.getByLabel("Mail to");
    await mailTo.click();
    await mailTo.pressSequentially("@lead");
    await page.getByRole("option", { name: /lead/ }).first().click();
    await editor.getByLabel("Mail text").fill("Post your plan for today.");
    await bothThemes(page, "02-new-draft");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(pane.getByRole("button", { name: /Morning standup/ })).toBeVisible({ timeout: 10_000 });
    await expect(pane.getByRole("region", { name: "Firing history" })).toBeVisible();
    await bothThemes(page, "03-created");

    // Edit.
    await editor.getByLabel("Automation name").fill("Morning standup, weekdays");
    await expect(pane.getByRole("button", { name: /Morning standup, edited/ })).toBeVisible();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(pane.getByRole("button", { name: /^Morning standup, weekdays(?!, edited)/ })).toBeVisible({ timeout: 10_000 });
    await shot(page, "04-edited-dark");

    // A stale edit: a second writer saves first, then ours loses to it.
    await editor.getByLabel("Automation name").fill("Mine");
    const head = await page.evaluate(async (canvas) => {
      const api = window.junto!;
      const listed = await api.automationList(canvas, { nodeId: "auto" as never });
      return listed.automations[0]!;
    }, CANVAS);
    await page.evaluate(async ({ canvas, head }) => {
      const { name: _name, trigger, when, then, limits } = head;
      await window.junto!.automationApply(canvas, {
        nodeId: head.nodeId,
        automationId: head.automationId,
        op: { kind: "edit", baseVersion: head.version, definition: { name: "Theirs", trigger, ...(when ? { when } : {}), then, limits } },
      });
    }, { canvas: CANVAS, head });
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    const elsewhere = pane.getByRole("group", { name: "Saved elsewhere" });
    await expect(elsewhere).toBeVisible({ timeout: 10_000 });
    await bothThemes(page, "05-stale");
    await elsewhere.getByRole("button", { name: "Send mine over theirs" }).click();
    await expect(pane.getByRole("button", { name: /^Mine/ })).toBeVisible({ timeout: 10_000 });
    await expect(elsewhere).toHaveCount(0);

    // Toggle.
    await expect(editor.getByText("Off", { exact: true })).toBeVisible();
    await editor.getByRole("switch", { name: "Automation on" }).click();
    await expect(editor.getByText("On", { exact: true })).toBeVisible({ timeout: 10_000 });
    await bothThemes(page, "06-on");

    // Run now, and its history row.
    await pane.getByRole("button", { name: "Run now" }).click();
    await expect(pane.locator(".automation-history__row")).toHaveCount(1, { timeout: 15_000 });
    await bothThemes(page, "07-history");

    // Archive.
    await pane.getByRole("button", { name: "Archive", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: /Archive Mine/ });
    await expect(confirm).toBeVisible();
    await shot(page, "08-archive-confirm-dark");
    await confirm.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(pane.getByText("No automations yet")).toBeVisible({ timeout: 10_000 });
    await shot(page, "09-archived-dark");
  } finally {
    await junto.close();
  }
});
