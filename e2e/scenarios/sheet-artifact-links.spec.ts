/**
 * Real app, plan 0.11 02 L3 (sheet): in a sheet cell's edit, `[[` offers the
 * artifacts in reach by title and writes the link by id; out of the edit the
 * cell draws it as the artifact's current title, so a rename shows at once;
 * a title that matches nothing makes a document by it in the same node and
 * links it; Cmd+Enter opens the link. Dark and bright, axe over the open list.
 *   bun run test:e2e:fast e2e/scenarios/sheet-artifact-links.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const CANVAS = "sheet-links";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/sheet-artifact-links";
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x: 60, y: 60, width: 280, height: 160, z: 0 });

const frame = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const setTheme = async (page: Page, theme: "bright" | "dark"): Promise<void> => {
  await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

const axeIds = async (page: Page, include: string): Promise<ReadonlyArray<string>> => {
  const result = await new AxeBuilder({ page }).setLegacyMode(true).include(include).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
};

const apply = (page: Page, artifactId: string, op: unknown) =>
  page.evaluate(
    ({ canvas, node, artifactId, opId, op }) => window.junto!.resource!.artifact!.apply(canvas, node, artifactId as never, opId, op as never),
    { canvas: CANVAS, node: asNodeId("shelf"), artifactId, opId: mintOpId(), op },
  );

type Head = { artifact: { artifactId: string; title: string }; body: { grid?: { rows: ReadonlyArray<{ id: string; cells: Record<string, string> }> } } | null };
const heads = (page: Page) =>
  page.evaluate((canvas) => window.junto!.resource!.artifact!.list(canvas, "shelf" as never), CANVAS) as Promise<ReadonlyArray<Head>>;

test("[[ in a sheet cell links an artifact, draws its current title, makes a document from a new title, and opens with Cmd+Enter, dark and bright", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([shelf], []) } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    const planId = mintItemId();
    await apply(page, planId, { op: "create", title: "Launch plan", body: { type: "document", markdown: "Ship it." } });
    const sheetId = mintItemId();
    await apply(page, sheetId, {
      op: "create",
      title: "Tracker",
      body: {
        type: "sheet",
        grid: {
          columns: [
            { id: "c1", name: "Item" },
            { id: "c2", name: "Notes" },
          ],
          rows: [
            { id: "r1", cells: { c1: "Launch" } },
            { id: "r2", cells: { c1: "Review" } },
          ],
        },
      },
    });
    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    const list = page.getByRole("list", { name: "Artifacts" });
    await expect(list).toBeVisible({ timeout: 20_000 });
    await list.locator("button").filter({ hasText: "Tracker" }).first().click();
    const sheet = page.getByTestId("artifact-sheet");
    await expect(sheet.locator('[data-cell="B1"]')).toBeVisible({ timeout: 15_000 });

    for (const [index, theme] of (["dark", "bright"] as const).entries()) {
      await setTheme(page, theme);
      const a1 = `B${String(index + 1)}`;
      const cell = sheet.locator(`[data-cell="${a1}"]`);
      await cell.click();
      await page.keyboard.press("Enter");
      const text = sheet.getByTestId("artifact-sheet-cell-edit");
      await expect(text).toBeFocused();

      // [[ and a few letters: the artifact in reach, by title.
      await page.keyboard.type("See [[laun");
      const picker = page.getByRole("listbox", { name: "Artifacts to link" });
      await expect(picker.getByRole("option", { name: /Launch plan/ })).toBeVisible();
      await frame(page, `${theme}-1-picker`);
      expect(await axeIds(page, ".junto-artifact-sheet__cell-edit")).toEqual([]);
      await page.keyboard.press("Enter");
      await expect(picker).toHaveCount(0);
      await expect(text).toHaveValue("See [[Launch plan]] ");

      // A title that matches nothing: its one row makes the document, and the link goes in.
      const fresh = theme === "dark" ? "Q3 review" : "Q4 review";
      await page.keyboard.type(`and [[${fresh}`);
      await expect(picker.getByRole("option", { name: new RegExp(`Create document ${fresh}`) })).toBeVisible();
      await frame(page, `${theme}-2-create`);
      await page.keyboard.press("Enter");
      await expect(text).toHaveValue(`See [[Launch plan]] and [[${fresh}]] `, { timeout: 15_000 });
      await expect(list.locator("button").filter({ hasText: fresh })).toHaveCount(1);

      // Enter keeps the text and moves down; the cell draws the links as titles, never addresses.
      await page.keyboard.press("Enter");
      await expect(text).toHaveCount(0);
      await expect(cell).toHaveValue(`See Launch plan and ${fresh} `, { timeout: 15_000 });
      await expect(cell).toHaveAttribute("data-links", "true");
      await frame(page, `${theme}-3-linked`);
    }

    // What was saved is the [[Title]] link by id.
    await expect
      .poll(async () => (await heads(page)).find((head) => head.artifact.artifactId === sheetId)?.body?.grid?.rows[0]?.cells["c2"], { timeout: 15_000 })
      .toMatch(new RegExp(`^See \\[\\\\\\[\\\\\\[Launch plan\\\\\\]\\\\\\]\\]\\(junto://canvas/${CANVAS}\\?node=shelf&item=${planId}\\) and \\[\\\\\\[\\\\\\[Q3 review`));

    // A rename shows in the cell at once.
    await apply(page, planId, { op: "retitle", title: "Launch plan v2" });
    const b1 = sheet.locator('[data-cell="B1"]');
    await expect(b1).toHaveValue("See Launch plan v2 and Q3 review ", { timeout: 15_000 });
    await frame(page, "bright-4-renamed");

    // Cmd+Enter opens the cell's first link: the document it names.
    await b1.click();
    await page.keyboard.press("Meta+Enter");
    await expect(page.getByText("Ship it.")).toBeVisible({ timeout: 15_000 });
    await frame(page, "bright-5-opened");
  } finally {
    await junto.close();
  }
});
