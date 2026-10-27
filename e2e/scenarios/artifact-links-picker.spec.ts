/**
 * Real app, plan 0.11 02 L2: `[[` in a document offers the artifacts in reach
 * by title, writes the link by id and draws it as the artifact's title; a
 * title that matches nothing creates a document by it in the same node and
 * links it. Bright and dark, axe over the open list.
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

const CANVAS = "links";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifact-links-picker";
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

/** axe (WCAG 2.2 A and AA) over one surface; legacy mode, as Electron refuses axe's extra page. */
const axeIds = async (page: Page, include: string): Promise<ReadonlyArray<string>> => {
  const result = await new AxeBuilder({ page }).setLegacyMode(true).include(include).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
};

const seed = (page: Page, title: string, markdown: string) =>
  page.evaluate(
    ({ canvas, node, artifactId, opId, title, markdown }) =>
      window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title, body: { type: "document", markdown } }),
    { canvas: CANVAS, node: asNodeId("shelf"), artifactId: mintItemId(), opId: mintOpId(), title, markdown },
  );

test("[[ links an artifact by title, and creates a document from a title that matches nothing, bright and dark", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([shelf], []) } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    await seed(page, "Launch plan", "Ship it.");
    await seed(page, "Budget notes", "Numbers.");
    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    const list = page.getByRole("list", { name: "Artifacts" });
    await expect(list).toBeVisible({ timeout: 20_000 });
    await list.locator("button").filter({ hasText: "Launch plan" }).first().click();
    await expect(page.locator(".artifact-head__meta")).toHaveText("Document, version 1", { timeout: 15_000 });

    for (const theme of ["dark", "bright"] as const) {
      await setTheme(page, theme);
      const source = page.getByLabel("Markdown");
      await source.click();
      await page.keyboard.press("Meta+ArrowDown");

      // [[ and a few letters: the artifact in reach, by title, in a list the text names.
      await page.keyboard.type(" See [[bud");
      const picker = page.getByRole("listbox", { name: "Artifacts to link" });
      await expect(picker).toBeVisible();
      await expect(picker.getByRole("option", { name: /Budget notes/ })).toBeVisible();
      await expect(source).toHaveAttribute("aria-activedescendant", /.+/);
      await frame(page, `${theme}-1-picker`);
      expect(await axeIds(page, ".mention-picker")).toEqual([]);

      // Enter writes the link; it draws as the artifact's title.
      await page.keyboard.press("Enter");
      await expect(picker).toHaveCount(0);
      const chips = page.locator(".live-markdown [data-testid=document-mention-chip]");
      await expect(chips.filter({ hasText: "Budget notes" }).last()).toBeVisible();

      // A title that matches nothing offers a document by it; the press makes it and links it.
      const fresh = theme === "dark" ? "Q3 review" : "Q4 review";
      await page.keyboard.type(`and [[${fresh}`);
      const create = picker.getByRole("option", { name: new RegExp(`Create document ${fresh}`) });
      await expect(create).toBeVisible();
      await frame(page, `${theme}-2-create`);
      await page.keyboard.press("Enter");
      await expect(chips.filter({ hasText: fresh })).toBeVisible({ timeout: 15_000 });
      await expect(list.locator("button").filter({ hasText: fresh })).toHaveCount(1);
      await page.keyboard.press("Escape");
      await frame(page, `${theme}-3-linked`);
      expect(await axeIds(page, ".live-markdown")).toEqual([]);
    }

    // What was saved is the [[Title]] mention link by id.
    await expect(page.locator(".artifact-head__meta")).toHaveText(/Document, version [2-9]/, { timeout: 15_000 });
    const text = await page.evaluate((canvas) => window.junto!.resource!.artifact!.list(canvas, "shelf" as never), CANVAS);
    const plan = (text as ReadonlyArray<{ artifact: { title: string }; body: { markdown?: string } | null }>).find((head) => head.artifact.title === "Launch plan");
    console.log("SAVED", JSON.stringify(plan?.body?.markdown));
    expect(plan?.body?.markdown).toMatch(/See \[\\\[\\\[Budget notes\\\]\\\]\]\(junto:\/\/canvas\/links\?node=shelf&item=[0-9A-Z]{26}\)/);
    expect(plan?.body?.markdown).toMatch(/\[\\\[\\\[Q3 review\\\]\\\]\]\(junto:\/\/canvas\/links\?node=shelf&item=[0-9A-Z]{26}\)/);
  } finally {
    await junto.close();
  }
});
