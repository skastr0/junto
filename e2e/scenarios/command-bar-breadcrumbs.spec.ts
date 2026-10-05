/**
 * cmd+K rows carry their region path.
 *
 * The independent check on the breadcrumb: a board with regions nested three
 * deep, a sibling region, two regions sharing a label, unnamed regions, a
 * root seat, and a path too long for its row. Every row's crumb reads outer
 * to inner, a region row shows its ancestors and not itself, a root seat has
 * no crumb, a long path clips from the left so the innermost region stays on
 * screen, and a region name finds the nodes inside it. Frames land in
 * test-results/command-bar-breadcrumbs/.
 *
 *   bun run test:e2e:fast e2e/scenarios/command-bar-breadcrumbs.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { CanvasNode, GroupNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "command-bar-breadcrumbs");
const CANVAS = "breadcrumbs";
const CRUMB = "command-bar-row-crumb";

const region = (
  id: string,
  label: string | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
): GroupNode => ({ id, type: "group", ...(label === undefined ? {} : { label }), x, y, width, height });

const seat = (id: string, x: number, y: number): CanvasNode =>
  agentTextNode({ id, key: `local:e2e-crumb-${id}`, label: id, harness: "claude", x, y });

// Five named regions, each inside the last: a path far wider than a row.
const LONG = [
  "Platform reliability engineering",
  "Continental release operations",
  "Overnight migration rehearsals",
  "Customer data residency checks",
  "Lantern",
];
const LONG_PATH = LONG.join(" / ");
const longRegions = LONG.map((label, depth) =>
  region(`r-long-${String(depth)}`, label, depth * 100, 2200 + depth * 100, 3000 - depth * 200, 1400 - depth * 200),
);

const nodes: ReadonlyArray<CanvasNode> = [
  // Three deep: Ops > Staging > Db.
  region("r-ops", "Ops", 0, 0, 2000, 1200),
  region("r-staging", "Staging", 100, 200, 1700, 900),
  region("r-db", "Db", 200, 400, 1200, 600),
  seat("ada", 40, 40),
  seat("bea", 140, 240),
  seat("cy", 300, 500),
  // A sibling region never appears in another region's path.
  region("r-research", "Research", 2200, 0, 600, 400),
  seat("dee", 2260, 80),
  // Two regions sharing a label, one inside the other.
  region("r-twin-outer", "Ops", 3000, 0, 900, 600),
  region("r-twin-inner", "Ops", 3100, 100, 600, 400),
  seat("eve", 3200, 200),
  // An unnamed region inside a named one is skipped.
  region("r-lab", "Lab", 0, 1400, 900, 600),
  region("r-lab-unnamed", undefined, 100, 1500, 600, 400),
  seat("fay", 200, 1600),
  // Only an unnamed region: no crumb.
  region("r-unnamed", undefined, 1100, 1400, 600, 400),
  seat("gus", 1200, 1500),
  // In no region at all.
  seat("hal", 2200, 1400),
  ...longRegions,
  seat("ivy", 500, 2700),
];

test.use({ juntoOptions: { seedCanvases: { [CANVAS]: canvasDoc([...nodes], []) } } });

const setTheme = async (page: Page, theme: "dark" | "bright"): Promise<void> => {
  await page.evaluate((mode) => window.junto!.settingsPatch({ appearance: { theme: mode } }), theme);
  // Dark is the default edition and carries no attribute.
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

test("cmd+K rows read their region path, outer to inner", async ({ junto }) => {
  const { page } = junto;
  await mkdir(SHOTS, { recursive: true });
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

  await page.keyboard.press("Meta+k");
  const input = page.getByTestId("command-bar-input");
  await expect(input).toBeVisible();

  const rows = page.locator(".command-bar__row");
  const titles = page.locator(".command-bar__row-title");
  /** Rows whose title is exactly `title`. */
  const rowsTitled = (title: string): Locator =>
    rows.filter({ has: page.locator(".command-bar__row-title", { hasText: new RegExp(`^${title}$`) }) });
  const crumbOf = (title: string): Locator => rowsTitled(title).getByTestId(CRUMB);

  // Seats: one crumb per depth, outer to inner, with the full path as tooltip.
  await expect(rowsTitled("ada")).toHaveCount(1);
  await expect(crumbOf("ada")).toHaveText("Ops");
  await expect(crumbOf("bea")).toHaveText("Ops / Staging");
  await expect(crumbOf("cy")).toHaveText("Ops / Staging / Db");
  // TooltipLayer moves a native title onto data-junto-tooltip at runtime.
  await expect(crumbOf("cy")).toHaveAttribute("data-junto-tooltip", "Ops / Staging / Db");
  // A sibling region stays out of the path; shared labels both appear.
  await expect(crumbOf("dee")).toHaveText("Research");
  await expect(crumbOf("eve")).toHaveText("Ops / Ops");
  // Unnamed regions are skipped; a root seat has no crumb element at all.
  await expect(crumbOf("fay")).toHaveText("Lab");
  await expect(rowsTitled("gus")).toHaveCount(1);
  await expect(crumbOf("gus")).toHaveCount(0);
  await expect(rowsTitled("hal")).toHaveCount(1);
  await expect(crumbOf("hal")).toHaveCount(0);

  // Region rows show their ancestors, never themselves.
  await expect(crumbOf("Staging")).toHaveText("Ops");
  await expect(crumbOf("Db")).toHaveText("Ops / Staging");
  await expect(crumbOf("Research")).toHaveCount(0);
  await expect(crumbOf("Lab")).toHaveCount(0);
  // Three regions are named Ops: two at the root, one inside its twin.
  await expect(rowsTitled("Ops")).toHaveCount(3);
  await expect(crumbOf("Ops")).toHaveText(["Ops"]);

  // Copy law: no middle dots in any row.
  expect((await rows.allTextContents()).join("\n")).not.toContain("·");

  for (const theme of ["dark", "bright"] as const) {
    await setTheme(page, theme);
    await page.mouse.move(4, 700);
    await page.screenshot({ path: join(SHOTS, `${theme}-01-paths.png`) });
  }
  await setTheme(page, "dark");

  // A long path: one line, clipped from the left, innermost region on screen.
  await input.fill("ivy");
  await expect(titles.first()).toHaveText("ivy");
  const longCrumb = crumbOf("ivy");
  await expect(longCrumb).toHaveText(LONG_PATH);
  await expect(longCrumb).toHaveAttribute("data-junto-tooltip", LONG_PATH);
  const clip = await longCrumb.evaluate((el, innermost) => {
    const box = el.getBoundingClientRect();
    const row = el.closest(".command-bar__row")!.getBoundingClientRect();
    const title = el.closest(".command-bar__row")!.querySelector(".command-bar__row-title")!;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode() as Text;
    const edge = (from: number, to: number): DOMRect => {
      const range = document.createRange();
      range.setStart(text, from);
      range.setEnd(text, to);
      return range.getBoundingClientRect();
    };
    const full = text.data;
    const inner = edge(full.length - innermost.length, full.length);
    const outer = edge(0, 8);
    return {
      clipped: el.scrollWidth > el.clientWidth,
      oneLine: box.height < 24,
      insideRow: box.left >= row.left - 0.5 && box.right <= row.right + 0.5,
      innermostVisible: inner.left >= box.left - 0.5 && inner.right <= box.right + 0.5,
      outermostVisible: outer.left >= box.left - 0.5 && outer.right <= box.right + 0.5,
      titleWhole: title.scrollWidth <= title.clientWidth,
    };
  }, LONG[LONG.length - 1]!);
  console.log(`BREADCRUMBS long-path ${JSON.stringify(clip)}`);
  expect(clip).toEqual({
    clipped: true,
    oneLine: true,
    insideRow: true,
    innermostVisible: true,
    outermostVisible: false,
    titleWhole: true,
  });
  await page.screenshot({ path: join(SHOTS, "dark-02-long-path.png") });

  // A region name finds its members: the region by title, then seats by path.
  await input.fill("staging");
  await expect(titles).toHaveText(["Staging", "bea", "cy", "Db"]);
  await page.screenshot({ path: join(SHOTS, "dark-03-region-query.png") });
  // A sibling's name never pulls in another region's seats.
  await input.fill("research");
  await expect(titles).toHaveText(["Research", "dee"]);

  // Enter on a row found by its path focuses that seat.
  await input.fill("staging");
  await expect(titles).toHaveText(["Staging", "bea", "cy", "Db"]);
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toHaveClass(/command-bar__row--active/);
  await page.keyboard.press("Enter");
  await expect(input).toHaveCount(0);
  await expect(page.locator(".react-flow__node.selected", { hasText: "bea" })).toHaveCount(1);
});
