/**
 * 0.11 F7, comments anywhere in a file. A box drawn on an image or on a PDF page
 * is a thread anchored to fractions of that picture (0..1, so it holds at any
 * size); a thread lists in the file's rail, and only that file's threads show.
 * Line comments anchor to lines of code with their quote, and find the quote
 * again after the file is edited above them. Real app, fixture folder.
 *   bun run test:e2e:fast e2e/scenarios/files-comments.spec.ts
 * Fixme until F7 and F3 are on main. The box half reads the BoxLayer test ids
 * in the working tree. The line half uses the F3 gutter names product-documents
 * set: "Comment on line N", and "Comment on lines N to M" for a dragged range,
 * shown beside the line under the pointer and on the caret line, in the textbox
 * named by the path. The rail's anchor wording ("Line 10") is product-feed's to
 * confirm.
 */
import type { Locator, Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";
import { filesNode, openFilesModal, openInTree, stageFiles, type FilesStage } from "../harness/files-scenario";

const CANVAS = "files-comments";

/** The picture's box, as fractions of its width and height: x0, y0, x1, y1. */
type Fractions = readonly [number, number, number, number];

const launch = (stage: FilesStage) => launchJunto({ seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root)]) } });

/** The box layer over the picture or PDF page on screen. */
const layer = (modal: Locator): Locator => modal.getByTestId("file-box-layer").filter({ visible: true }).first();

/** The comments rail; the edge opens it when it is shut. */
const openRail = async (modal: Locator): Promise<Locator> => {
  const composer = modal.getByLabel("New comment");
  if (!(await composer.isVisible())) await modal.locator(".artifact-comments-edge").click();
  await expect(composer).toBeVisible({ timeout: 10_000 });
  return composer;
};

/** A drag across the layer, from one corner fraction to another, with the mouse as the operator's hand. */
const drawBox = async (page: Page, target: Locator, [x0, y0, x1, y1]: Fractions): Promise<void> => {
  const box = await target.boundingBox();
  if (box === null) throw new Error("the box layer has no size");
  await page.mouse.move(box.x + box.width * x0, box.y + box.height * y0);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1, { steps: 8 });
  await page.mouse.up();
};

/** The saved box sits where it was drawn, within a pixel or two, whatever the layer's size. */
const expectBoxAt = async (thread: Locator, target: Locator, [x0, y0, x1, y1]: Fractions): Promise<void> => {
  const outer = await target.boundingBox();
  const inner = await thread.boundingBox();
  if (outer === null || inner === null) throw new Error("the box or its layer has no size");
  expect(Math.abs(inner.x - (outer.x + outer.width * x0))).toBeLessThan(2);
  expect(Math.abs(inner.y - (outer.y + outer.height * y0))).toBeLessThan(2);
  expect(Math.abs(inner.width - outer.width * (x1 - x0))).toBeLessThan(2);
  expect(Math.abs(inner.height - outer.height * (y1 - y0))).toBeLessThan(2);
};

const threads = (modal: Locator): Locator => modal.getByRole("list", { name: "Threads" }).getByRole("listitem");

/** Puts the caret on line `line` of the open file: a gutter control shows on the caret line. */
const caretOnLine = async (page: Page, editor: Locator, line: number): Promise<void> => {
  await editor.click();
  await page.keyboard.press("Meta+ArrowUp");
  for (let step = 1; step < line; step += 1) await page.keyboard.press("ArrowDown");
};

