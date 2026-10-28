/**
 * 0.11 artifact labels, T3, in the real app: Cmd+P in the Artifacts modal
 * ranks a label after the title, as metadata, and each row's quieter line
 * names the labels it carries so a label hit is legible. Two labelled
 * artifacts, one found by its title and one only by its label, the title hit
 * first; a word only a label carries still finds its artifact; an artifact
 * with no labels keeps the type alone. Shots in both themes.
 *   scripts/with-app-run-lock.sh scripts/run-e2e.sh e2e/scenarios/artifacts-palette-labels.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const CANVAS = "artifacts-palette-labels";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? join(process.cwd(), "test-results", "artifacts-palette-labels");
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

test("Cmd+P finds an artifact by its label and ranks it under the artifact whose title carries the word, dark and bright", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [CANVAS]: modelFixture([shelf]) },
  });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    const node = asNodeId("shelf");
    const create = (title: string, labels: ReadonlyArray<string>) =>
      page.evaluate(
        ({ canvas, node, artifactId, opId, title, labels }) =>
          window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, {
            op: "create",
            title,
            body: { type: "document", markdown: `# ${title}` },
            labels,
          }),
        { canvas: CANVAS, node, artifactId: mintItemId(), opId: mintOpId(), title, labels },
      );
    expect((await create("Launch plan", ["release"])).kind).toBe("applied");
    // No "plan" anywhere in this title: only its label can find it under that query.
    expect((await create("Storytelling", ["planning"])).kind).toBe("applied");
    // No labels: its row keeps the type alone on the quieter line.
    expect((await create("Shelf notes", [])).kind).toBe("applied");

    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });

    const palette = page.getByTestId("quick-open");
    const field = page.getByTestId("quick-open-input");
    const titles = palette.locator(".quick-open__row-title");
    const details = palette.locator(".quick-open__row-detail");

    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await page.keyboard.press("Meta+p");
    await expect(palette).toBeVisible();
    await expect(field).toBeFocused();

    // "plan" is a word in Launch plan and only a label on Storytelling: a title
    // hit leads a metadata one, and each row's quieter line says what it carries.
    await field.fill("plan");
    await expect(titles).toHaveText(["Launch plan", "Storytelling"]);
    await expect(details).toHaveText(["Document, release", "Document, planning"]);
    await expect(palette.locator('[data-active="true"]')).toContainText("Launch plan");

    mkdirSync(SHOTS, { recursive: true });
    for (const theme of ["dark", "bright"] as const) {
      await page.evaluate((next) => window.junto!.settingsPatch({ appearance: { theme: next } }), theme);
      await expect(palette).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, `plan-${theme}.png`) });
    }

    // Enter opens the row the ranking put first.
    await page.keyboard.press("Enter");
    await expect(palette).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Launch plan, document" })).toBeVisible({ timeout: 10_000 });

    // A word only the label carries finds the artifact all the same.
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await page.keyboard.press("Meta+p");
    await expect(palette).toBeVisible();
    await field.fill("release");
    await expect(titles).toHaveText(["Launch plan"]);
    await expect(details).toHaveText(["Document, release"]);

    // An artifact with no labels reads as it always did: the type alone.
    await field.fill("shelf");
    await expect(titles).toHaveText(["Shelf notes"]);
    await expect(details).toHaveText(["Document"]);
  } finally {
    await junto.close();
  }
});
