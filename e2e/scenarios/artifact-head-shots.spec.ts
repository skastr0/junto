/**
 * Frames of the one-row artifact head (784b608b6, 1d6b85fdc, 46da4dd1b): no
 * task linked, two linked, the picker open over the document, in dark and
 * bright, and a narrow window. Frames land in test-results/artifact-head-shots/.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const CANVAS = "verify-head";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifact-head-shots";
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x: 60, y: 60, width: 280, height: 160, z: 0 });

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

test("artifact head: one row, tasks inline, picker over the document, dark and bright", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([shelf], []) } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    const artifactId = mintItemId();
    await page.evaluate(
      ({ canvas, node, artifactId, opId }) =>
        window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, {
          op: "create",
          title: "Junto monetization strategy",
          body: { type: "document", markdown: "# Junto monetization\n\nFree canvas, paid reach, Plus to support.\n\n## The model\n\nOne entitlement covers the desktop app and the phone." },
        }),
      { canvas: CANVAS, node: asNodeId("shelf"), artifactId, opId: mintOpId() },
    );
    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    const list = page.getByRole("list", { name: "Artifacts" });
    await expect(list).toBeVisible({ timeout: 20_000 });
    await list.locator("button").filter({ hasText: "Junto monetization" }).first().click();
    await expect(page.locator(".artifact-head__meta")).toContainText("version 1", { timeout: 15_000 });

    const head = await page.locator(".artifact-head").evaluate((el) => Math.round(el.getBoundingClientRect().height));
    expect(head).toBe(36);
    await shot(page, "1-dark-no-task");

    await page.getByRole("button", { name: "Name a task" }).click();
    await expect(page.getByRole("combobox", { name: "Find a task" })).toBeVisible();
    await shot(page, "2-dark-picker-open");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("combobox", { name: "Find a task" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Name a task" })).toBeFocused();

    await page.evaluate(
      ({ canvas, node, artifactId, opId, ids }) => window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "tasks", taskIds: ids }),
      { canvas: CANVAS, node: asNodeId("shelf"), artifactId, opId: mintOpId(), ids: [mintItemId(), mintItemId()] },
    );
    await shot(page, "3-dark-task-linked");

    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "bright" } }));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
    await shot(page, "4-bright-task-linked");
    await page.getByRole("button", { name: "Name a task" }).click();
    await shot(page, "5-bright-picker-open");
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 900, height: 700 });
    await shot(page, "6-bright-narrow");
  } finally {
    await junto.close();
  }
});
