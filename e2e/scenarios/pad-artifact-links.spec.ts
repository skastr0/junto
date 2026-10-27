/**
 * Real app, plan 0.11 02 L3 (pad): in an artifact pad's shape text, `[[`
 * offers the artifacts in reach by title and writes the link by id; the
 * shape draws it as the artifact's current title, so a rename shows at once;
 * a title that matches nothing makes a document by it in the same node and
 * links it. Bright and dark, axe over the open list.
 *   bun run test:e2e:fast e2e/scenarios/pad-artifact-links.spec.ts
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

const CANVAS = "pad-links";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/pad-artifact-links";
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

type Head = { artifact: { artifactId: string; title: string }; body: { pad?: { shapes: ReadonlyArray<{ id: string; text?: string }> } } | null };
const heads = (page: Page) =>
  page.evaluate((canvas) => window.junto!.resource!.artifact!.list(canvas, "shelf" as never), CANVAS) as Promise<ReadonlyArray<Head>>;

test("[[ in a pad's shape text links an artifact, draws its current title, and makes a document from a new title, bright and dark", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([shelf], []) } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    const planId = mintItemId();
    await apply(page, planId, { op: "create", title: "Launch plan", body: { type: "document", markdown: "Ship it." } });
    const boxes = ["dark", "bright"].map((theme, index) => ({ id: `box-${theme}`, type: "box", x: 80, y: 80 + index * 160, w: 360, h: 100, z: index }));
    // A link to an artifact Shelf never held: it reads as missing, never as the title it was written with.
    const ghost = `[\\[\\[Old notes\\]\\]](junto://canvas/${CANVAS}?node=shelf&item=${mintItemId()})`;
    boxes.push({ id: "box-ghost", type: "box", x: 480, y: 80, w: 240, h: 100, z: 2, text: `Was ${ghost}` } as never);
    await apply(page, mintItemId(), { op: "create", title: "Map", body: { type: "pad", pad: { revision: 0, images: [], shapes: boxes, edges: [], inks: [] } } });
    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    const list = page.getByRole("list", { name: "Artifacts" });
    await expect(list).toBeVisible({ timeout: 20_000 });
    await list.locator("button").filter({ hasText: "Map" }).first().click();
    const pad = page.getByTestId("artifact-pad");
    await expect(pad.getByTestId("pad-shape")).toHaveCount(3, { timeout: 15_000 });
    await expect(pad.locator('[data-shape-id="box-ghost"] text')).toHaveText("Was Missing artifact", { timeout: 15_000 });

    for (const theme of ["dark", "bright"] as const) {
      await setTheme(page, theme);
      const shape = pad.locator(`[data-shape-id="box-${theme}"]`);
      await shape.dblclick();
      const text = pad.getByRole("combobox", { name: "Shape text" });
      await expect(text).toBeFocused();

      // [[ and a few letters: the artifact in reach, by title.
      await page.keyboard.type("See [[laun");
      const picker = page.getByRole("listbox", { name: "Artifacts to link" });
      await expect(picker.getByRole("option", { name: /Launch plan/ })).toBeVisible();
      await expect(text).toHaveAttribute("aria-activedescendant", /.+/);
      await frame(page, `${theme}-1-picker`);
      expect(await axeIds(page, ".pad-label-links")).toEqual([]);
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

      // Enter keeps the text; the shape draws the links as titles, never addresses.
      await page.keyboard.press("Enter");
      await expect(text).toHaveCount(0);
      await expect(shape.locator("text")).toHaveText(`See Launch plan and ${fresh}`, { timeout: 15_000 });
      await frame(page, `${theme}-3-linked`);
    }

    // What was saved is the [[Title]] link by id.
    await expect.poll(async () => (await heads(page)).find((head) => head.artifact.title === "Map")?.body?.pad?.shapes.find((s) => s.id === "box-dark")?.text, { timeout: 15_000 }).toMatch(
      new RegExp(`^See \\[\\\\\\[\\\\\\[Launch plan\\\\\\]\\\\\\]\\]\\(junto://canvas/${CANVAS}\\?node=shelf&item=${planId}\\) and \\[\\\\\\[\\\\\\[Q3 review`),
    );

    // Enter on the create row and Enter again at once to finish: the finish waits, and the link is kept.
    const last = pad.locator('[data-shape-id="box-bright"]');
    await last.dblclick();
    const again = pad.getByRole("combobox", { name: "Shape text" });
    await expect(again).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.type(" [[Q5 plan");
    await expect(page.getByRole("listbox", { name: "Artifacts to link" }).getByRole("option", { name: "Create document Q5 plan" })).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(again).toHaveCount(0, { timeout: 15_000 });
    await expect(last.locator("text")).toHaveText("See Launch plan and Q4 review Q5 plan", { timeout: 15_000 });
    await expect
      .poll(async () => (await heads(page)).find((head) => head.artifact.title === "Map")?.body?.pad?.shapes.find((s) => s.id === "box-bright")?.text, { timeout: 15_000 })
      .toMatch(/\[\\\[\\\[Q5 plan\\\]\\\]\]\(junto:\/\/canvas\//);

    // A rename shows on the pad at once: the link is by id, the words are the title now.
    await apply(page, planId, { op: "retitle", title: "Launch plan v2" });
    await expect(pad.locator('[data-shape-id="box-dark"] text')).toHaveText("See Launch plan v2 and Q3 review", { timeout: 15_000 });
    await frame(page, "bright-4-renamed");

    // An archived artifact keeps its title and says it is archived.
    const q3 = (await heads(page)).find((head) => head.artifact.title === "Q3 review")!.artifact.artifactId;
    await apply(page, q3, { op: "archive" });
    // The words may wrap onto two lines: read them as one.
    const words = () => pad.locator('[data-shape-id="box-dark"] text tspan').allTextContents().then((lines) => lines.join(" "));
    await expect.poll(words, { timeout: 15_000 }).toBe("See Launch plan v2 and Q3 review, archived");
    await frame(page, "bright-5-archived-and-missing");
  } finally {
    await junto.close();
  }
});
