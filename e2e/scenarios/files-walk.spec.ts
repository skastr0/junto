/**
 * 0.11 F6, F7 and F8 end to end in the real app, dark and bright: a box drawn
 * on page two of a PDF takes a comment that shows in the rail and on the page,
 * the same box extracts to the Artifacts node in reach, and the artifact's
 * source line opens the Files node back on page two with the thread there.
 *   bun run test:e2e:fast e2e/scenarios/files-walk.spec.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import type { Locator, Page } from "@playwright/test";
import { Node } from "../../src/shared/model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";
import { filesNode, openFilesModal, openInTree, stageFiles } from "../harness/files-scenario";

const CANVAS = "files-walk";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/files-walk";
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({
  kind: "artifacts",
  id: "shelf",
  label: "Shelf",
  x: 420,
  y: 60,
  width: 280,
  height: 160,
  z: 0,
});

const drag = async (page: Page, surface: Locator, from: [number, number], to: [number, number]): Promise<void> => {
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + (from[0] + to[0]) / 2, box.y + (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 4 });
  await page.mouse.up();
};

test("a box on a PDF page: comment on it, extract it, follow the link back to the page, dark and bright", async () => {
  test.setTimeout(300_000);
  const stage = await stageFiles();
  const junto = await launchJunto({
    windowContentSize: { width: 1600, height: 1000 },
    seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root), shelf]) },
  });
  const report: Record<string, unknown> = {};
  const shot = (theme: string, name: string) => junto.page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  try {
    const { page } = junto;
    for (const theme of ["dark", "bright"] as const) {
      const facts: Record<string, unknown> = {};
      report[theme] = facts;
      mkdirSync(join(SHOTS, theme), { recursive: true });
      await page.waitForFunction(() => window.junto !== undefined);
      await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(theme === "bright" ? "bright" : null);

      const modal = await openFilesModal(page);
      await openInTree(modal, stage.fixture.paths.pdf);
      const pdf = modal.getByTestId("pdf-viewer");
      const pages = pdf.getByTestId("pdf-page");
      await expect(pages).toHaveCount(2, { timeout: 30_000 });
      const field = pdf.getByTestId("pdf-page-input");
      await field.click();
      await field.fill("2");
      await field.press("Enter");
      const second = pages.nth(1);
      await expect(second.locator(".textLayer span", { hasText: stage.fixture.pdfPageText[1] })).toBeVisible({ timeout: 15_000 });

      // (1) a box on page two opens the composer on it; the comment posts there and shows in the rail.
      await pdf.getByTestId("file-view-box-tool").click();
      await drag(page, second, [60, 40], [360, 160]);
      await expect(modal.getByText(/area on page 2/iu).first()).toBeVisible({ timeout: 10_000 });
      await shot(theme, "1-box-composer");
      const text = `walk ${theme} on page two`;
      const composer = modal.getByRole("combobox", { name: "New comment" }).or(modal.getByRole("textbox", { name: "New comment" }));
      await composer.first().click();
      await page.keyboard.type(text);
      await modal.getByRole("button", { name: "Comment", exact: true }).click();
      const thread = modal.locator(".artifact-thread", { hasText: text });
      await expect(thread).toBeVisible({ timeout: 15_000 });
      facts.threadPlace = await thread.locator(".artifact-thread__anchor").innerText();
      expect(facts.threadPlace).toMatch(/page 2/iu);
      facts.boxMarkOnPage = await second.locator('[data-testid^="file-box-thread"], .file-box--thread').count();
      await shot(theme, "2-commented");

      // (2) the box again, extracted to Shelf.
      if ((await pdf.getByTestId("file-view-box-tool").getAttribute("aria-pressed")) !== "true") await pdf.getByTestId("file-view-box-tool").click();
      await drag(page, second, [60, 40], [360, 160]);
      await expect(pdf.getByTestId("file-box-extract")).toBeEnabled({ timeout: 10_000 });
      await pdf.getByTestId("file-box-extract").click();
      await expect(pdf.getByTestId("file-view-said")).toHaveText("Extracted to Shelf.", { timeout: 15_000 });
      await shot(theme, "3-extracted");

      // (3) in Shelf, the artifact names page two; its source opens the Files node on that page.
      // Escape steps out one layer at a time: the box tool first, then the modal.
      await expect(async () => {
        await page.keyboard.press("Escape");
        await expect(modal).toBeHidden({ timeout: 1_000 });
      }).toPass({ timeout: 10_000 });
      await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
      const list = page.getByRole("list", { name: "Artifacts" });
      await expect(list).toBeVisible({ timeout: 20_000 });
      await list.locator("button").filter({ hasText: "sample.pdf, page 2" }).first().click();
      const source = page.locator(".artifact-preview__source");
      await expect(source).toHaveText("From docs/sample.pdf, page 2", { timeout: 15_000 });
      await shot(theme, "4-artifact");
      await source.click();
      const back = page.getByRole("dialog", { name: "Files" });
      await expect(back).toBeVisible({ timeout: 15_000 });
      const backPdf = back.getByTestId("pdf-viewer");
      await expect(backPdf.getByTestId("pdf-page")).toHaveCount(2, { timeout: 30_000 });
      await expect(backPdf.getByTestId("pdf-page-input")).toHaveValue("2", { timeout: 15_000 });
      facts.backOnPage = await backPdf.getByTestId("pdf-page-input").inputValue();
      // The thread from (1) is in the rail on the way back.
      await expect(back.locator(".artifact-thread", { hasText: text })).toBeVisible({ timeout: 15_000 });
      await shot(theme, "5-back-on-page-two");
      await expect(async () => {
        await page.keyboard.press("Escape");
        await expect(back).toBeHidden({ timeout: 1_000 });
      }).toPass({ timeout: 10_000 });
    }
  } finally {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "report.json"), JSON.stringify(report, null, 2));
    await junto.close();
    await stage.cleanup();
  }
});
