/**
 * The artifact surfaces under axe, in the real app: the live markdown
 * document, the sheet and the pad, each with the comments rail collapsed to
 * its edge and open, in the bright and the dark theme. WCAG 2.2 A and AA.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/artifacts-a11y.spec.ts
 * Every surface is checked before the test fails, so one run lists all of
 * them; each violation prints its rule, its impact and the nodes it hit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { Node } from "../../src/shared/model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion } from "../harness/model";

const CANVAS = "artifacts-a11y";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifacts-a11y";
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

type Violation = { readonly id: string; readonly impact?: string | null; readonly help: string; readonly nodes: ReadonlyArray<{ readonly target: ReadonlyArray<unknown> }> };

/** One axe pass over the open artifact window; the violations, in words. */
const scan = async (page: Page, surface: string): Promise<ReadonlyArray<string>> => {
  await page.waitForTimeout(300);
  // Legacy mode scans in this page: Electron refuses the extra page axe opens
  // by default (Target.createTarget: Not supported).
  const result = await new AxeBuilder({ page }).setLegacyMode(true).include('[aria-modal="true"]').withTags(WCAG).analyze();
  const lines = (result.violations as ReadonlyArray<Violation>).map(
    (v) => `${surface}: ${v.id} (${v.impact ?? "n/a"}) ${v.help}; ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(", ")}${v.nodes.length > 4 ? `, +${v.nodes.length - 4} more` : ""}`,
  );
  for (const line of lines) console.log("AXE", line);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${surface}.png`) });
  return lines;
};

test("artifacts: document, sheet and pad, rail shut and open, bright and dark, pass axe", async () => {
  test.setTimeout(300_000);
  const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x: 400, y: 60, width: 280, height: 160, z: 0 });
  const ops = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 800, height: 400 });
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([ops, shelf], []) } });
  const found: string[] = [];
  try {
    const { page } = junto;
    const card = page.locator('.react-flow__node[data-id="shelf"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.dblclick();
    const list = page.getByRole("list", { name: "Artifacts" });
    await expect(list).toBeVisible({ timeout: 20_000 });
    const meta = page.locator(".artifact-head__meta");

    for (const noun of ["Document", "Sheet", "Pad"]) {
      await page.getByRole("button", { name: "New artifact" }).click();
      await page.getByRole("group", { name: "New artifact" }).locator("button").filter({ hasText: noun }).click();
      await expect(meta).toHaveText(`${noun}, version 1`, { timeout: 15_000 });
    }
    // The document gets some rendered markdown, so its marks are in the scan.
    await list.locator("button").filter({ hasText: "Untitled document" }).first().click();
    const markdown = page.getByLabel("Markdown");
    await markdown.fill("# Release notes\n\nFirst **draft** of the notes, with a [link](https://example.com).\n\n- one\n- two");
    await markdown.blur();
    await expect(meta).toHaveText("Document, version 2", { timeout: 15_000 });

    const edge = page.locator(".artifact-comments-edge");
    for (const theme of ["bright", "dark"] as const) {
      await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const [noun, title] of [["document", "Untitled document"], ["sheet", "Untitled sheet"], ["pad", "Untitled pad"]] as const) {
        await list.locator("button").filter({ hasText: title }).first().click();
        await expect(page.locator(".artifact-head__title")).toHaveValue(title);
        await expect(edge).toBeVisible();
        found.push(...(await scan(page, `${theme}-${noun}-rail-shut`)));
        await edge.click();
        await expect(page.getByLabel("New comment")).toBeVisible();
        found.push(...(await scan(page, `${theme}-${noun}-rail-open`)));
        await page.locator(".artifact-comments").getByRole("button", { name: "Comments", exact: true }).click();
        await expect(edge).toBeVisible();
      }
    }
  } finally {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "axe-violations.txt"), `${found.join("\n")}\n`);
    await junto.close();
  }
  expect(found, found.join("\n")).toEqual([]);
});
