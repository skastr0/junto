/**
 * Every open through openWorkDetail lands (23d5c772b). With the Artifacts
 * modal still up, a mention in a document's body opens its target; after the
 * operator picks the source again, the same mention opens the target again.
 * Before the fix the second open named the item the modal was last opened
 * on, so nothing moved and the modal stayed on the source.
 *
 * A Linked from chip would not catch this: it closes the modal before it
 * opens, and a fresh mount always lands. Only an open made while the modal is
 * up shows it, so this one follows a body mention.
 *   bun run test:e2e:fast e2e/scenarios/artifacts-follow-open.spec.ts
 */
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId, type ItemId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const CANVAS = "artifacts-follow-open";
const SHELF = "shelf";
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({
  kind: "artifacts",
  id: SHELF,
  label: "Shelf",
  x: 60,
  y: 60,
  width: 280,
  height: 160,
  z: 0,
});

const seedDocument = async (page: Page, artifactId: ItemId, title: string, markdown: string): Promise<void> => {
  const result = await page.evaluate(
    ({ canvas, node, artifactId, opId, title, markdown }) =>
      window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title, body: { type: "document", markdown } }),
    { canvas: CANVAS, node: asNodeId(SHELF), artifactId, opId: mintOpId(), title, markdown },
  );
  // A refused seed would leave the list empty and fail later at a pick, far from the cause.
  expect(result, "main applies the seed").toMatchObject({ kind: "applied" });
};

test("a body mention opens its target again after the operator picked the source in the open modal", async () => {
  test.setTimeout(120_000);
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([shelf]) } });
  const errors: string[] = [];
  junto.page.on("pageerror", (error) => errors.push(error.message));
  try {
    const { page } = junto;
    await page.waitForFunction(() => Boolean(window.junto?.resource?.artifact), undefined, { timeout: 30_000 });
    const card = page.locator(`.react-flow__node[data-id="${SHELF}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    const target = mintItemId();
    await seedDocument(page, target, "Target note", "The target.\n");
    await seedDocument(page, mintItemId(), "Source doc", `See [Target note](junto://canvas/${CANVAS}?node=${SHELF}&item=${target}) for the plan.\n`);

    await card.dblclick();
    const list = page.getByRole("list", { name: "Artifacts" });
    await expect(list).toBeVisible({ timeout: 20_000 });
    const title = page.locator(".artifact-head__title");
    const pick = async (name: string): Promise<void> => {
      await list.locator("button").filter({ hasText: name }).first().click();
      await expect(title).toHaveValue(name, { timeout: 10_000 });
    };
    const mention = page.getByTestId("document-mention-chip").first();

    await pick("Source doc");
    await expect(mention).toBeVisible({ timeout: 15_000 });
    await mention.click();
    await expect(title).toHaveValue("Target note", { timeout: 10_000 });

    // Back to the source inside the same modal, and the same mention again: the same item, a new open.
    await pick("Source doc");
    await mention.click();
    await expect(title).toHaveValue("Target note", { timeout: 5_000 });
    expect(errors).toEqual([]);
  } finally {
    await junto.close();
  }
});
