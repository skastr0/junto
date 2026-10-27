/**
 * Visual tour of the frames the lead-check spec does not take: a table opened to its source, the @ picker,
 * a sheet, a pad before and after a pan. Dark and bright, into test-results/artifacts-tour/<theme>/.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { mentionHref } from "../../src/shared/mention";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelSeat } from "../harness/model";

const CANVAS = "tour";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifacts-tour";
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x: 60, y: 60, width: 280, height: 160, z: 0 });
const lead = modelSeat({ id: "lead", key: "local:tour-lead", label: "lead", x: 400, y: 60 });
const MARKDOWN = [
  "# Junto monetization",
  "",
  "| Layer | Price | Why |",
  "|---|---|---|",
  "| Junto | free, Apache-2.0 | Never paywalled. |",
  "| Junto Plus | $29 one-time | Patronage and `delight`. |",
  "",
  "One entitlement covers **the desktop app** and the phone.",
].join("\n");

const shot = async (page: Page, theme: string, name: string): Promise<void> => {
  mkdirSync(join(SHOTS, theme), { recursive: true });
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
};

test("artifacts tour: table source, @ picker, sheet, pad and pan, bright and dark", async () => {
  test.setTimeout(300_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([shelf, lead], []) } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    const make = async (title: string, markdown: string): Promise<string> => {
      const artifactId = mintItemId();
      await page.evaluate(
        ({ canvas, node, artifactId, opId, title, markdown }) =>
          window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title, body: { type: "document", markdown } }),
        { canvas: CANVAS, node: asNodeId("shelf"), artifactId, opId: mintOpId(), title, markdown },
      );
      return artifactId;
    };
    const pricing = await make("Pricing pages", "Superset Pro is $16 to $20 a user per month.");
    const embed = `![Pricing pages](${mentionHref({ kind: "artifact", nodeId: asNodeId("shelf"), artifactId: pricing as never }, CANVAS)})`;
    await make("Junto monetization plan", `${MARKDOWN}\n\n${embed}\n`);
    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    const list = page.getByRole("list", { name: "Artifacts" });
    await expect(list).toBeVisible({ timeout: 20_000 });
    const meta = page.locator(".artifact-head__meta");
    for (const noun of ["Sheet", "Pad"]) {
      await page.getByRole("button", { name: "New artifact" }).click();
      await page.getByRole("group", { name: "New artifact" }).locator("button").filter({ hasText: noun }).click();
      await expect(meta).toHaveText(`${noun}, version 1`, { timeout: 15_000 });
    }
    // Extras for product-documents' list: Tab between cells, a picked seat chip, Cmd+B, Escape and Enter, archived.
    const extras: Record<string, unknown> = {};
    await list.locator("button").filter({ hasText: "Junto monetization plan" }).first().click();
    await expect(page.locator(".cm-md-table table")).toBeVisible({ timeout: 15_000 });
    const source = page.getByLabel("Markdown");
    await expect(async () => {
      await page.locator(".cm-md-table td").filter({ hasText: "Junto" }).first().click();
      await expect(page.locator(".cm-md-table")).toHaveCount(0, { timeout: 1_500 });
    }).toPass({ timeout: 15_000 });
    await page.keyboard.press("Tab");
    await page.keyboard.type("ZZ");
    extras.tabStepsCells = (await source.innerText()).split("\n").find((l) => l.includes("ZZ")) ?? null;
    expect(extras.tabStepsCells).toMatch(/\| Junto \| [^|]*ZZ[^|]*\|/);
    await page.locator(".cm-md-h1").click();
    await source.click();
    await page.keyboard.press("Meta+ArrowDown");
    await page.keyboard.type("\n\nBold me");
    for (let i = 0; i < 7; i += 1) await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Meta+B");
    extras.cmdB = (await source.innerText()).includes("**Bold me**") || (await source.innerText()).includes("**Bold m");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.type("\n\n@lea");
    await page.waitForTimeout(500);
    await page.getByTestId("mention-option").first().click();
    await page.locator(".cm-md-h1").click();
    extras.mentionChips = await page.locator(".cm-md-mention").count();
    expect(extras.mentionChips).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    extras.afterEscape = await page.evaluate(() => `${document.activeElement?.className ?? ""}`.slice(0, 60));
    await page.keyboard.press("Enter");
    extras.afterEnter = await page.evaluate(() => `${document.activeElement?.className ?? ""}`.slice(0, 60));
    extras.escapeThenEnter = { afterEscape: extras.afterEscape, afterEnter: extras.afterEnter };
    await page.getByRole("button", { name: "Archive" }).click();
    await page.waitForTimeout(800);
    extras.archived = { contenteditable: await source.getAttribute("contenteditable"), cursors: await page.locator(".cm-cursor").count() };
    console.log("EXTRAS", JSON.stringify(extras));
    await page.getByRole("button", { name: "Restore" }).click();
    for (const theme of ["bright", "dark"] as const) {
      await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(theme === "bright" ? "bright" : null);

      // Document: the table opened to its source, then the @ picker.
      await list.locator("button").filter({ hasText: "Junto monetization plan" }).first().click();
      await expect(meta).toHaveText(/Document, version/, { timeout: 15_000 });
      await expect(page.locator(".cm-md-table table")).toBeVisible();
      await page.waitForTimeout(800);
      await shot(page, theme, "1-document-rendered-with-card");
      await expect(async () => {
        await page.locator(".cm-md-table td").filter({ hasText: "$29 one-time" }).first().click();
        await expect(page.locator(".cm-md-table")).toHaveCount(0, { timeout: 1_500 });
      }).toPass({ timeout: 15_000 });
      await shot(page, theme, "2-table-open-to-source");
      await page.locator(".cm-md-h1").click();
      const source = page.getByLabel("Markdown");
      await source.click();
      await page.keyboard.press("Meta+ArrowDown");
      await page.keyboard.type("\n\n@");
      await page.waitForTimeout(600);
      await shot(page, theme, "3-at-picker");
      await page.keyboard.press("Escape");

      // Sheet.
      await list.locator("button").filter({ hasText: "Untitled sheet" }).first().click();
      await expect(meta).toHaveText(/Sheet, version/, { timeout: 15_000 });
      const grid = page.locator(".junto-artifact-sheet__grid");
      await expect(grid).toBeVisible();
      await grid.getByRole("gridcell").first().click();
      for (const text of ["Seat", "Region"]) {
        await page.keyboard.press("Enter");
        await page.keyboard.type(text);
        await page.keyboard.press("Enter");
        await page.keyboard.press("ArrowRight");
      }
      await shot(page, theme, "4-sheet");

      // Pad: draw, then pan.
      await list.locator("button").filter({ hasText: "Untitled pad" }).first().click();
      await expect(meta).toHaveText(/Pad, version/, { timeout: 15_000 });
      const svg = page.getByTestId("pad-svg");
      await expect(svg).toBeVisible();
      const box = (await svg.boundingBox())!;
      await page.getByTestId("pad-tool-box").click();
      for (const [dx, dy] of [[80, 80], [300, 120]] as const) {
        await page.mouse.move(box.x + dx, box.y + dy);
        await page.mouse.down();
        await page.mouse.move(box.x + dx + 140, box.y + dy + 80, { steps: 6 });
        await page.mouse.up();
      }
      await page.getByTestId("pad-tool-ink").click();
      await page.mouse.move(box.x + 120, box.y + 300);
      await page.mouse.down();
      for (let i = 1; i <= 30; i += 1) await page.mouse.move(box.x + 120 + i * 9, box.y + 300 + Math.sin(i / 3) * 24);
      await page.mouse.up();
      await page.getByTestId("pad-tool-select").click();
      await page.waitForTimeout(600);
      await shot(page, theme, "5-pad-drawn");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 12; i += 1) await page.mouse.wheel(-14, -9);
      await page.waitForTimeout(500);
      await shot(page, theme, "6-pad-panned");
    }
  } finally {
    await junto.close();
  }
});