test.describe.fixme("comments anywhere in a file (F7)", () => {
  test("a box drawn on an image is a thread at its fractions, and the rail lists it", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launch(stage);
    try {
      const { page } = junto;
      const modal = await openFilesModal(page);
      await openInTree(modal, "img/gradient.png");

      const picture = layer(modal);
      const marked: Fractions = [0.25, 0.2, 0.75, 0.6];
      await drawBox(page, picture, marked);
      const composer = await openRail(modal);
      await composer.fill("the gradient corner");
      await composer.press("Meta+Enter");

      const thread = page.getByTestId("file-box-thread");
      await expect(thread).toHaveCount(1);
      await expectBoxAt(thread, picture, marked);
      await expect(threads(modal)).toHaveCount(1);
      await expect(threads(modal).first()).toContainText("the gradient corner");
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("a box on a PDF page records the page, and the rail shows it on that page only", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launch(stage);
    try {
      const { page } = junto;
      const modal = await openFilesModal(page);
      await openInTree(modal, "docs/sample.pdf");
      // The page control's name is not decided yet; the fixture's second page carries its own text.
      await page.getByRole("button", { name: "Next page" }).click();
      await expect(modal.getByRole("region", { name: "File" })).toContainText(stage.fixture.pdfPageText[1]);

      await drawBox(page, layer(modal), [0.1, 0.1, 0.6, 0.3]);
      const composer = await openRail(modal);
      await composer.fill("the second page heading");
      await composer.press("Meta+Enter");

      await expect(threads(modal).first()).toContainText("Page 2");
      await expect(threads(modal).first()).toContainText("the second page heading");
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("the rail lists only the open file's threads", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launch(stage);
    try {
      const { page } = junto;
      const modal = await openFilesModal(page);
      await openInTree(modal, "img/gradient.png");
      await drawBox(page, layer(modal), [0.4, 0.4, 0.6, 0.6]);
      const composer = await openRail(modal);
      await composer.fill("only on the picture");
      await composer.press("Meta+Enter");
      await expect(threads(modal)).toHaveCount(1);

      await openInTree(modal, "README.md");
      await expect(threads(modal)).toHaveCount(0);
      await openInTree(modal, "img/gradient.png");
      await expect(threads(modal)).toHaveCount(1);
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("a line comment anchors to its line and keeps the quote", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launch(stage);
    try {
      const { page } = junto;
      const modal = await openFilesModal(page);
      await openInTree(modal, "src/big.ts");

      // Line 10 of the generated file is the row1 declaration; its gutter control shows on the caret line.
      await caretOnLine(page, modal.getByRole("textbox", { name: "src/big.ts", exact: true }), 10);
      await modal.getByRole("button", { name: "Comment on line 10", exact: true }).click();
      const composer = await openRail(modal);
      await composer.fill("check the row id");
      await composer.press("Meta+Enter");

      await expect(threads(modal).first()).toContainText("Line 10");
      await expect(threads(modal).first()).toContainText("export const row1");
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("a line thread finds its line again after lines are added above it", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launch(stage);
    try {
      const { page } = junto;
      const modal = await openFilesModal(page);
      await openInTree(modal, "src/big.ts");
      await caretOnLine(page, modal.getByRole("textbox", { name: "src/big.ts", exact: true }), 10);
      await modal.getByRole("button", { name: "Comment on line 10", exact: true }).click();
      const composer = await openRail(modal);
      await composer.fill("follow the row");
      await composer.press("Meta+Enter");
      await expect(threads(modal).first()).toContainText("Line 10");

      const editor = modal.getByRole("textbox", { name: "src/big.ts", exact: true });
      await editor.click();
      await page.keyboard.press("Meta+ArrowUp");
      await page.keyboard.type("// added one\n// added two\n");
      await page.keyboard.press("Meta+s");

      // The quoted line moved down by two, and the thread follows it.
      await expect(threads(modal).first()).toContainText("Line 12");
      await expect(threads(modal).first()).toContainText("export const row1");
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("a range dragged in the gutter anchors to its lines", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launch(stage);
    try {
      const { page } = junto;
      const modal = await openFilesModal(page);
      await openInTree(modal, "src/big.ts");
      const editor = modal.getByRole("textbox", { name: "src/big.ts", exact: true });

      // Each gutter control shows on the caret line, so measure line 10, then line 12.
      await caretOnLine(page, editor, 10);
      const from = await modal.getByRole("button", { name: "Comment on line 10", exact: true }).boundingBox();
      await caretOnLine(page, editor, 12);
      const to = await modal.getByRole("button", { name: "Comment on line 12", exact: true }).boundingBox();
      if (from === null || to === null) throw new Error("the gutter controls have no size");

      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
      await page.mouse.up();

      await modal.getByRole("button", { name: "Comment on lines 10 to 12", exact: true }).click();
      const composer = await openRail(modal);
      await composer.fill("the three lines");
      await composer.press("Meta+Enter");

      await expect(threads(modal).first()).toContainText("the three lines");
      await expect(threads(modal).first()).toContainText("export const row1");
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });
});
