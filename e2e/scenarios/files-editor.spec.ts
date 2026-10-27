/**
 * The F3 code editor in the real app, bright and dark: a 5,000-line
 * TypeScript file opens highlighted, takes typing (marked Unsaved), finds on
 * Cmd+F, undoes back to clean, and a Markdown file opens in the live Markdown field. Frames go to
 * JUNTO_SHOTS_DIR (default test-results/files-editor, which git ignores) as
 * the review copy for the operator.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/files-editor.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";
import { filesNode, openFilesModal, openInTree, stageFiles } from "../harness/files-scenario";

const CANVAS = "files-editor";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/files-editor";

const setTheme = async (page: Page, theme: "bright" | "dark"): Promise<void> => {
  await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

/** axe (WCAG 2.2 A and AA) over one surface; legacy mode, as Electron refuses axe's extra page. */
const axeIds = async (page: Page, include: string): Promise<ReadonlyArray<string>> => {
  const result = await new AxeBuilder({ page }).setLegacyMode(true).include(include).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
};

const frame = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

/** The editor's text box, named by the file's path. */
const editorOf = (modal: Locator, path: string): Locator => modal.getByRole("textbox", { name: path, exact: true });

test("the code editor opens, types, finds and undoes, and Markdown opens live, bright and dark", async () => {
  test.setTimeout(300_000);
  const stage = await stageFiles();
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root)]) } });
  try {
    const { page } = junto;
    for (const theme of ["dark", "bright"] as const) {
      await setTheme(page, theme);
      const modal = await openFilesModal(page);

      const started = Date.now();
      await openInTree(modal, "src/big.ts");
      const editor = editorOf(modal, "src/big.ts");
      await expect(editor).toBeVisible({ timeout: 15_000 });
      await expect(modal.locator(".code-editor .tok-keyword").first()).toBeVisible({ timeout: 15_000 });
      console.log(`EDITOR ${theme} open to highlighted, from the row press: ${String(Date.now() - started)} ms`);
      await frame(page, `${theme}-code`);
      expect(await axeIds(page, ".code-editor")).toEqual([]);
      // The scroller keeps a keyboard stop inside it: the text, named by the path.
      await expect(modal.locator(".code-editor .cm-scroller .cm-content")).toHaveAttribute("tabindex", "0");

      // Typing on line 4 marks the file unsaved. (The comment plus comes with F7's wiring; tests/code-editor.test.tsx holds it.)
      await editor.locator(".cm-line").nth(3).click();
      await page.keyboard.press("End");
      await page.keyboard.type(" // edited");
      await expect(modal.getByRole("status").filter({ hasText: "Unsaved" })).toBeVisible();
      await frame(page, `${theme}-typed`);

      // Undo takes the edit back, and the file is clean again.
      await page.keyboard.press("Meta+z");
      await expect(editor).not.toContainText("// edited");
      await expect(modal.getByRole("status").filter({ hasText: "Unsaved" })).toHaveCount(0);

      // Find opens over the text and steps to a match.
      await page.keyboard.press("Meta+f");
      const query = modal.locator(".cm-search input[name=search]");
      await expect(query).toBeVisible();
      // Typed, not filled: the panel commits its query on the keys.
      await page.keyboard.type("sum12");
      await page.keyboard.press("Enter");
      await expect(modal.locator(".cm-searchMatch-selected")).toBeVisible();
      await frame(page, `${theme}-find`);
      await page.keyboard.press("Escape");
      await expect(query).toHaveCount(0);

      // Markdown opens in the live Markdown field.
      await openInTree(modal, "README.md");
      await expect(modal.locator(".live-markdown")).toBeVisible({ timeout: 15_000 });
      await frame(page, `${theme}-markdown`);
      expect(await axeIds(page, ".files-main")).toEqual([]);
      await expect(modal.locator(".live-markdown .cm-scroller .cm-content")).toHaveAttribute("tabindex", "0");

      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0, { timeout: 10_000 });
    }
  } finally {
    await junto.close();
    await stage.cleanup();
  }
});
