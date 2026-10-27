/**
 * 0.11 Files surfaces in the real app, in the bright and the dark theme: the
 * card, the modal with the tree and no file open, a code file, Markdown, an
 * image, a PDF page, the quick open palette, the comments rail, the drop mark on
 * a folder, and the state of a node whose folder is gone. Every surface passes
 * axe (WCAG 2.2 A and AA) and shows no middle dot, the copy law. Mirrors
 * artifacts-a11y.spec.ts; the frames are the review copy for the operator.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/files-audit.spec.ts
 * Frames default to test-results/files-audit, which git ignores. Fixme until
 * the Files surfaces are on main.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";
import {
  FILES_ID,
  filesCard,
  filesNode,
  hover,
  leave,
  openFilesModal,
  openInTree,
  stageFiles,
  transferOf,
  treeRow,
} from "../harness/files-scenario";

const CANVAS = "files-audit";
/** A name long enough to truncate in the tree, for the fade check on the dark frame. */
const LONG_NAME = "a-file-name-long-enough-to-run-past-the-tree-width-so-the-truncation-fade-shows-in-both-themes.md";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/files-audit";
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
/** U+00B7, banned from every visible surface by the copy law. Written as an escape so this file stays clear of it. */
const MIDDLE_DOT = "\u00b7";

type Violation = { readonly id: string; readonly impact?: string | null; readonly help: string; readonly nodes: ReadonlyArray<{ readonly target: ReadonlyArray<unknown> }> };

/**
 * One axe pass over `include`, then a check that no visible copy carries a middle
 * dot, then a frame of the whole window. Returns the findings in words.
 */
