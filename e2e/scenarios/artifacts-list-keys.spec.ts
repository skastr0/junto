/** Isolates the list keys (948c4f0c7) with three plain documents, no pad. */
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const CANVAS = "list-keys";
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x: 60, y: 60, width: 280, height: 160, z: 0 });

test("list keys with three documents", async () => {
  test.setTimeout(120_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([shelf], []) } });
  const log: unknown[] = [];
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    for (const title of ["Alpha", "Bravo", "Charlie"]) {
      await page.evaluate(
        ({ canvas, node, artifactId, opId, title }) =>
          window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title, body: { type: "document", markdown: "Seed." } }),
        { canvas: CANVAS, node: asNodeId("shelf"), artifactId: mintItemId(), opId: mintOpId(), title },
      );
    }
    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    const list = page.getByRole("list", { name: "Artifacts" });
    await expect(list).toBeVisible({ timeout: 20_000 });
    const rows = await list.locator("button").evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.split("\n")[0]));
    log.push({ rows });
    const state = () =>
      page.evaluate(() => ({
        picked: (document.querySelector(".artifact-head [aria-label='Title']") as HTMLInputElement | null)?.value ?? null,
        active: (document.activeElement as HTMLElement | null)?.innerText?.split("\n")[0] ?? (document.activeElement?.tagName ?? null),
        inList: document.activeElement?.closest("[role='list']") !== null && document.activeElement?.closest("[role='list']") !== undefined,
      }));
    await list.locator("button").first().click();
    await page.waitForTimeout(500);
    log.push({ afterClickFirst: await state() });
    for (const key of ["ArrowDown", "ArrowDown", "ArrowUp", "Enter"]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(700);
      log.push({ [key]: await state(), pane: await page.evaluate(() => (document.activeElement?.closest(".two-pane__main") ? "content" : document.activeElement?.closest(".two-pane__sidebar") ? "list" : "other")) });
    }
    console.log("LISTKEYS", JSON.stringify(log, null, 1));
  } finally {
    await junto.close();
  }
});
