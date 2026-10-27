/**
 * Real-app verify of a6510c1bb: the artifacts list is a narrow sidebar (176 to
 * 208px) beside an open artifact. Titles ellipsize, the search box and the six
 * type chips fit, the sidebar collapses to the strip and expands again, and
 * the comments rail keeps its column.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const CANVAS = "verify-narrow";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifacts-narrow-sidebar";
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x: 60, y: 60, width: 280, height: 160, z: 0 });
const LONG = "A deliberately long artifact title that cannot fit a narrow sidebar";

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

test("a6510c1bb: narrow artifacts sidebar fits, collapses, expands; rail unchanged", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([shelf], []) } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    for (const title of [LONG, "Short one"]) {
      await page.evaluate(
        ({ canvas, node, artifactId, opId, title }) =>
          window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title, body: { type: "document", markdown: "Seed text." } }),
        { canvas: CANVAS, node: asNodeId("shelf"), artifactId: mintItemId(), opId: mintOpId(), title },
      );
    }
    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    const list = page.getByRole("list", { name: "Artifacts" });
    await expect(list).toBeVisible({ timeout: 20_000 });
    await list.locator("button").filter({ hasText: "A deliberately" }).first().click();
    await expect(page.locator(".artifact-head__meta")).toHaveText("Document, version 1", { timeout: 15_000 });

    const measure = () =>
      page.evaluate(() => {
        const box = (el: Element | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
        };
        const grid = document.querySelector(".two-pane") as HTMLElement;
        const side = box(document.querySelector(".two-pane__sidebar"));
        const body = document.querySelector(".two-pane__sidebar-body") as HTMLElement;
        const chips = [...document.querySelectorAll(".artifacts-filter__type")].map((c) => ({ text: c.textContent, ...box(c)! }));
        const search = box(document.querySelector(".artifacts-filter__search"));
        const input = box(document.querySelector('[aria-label="Search artifacts"]'));
        const typesEl = document.querySelector(".artifacts-filter__types") as HTMLElement;
        const titles = [...document.querySelectorAll('[aria-label="Artifacts"][role="list"] button span.truncate')].map((t) => {
          const e = t as HTMLElement;
          return { text: e.textContent, clientWidth: e.clientWidth, scrollWidth: e.scrollWidth, textOverflow: getComputedStyle(e).textOverflow };
        });
        return {
          container: Math.round(grid.getBoundingClientRect().width),
          columns: getComputedStyle(grid).gridTemplateColumns,
          sidebar: side,
          bodyHidden: body.hidden,
          bodyScroll: { client: body.clientWidth, scroll: body.scrollWidth },
          search,
          input,
          chips,
          typesWrapped: new Set(chips.map((c) => 0)).size,
          typesScroll: { client: typesEl.clientWidth, scroll: typesEl.scrollWidth },
          titles,
          rail: box(document.querySelector(".two-pane__rail")),
          main: box(document.querySelector(".two-pane__main")),
        };
      });

    await expect(page.locator(".two-pane__rail")).toBeVisible();
    // The comments rail opens collapsed to its edge; open it to measure its column.
    await page.locator(".artifact-comments-edge").click();
    await expect(page.getByLabel("New comment")).toBeVisible();
    const open = await measure();
    console.log("OPEN", JSON.stringify(open, null, 1));
    await shot(page, "1-open");
    expect(open.chips).toHaveLength(6);
    expect(open.sidebar!.width).toBeGreaterThanOrEqual(176);
    expect(open.sidebar!.width).toBeLessThanOrEqual(208);
    for (const chip of open.chips) {
      expect(chip.left, chip.text ?? "").toBeGreaterThanOrEqual(open.sidebar!.left);
      expect(chip.right, chip.text ?? "").toBeLessThanOrEqual(open.sidebar!.right);
    }
    expect(open.typesScroll.scroll).toBeLessThanOrEqual(open.typesScroll.client);
    expect(open.bodyScroll.scroll).toBeLessThanOrEqual(open.bodyScroll.client);
    expect(open.search!.right).toBeLessThanOrEqual(open.sidebar!.right);
    const long = open.titles.find((t) => t.text === LONG)!;
    expect(long.textOverflow).toBe("ellipsis");
    expect(long.scrollWidth).toBeGreaterThan(long.clientWidth);
    const rail = open.rail!;
    // Rail rule is unchanged: clamp(260px, 26cqw, 320px).
    expect(rail.width).toBe(Math.min(320, Math.max(260, Math.round(open.container * 0.26))));

    await page.getByRole("button", { name: "Sidebar" }).first().click();
    await expect(page.locator(".two-pane[data-sidebar='collapsed']")).toHaveCount(1);
    const collapsed = await measure();
    console.log("COLLAPSED", JSON.stringify({ columns: collapsed.columns, sidebar: collapsed.sidebar, rail: collapsed.rail, main: collapsed.main }));
    await shot(page, "2-collapsed");
    expect(collapsed.sidebar!.width).toBeLessThan(60);
    expect(collapsed.rail!.width).toBe(rail.width);

    await page.getByRole("button", { name: "Sidebar" }).first().click();
    await expect(page.locator(".two-pane[data-sidebar='collapsed']")).toHaveCount(0);
    const again = await measure();
    console.log("EXPANDED AGAIN", JSON.stringify({ columns: again.columns, sidebar: again.sidebar, rail: again.rail }));
    await shot(page, "3-expanded-again");
    expect(again.sidebar!.width).toBe(open.sidebar!.width);
    expect(again.rail!.width).toBe(rail.width);
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible();
  } finally {
    await junto.close();
  }
});
