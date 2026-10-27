/**
 * 0.11 F6 and F8 in the real app, on a Files node rooted on the fixture, dark
 * and bright: the PDF opens from the tree in pdf.js (bundled worker, bytes on
 * junto-file:), its text selects, zoom and the page field move it; the image
 * fits; any other file offers its default app and Finder. A box drawn on a
 * page and one on the image become file artifacts in the Artifacts node in
 * reach, each naming its source, the PDF one rendered at twice the page.
 *   bun run test:e2e:fast e2e/scenarios/files-preview.spec.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import type { Locator, Page } from "@playwright/test";
import { Node } from "../../src/shared/model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";
import { filesNode, openFilesModal, openInTree, stageFiles } from "../harness/files-scenario";

const CANVAS = "files-preview";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/files-preview";
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

test("PDF and image preview and Extract as artifact, dark and bright", async () => {
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

      // (1) the PDF from the tree: pdf.js draws both pages and page one's text layer.
      const modal = await openFilesModal(page);
      await openInTree(modal, stage.fixture.paths.pdf);
      const pdf = modal.getByTestId("pdf-viewer");
      const pages = pdf.getByTestId("pdf-page");
      await expect(pages).toHaveCount(2, { timeout: 30_000 });
      const first = pages.nth(0);
      const title = first.locator(".textLayer span", { hasText: stage.fixture.pdfPageText[0] });
      await expect(title).toBeVisible({ timeout: 15_000 });
      facts.inkPixels = await first.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
        const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
        let ink = 0;
        for (let at = 0; at < data.length; at += 4) if (data[at]! < 128) ink += 1;
        return ink;
      });
      expect(facts.inkPixels as number).toBeGreaterThan(200);
      await page.waitForTimeout(300);
      await shot(theme, "1-pdf");

      // (2) text selects.
      await title.click({ clickCount: 3 });
      facts.selected = await page.evaluate(() => window.getSelection()?.toString().trim());
      expect(facts.selected).toContain(stage.fixture.pdfPageText[0]);
      await shot(theme, "2-pdf-text-selected");
      await page.evaluate(() => window.getSelection()?.removeAllRanges());

      // (3) zoom and the page field.
      const fitted = await pdf.getByTestId("file-view-zoom").innerText();
      await pdf.getByRole("button", { name: "Zoom in" }).click();
      await expect(pdf.getByTestId("file-view-zoom")).not.toHaveText(fitted);
      facts.zoom = { fitted, zoomed: await pdf.getByTestId("file-view-zoom").innerText() };
      await pdf.getByTestId("file-view-fit").click();
      await expect(pdf.getByTestId("file-view-zoom")).toHaveText(fitted);
      const field = pdf.getByTestId("pdf-page-input");
      await field.click();
      await field.fill("2");
      await field.press("Enter");
      await expect(pages.nth(1).locator(".textLayer span", { hasText: stage.fixture.pdfPageText[1] })).toBeVisible({ timeout: 15_000 });
      // A zoom keeps the place: still on page two after zooming in and back to fit.
      await pdf.getByRole("button", { name: "Zoom in" }).click();
      await expect(field).toHaveValue("2");
      await pdf.getByTestId("file-view-fit").click();
      await expect(field).toHaveValue("2");
      await field.click();
      await field.fill("1");
      await field.press("Enter");

      // (4) a box on page one, extracted to Shelf, the one Artifacts node in reach.
      await pdf.getByTestId("file-view-box-tool").click();
      // A drawn box opens the rail's composer on it (onDraft); discarding it lets the composer go too.
      await drag(page, first, [60, 200], [300, 300]);
      await expect(modal.getByText(/area on page 1/iu).first()).toBeVisible({ timeout: 10_000 });
      facts.composerOnDraw = true;
      await pdf.getByRole("button", { name: "Discard the box" }).click();
      await expect(first.getByTestId("file-box-draft")).toHaveCount(0);
      await expect(modal.getByText(/area on page 1/iu)).toHaveCount(0);
      await expect(pdf.locator(".file-view__stage")).toBeFocused();
      await drag(page, first, [60, 40], [360, 160]);
      await expect(first.getByTestId("file-box-draft")).toBeVisible();
      const drawn = (await first.getByTestId("file-box-draft").boundingBox())!.width / (await first.boundingBox())!.width;
      await expect(pdf.getByTestId("file-box-extract")).toBeEnabled();
      await shot(theme, "3-pdf-box");
      await pdf.getByTestId("file-box-extract").click();
      await expect(pdf.getByTestId("file-view-said")).toHaveText("Extracted to Shelf.", { timeout: 15_000 });
      // The keyboard is back on the stage: B still toggles the tool.
      await expect(pdf.locator(".file-view__stage")).toBeFocused();
      await page.keyboard.press("b");
      await expect(pdf.getByTestId("file-view-box-tool")).toHaveAttribute("aria-pressed", "false");
      await shot(theme, "4-pdf-extracted");

      // (5) the image: fitted, never enlarged, and a box on it extracted too.
      await openInTree(modal, stage.fixture.paths.png);
      const image = modal.getByTestId("image-viewer");
      await expect(image.locator("img")).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => image.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
      facts.imageZoom = await image.getByTestId("file-view-zoom").innerText();
      expect(facts.imageZoom).toBe("100%");
      await image.getByTestId("file-view-box-tool").click();
      // A box comment posted from the rail spends the drawn box: it shows as the thread, not as a draft with Extract.
      await drag(page, image.locator(".file-view__surface"), [200, 140], [300, 190]);
      await expect(modal.getByText(/area on the image/iu).first()).toBeVisible({ timeout: 10_000 });
      await modal.getByPlaceholder(/^Comment on this place/u).fill(`The corner, ${theme}`);
      await modal.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(image.getByTestId("file-box-thread")).toHaveCount(1 + (theme === "bright" ? 1 : 0), { timeout: 15_000 });
      await expect(image.getByTestId("file-box-draft")).toHaveCount(0);
      facts.postedBoxSpent = true;
      await drag(page, image.locator(".file-view__surface"), [20, 20], [180, 120]);
      await image.getByTestId("file-box-extract").click();
      await expect(image.getByTestId("file-view-said")).toHaveText("Extracted to Shelf.", { timeout: 15_000 });
      await shot(theme, "5-image-extracted");

      // (6) a file that is neither offers its default app and Finder (not pressed: it would open them).
      await openInTree(modal, stage.fixture.paths.unknownBinary);
      const other = modal.getByTestId("file-view-other");
      await expect(other).toBeVisible({ timeout: 15_000 });
      await expect(other.getByRole("button", { name: "Open in default app" })).toBeVisible();
      await expect(other.getByRole("button", { name: "Reveal in Finder" })).toBeVisible();
      await shot(theme, "6-other-file");

      // (7) Shelf holds both, each naming its source; the PDF one is the box at twice the page's 612 points.
      await page.keyboard.press("Escape");
      await expect(modal).toBeHidden({ timeout: 10_000 });
      await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
      const list = page.getByRole("list", { name: "Artifacts" });
      await expect(list).toBeVisible({ timeout: 20_000 });
      await list.locator("button").filter({ hasText: "sample.pdf, page 1" }).first().click();
      const source = page.locator(".artifact-preview__source");
      await expect(source).toHaveText("From docs/sample.pdf, page 1", { timeout: 15_000 });
      const extracted = page.locator(".artifact-preview__media img");
      await expect.poll(() => extracted.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
      const width = await extracted.evaluate((img: HTMLImageElement) => img.naturalWidth);
      facts.pdfExtract = { width, expected: Math.round(drawn * 1224) };
      expect(Math.abs(width - drawn * 1224)).toBeLessThan(4);
      await shot(theme, "7-artifact-from-pdf");
      await list.locator("button").filter({ hasText: "gradient.png" }).first().click();
      await expect(source).toHaveText("From img/gradient.png", { timeout: 15_000 });
      facts.imageExtractWidth = await extracted.evaluate((img: HTMLImageElement) => img.naturalWidth);
      await shot(theme, "8-artifact-from-image");
      await page.keyboard.press("Escape");
      await expect(list).toBeHidden({ timeout: 10_000 });
    }
  } finally {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "report.json"), JSON.stringify(report, null, 2));
    await junto.close();
    await stage.cleanup();
  }
});
