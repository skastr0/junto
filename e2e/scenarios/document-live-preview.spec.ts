/**
 * The document editor is one live-rendered surface: rendered until a line is
 * clicked, that line shows its markdown and takes typing, and the typing saves.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const CANVAS = "live-doc";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/document-live-preview";
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x: 60, y: 60, width: 280, height: 160, z: 0 });

const MARKDOWN = [
  "# Junto monetization",
  "",
  "## The model",
  "",
  "| Layer | Price | Why |",
  "|---|---|---|",
  "| Junto | free, Apache-2.0 | Never paywalled. |",
  "| Junto Plus | $29 one-time | Patronage and `delight`. |",
  "",
  "One entitlement covers **the desktop app** and the phone, see [pricing](https://example.com/pricing).",
  "",
  "- Free alone fails.",
  "- [ ] Check the pricing pages",
  "",
  "> Plan on it covering nothing.",
  "",
  "```ts",
  "const plus = 29;",
  "```",
].join("\n");

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

test("click a line to edit its markdown in place, move off and it renders, typing saves", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([shelf], []) } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    await page.evaluate(
      ({ canvas, node, artifactId, opId, markdown }) =>
        window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title: "Live doc", body: { type: "document", markdown } }),
      { canvas: CANVAS, node: asNodeId("shelf"), artifactId: mintItemId(), opId: mintOpId(), markdown: MARKDOWN },
    );
    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: "Live doc" }).first().click();
    await expect(page.locator(".artifact-head__meta")).toHaveText("Document, version 1", { timeout: 15_000 });

    const source = page.getByLabel("Markdown");
    // No tabs: one surface, rendered.
    await expect(page.getByRole("button", { name: "Split" })).toHaveCount(0);
    await expect(page.locator(".cm-md-table table")).toBeVisible();
    await expect(source).not.toContainText("**the desktop app**");
    await expect(source).not.toContainText("# Junto");
    await shot(page, "1-rendered");

    // Click the paragraph: that line shows its markdown, the heading stays rendered.
    const box = await page.locator(".cm-md-strong").boundingBox();
    console.log("STRONG BOX", JSON.stringify(box));
    await page.locator(".cm-md-strong").click();
    console.log("AFTER CLICK", await page.evaluate(() => {
      const sel = document.getSelection();
      return JSON.stringify({ active: document.activeElement?.className, node: sel?.anchorNode?.textContent?.slice(0, 60), offset: sel?.anchorOffset });
    }));
    await expect(source).toContainText("**the desktop app**");
    await expect(source).toContainText("[pricing](https://example.com/pricing)");
    await expect(source).not.toContainText("# Junto");
    await shot(page, "2-line-open");

    // Type in place, then move off: the line renders again and the typing saves.
    await page.keyboard.press("End");
    await page.keyboard.type(" Edited live.");
    await page.locator(".cm-md-h1").click();
    await expect(source).not.toContainText("**the desktop app**");
    await expect(source).toContainText("Edited live.");
    await expect(page.locator(".artifact-head__meta")).toHaveText(/Document, version [2-9]/, { timeout: 15_000 });

    // A press on a table cell opens the table's source with the caret in that cell.
    await page.locator(".cm-md-table td").filter({ hasText: "$29 one-time" }).click();
    await expect(page.locator(".cm-md-table")).toHaveCount(0);
    await expect(source).toContainText("| Junto Plus | $29 one-time |");
    await page.keyboard.type("only ");
    await expect(source).toContainText("| Junto Plus | only $29 one-time |");
    await shot(page, "3-table-open");
    await page.locator(".cm-md-h1").click();
    await expect(page.locator(".cm-md-table td").filter({ hasText: "only $29 one-time" })).toBeVisible();
    await shot(page, "4-rendered-again");
  } finally {
    await junto.close();
  }
});