const scan = async (page: Page, surface: string, include: string): Promise<ReadonlyArray<string>> => {
  // The enter animation settles before colours are measured.
  await page.waitForTimeout(300);
  // Legacy mode scans in this page: Electron refuses the extra page axe opens by default.
  const result = await new AxeBuilder({ page }).setLegacyMode(true).include(include).withTags(WCAG).analyze();
  const lines = (result.violations as ReadonlyArray<Violation>).map(
    (v) => `${surface}: ${v.id} (${v.impact ?? "n/a"}) ${v.help}; ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(", ")}`,
  );
  const copy = await page.locator("body").innerText();
  if (copy.includes(MIDDLE_DOT)) lines.push(`${surface}: a middle dot in the visible copy`);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${surface}.png`) });
  for (const line of lines) console.log("AXE", line);
  return lines;
};

const setTheme = async (page: Page, theme: "bright" | "dark"): Promise<void> => {
  await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
  // Dark is the default, so the root drops the attribute rather than naming it.
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

const MODAL = '[role="dialog"][aria-label="Files"]';

test.describe.fixme("Files surfaces, bright and dark (F1 to F7)", () => {
  test("every Files surface passes axe and carries no middle dot, bright and dark", async () => {
    test.setTimeout(900_000);
    const stage = await stageFiles();
    // Files the frames need in the tree before the modal opens: the long name, and one draft per theme.
    writeFileSync(join(stage.fixture.root, LONG_NAME), "long name\n");
    for (const theme of ["bright", "dark"]) writeFileSync(join(stage.fixture.root, `draft-${theme}.md`), `draft for the ${theme} frame\n`);
    const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root)]) } });
    const found: string[] = [];
    try {
      const { page } = junto;
      for (const theme of ["bright", "dark"] as const) {
        await setTheme(page, theme);
        await expect(filesCard(page)).toBeVisible({ timeout: 30_000 });
        found.push(...(await scan(page, `${theme}-card`, `.react-flow__node[data-id="${FILES_ID}"]`)));

        const modal = await openFilesModal(page);
        found.push(...(await scan(page, `${theme}-modal-empty`, MODAL)));
        await expect(treeRow(modal, LONG_NAME)).toBeVisible({ timeout: 15_000 });
        await treeRow(modal, LONG_NAME).screenshot({ path: join(SHOTS, `${theme}-long-name-row.png`) });

        await openInTree(modal, "src/big.ts");
        found.push(...(await scan(page, `${theme}-code`, MODAL)));

        await openInTree(modal, "README.md");
        found.push(...(await scan(page, `${theme}-markdown`, MODAL)));

        await openInTree(modal, "img/gradient.png");
        found.push(...(await scan(page, `${theme}-image`, MODAL)));

        await openInTree(modal, "docs/sample.pdf");
        found.push(...(await scan(page, `${theme}-pdf`, MODAL)));

        await modal.locator(".artifact-comments-edge").click();
        found.push(...(await scan(page, `${theme}-comments-rail`, MODAL)));

        await page.keyboard.press("Meta+p");
        await expect(page.getByTestId("quick-open")).toBeVisible();
        found.push(...(await scan(page, `${theme}-quick-open`, '[data-testid="quick-open"]')));
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("quick-open")).toHaveCount(0);

        const transfer = await transferOf(page, [await stage.incoming("desk/audit.md", "audit\n")]);
        await hover(treeRow(modal, "src"), transfer);
        await expect(modal.locator('[data-files-drop="true"]')).toHaveAttribute("data-drop", "folder");
        found.push(...(await scan(page, `${theme}-drop-folder`, MODAL)));
        await leave(treeRow(modal, "src"), transfer);

        // Edit a draft, then change it on disk: the Unsaved mark shows, and a save offers reload or keep.
        const draft = `draft-${theme}.md`;
        await openInTree(modal, draft);
        await modal.getByRole("textbox", { name: draft, exact: true }).fill(`edited in the ${theme} frame\n`);
        await expect(modal.getByRole("status").filter({ hasText: "Unsaved" })).toBeVisible({ timeout: 10_000 });
        found.push(...(await scan(page, `${theme}-unsaved`, MODAL)));
        writeFileSync(join(stage.fixture.root, draft), "changed on disk\n");
        await page.keyboard.press("Meta+s");
        await expect(modal.getByRole("alert").getByRole("button", { name: "Keep mine" })).toBeVisible({ timeout: 15_000 });
        found.push(...(await scan(page, `${theme}-stale-save`, MODAL)));
        await modal.getByRole("alert").getByRole("button", { name: "Reload from disk" }).click();
        await expect(modal.getByRole("status").filter({ hasText: "Unsaved" })).toHaveCount(0);

        // After a reload the keyboard is back in the document: the first Escape stops writing, the second closes.
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await expect(modal).toHaveCount(0);
      }
    } finally {
      mkdirSync(SHOTS, { recursive: true });
      writeFileSync(join(SHOTS, "axe-violations.txt"), `${found.join("\n")}\n`);
      await junto.close();
      await stage.cleanup();
    }
    expect(found, found.join("\n")).toEqual([]);
  });

  test("a Files node whose folder is gone says so, bright and dark, and passes axe", async () => {
    test.setTimeout(300_000);
    const stage = await stageFiles();
    const gone = join(stage.parent, "gone-folder");
    const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([filesNode(gone)]) } });
    const found: string[] = [];
    try {
      const { page } = junto;
      for (const theme of ["bright", "dark"] as const) {
        await setTheme(page, theme);
        await expect(filesCard(page)).toBeVisible({ timeout: 30_000 });
        found.push(...(await scan(page, `${theme}-root-missing-card`, `.react-flow__node[data-id="${FILES_ID}"]`)));

        const modal = await openFilesModal(page);
        await expect(modal.getByRole("alert")).toBeVisible({ timeout: 15_000 });
        found.push(...(await scan(page, `${theme}-root-missing-modal`, MODAL)));

        await page.keyboard.press("Escape");
        await expect(modal).toHaveCount(0);
      }
    } finally {
      mkdirSync(SHOTS, { recursive: true });
      writeFileSync(join(SHOTS, "axe-root-missing.txt"), `${found.join("\n")}\n`);
      await junto.close();
      await stage.cleanup();
    }
    expect(found, found.join("\n")).toEqual([]);
  });
});
