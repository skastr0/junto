/**
 * Real-app verify of 92a8ced55 and 2517d7eca: a comment on selected, still
 * unsaved text saves the document first; a save refused by a second writer
 * stops the post in words.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { ArtifactVersion } from "../../src/shared/artifact";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const CANVAS = "verify-doc";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifact-comment-unsaved";
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x: 60, y: 60, width: 280, height: 160, z: 0 });

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const newDocument = async (page: Page): Promise<void> => {
  await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
  await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "New artifact" }).click();
  await page.getByRole("group", { name: "New artifact" }).locator("button").filter({ hasText: "Document" }).click();
  await expect(page.locator(".artifact-head__meta")).toHaveText("Document, version 1", { timeout: 15_000 });
};

/** Select the last `count` characters of the source with the keyboard, as an operator would. */
const selectTail = async (page: Page, count: number): Promise<void> => {
  const source = page.getByLabel("Markdown");
  await source.click();
  await page.keyboard.press("Meta+ArrowDown");
  for (let i = 0; i < count; i += 1) await page.keyboard.press("Shift+ArrowLeft");
};

test("92a8ced55: type, select at once, Comment on selection, post: it posts on that quote", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([shelf], []) } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    await newDocument(page);
    const source = page.getByLabel("Markdown");
    await source.click();
    await source.pressSequentially("Fresh unsaved sentence to quote");
    // At once: no wait for the 800 ms rest.
    await selectTail(page, 12);
    const comment = page.getByRole("button", { name: "Comment on selection" });
    await expect(comment).toBeVisible();
    await comment.click();
    const composer = page.getByLabel("New comment");
    await expect(page.locator(".artifact-comments__anchor")).toContainText("to quote");
    await composer.fill("Quoting the unsaved line");
    await shot(page, "doc-1-anchored-before-post");
    await page.locator(".artifact-comments").getByRole("button", { name: "Comment", exact: true }).click();
    const threads = page.getByRole("list", { name: "Threads" });
    await expect(threads.locator(".artifact-thread__post")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator(".artifact-comments__refusal")).toHaveCount(0);
    const thread = await threads.innerText();
    console.log("REPORT case1 thread:", JSON.stringify(thread.slice(0, 200)));
    expect(thread).toContain("Quoting the unsaved line");
    expect(thread).toContain("to quote");
    await expect(page.locator(".artifact-head__meta")).toHaveText(/Document, version [2-9]/);
    await shot(page, "doc-2-posted-on-quote");
  } finally {
    await junto.close();
  }
});

test("92a8ced55: a second writer moves the head while typing is unsent: the post stops in words", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([shelf], []) } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    const docId = mintItemId();
    const made = await page.evaluate(
      ({ canvas, node, artifactId, opId }) =>
        window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title: "Shared doc", body: { type: "document", markdown: "Seed text." } }),
      { canvas: CANVAS, node: asNodeId("shelf"), artifactId: docId, opId: mintOpId() },
    );
    console.log("CREATE:", JSON.stringify(made).slice(0, 200));
    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: "Shared doc" }).first().click();
    await expect(page.locator(".artifact-head__meta")).toHaveText("Document, version 1", { timeout: 15_000 });
    const source = page.getByLabel("Markdown");
    await source.click();
    await selectTail(page, 0);
    await source.pressSequentially(" Operator typing that is not sent yet");
    // The other writer lands on the head from version 1 before the operator's text is saved.
    const landed = await page.evaluate(
      ({ canvas, node, artifactId, baseVersion, opId }) =>
        window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, {
          op: "edit",
          edit: { kind: "replace", baseVersion, body: { type: "document", markdown: "Another writer moved the head." } },
        }),
      { canvas: CANVAS, node: asNodeId("shelf"), artifactId: docId as never, baseVersion: ArtifactVersion.make(1), opId: mintOpId() },
    );
    console.log("OTHER WRITE:", JSON.stringify(landed).slice(0, 200));
    // Put text back under the cursor and select part of it.
    await selectTail(page, 10);
    await page.getByRole("button", { name: "Comment on selection" }).click();
    await page.getByLabel("New comment").fill("Should not post");
    await page.locator(".artifact-comments").getByRole("button", { name: "Comment", exact: true }).click();
    const refusal = page.locator(".artifact-comments__refusal");
    await expect(refusal).toBeVisible({ timeout: 20_000 });
    const text = (await refusal.innerText()).trim();
    console.log("REPORT case2 refusal:", JSON.stringify(text));
    expect(text).toMatch(/^Not posted: the document did not save \(.+\)\. Choose Overwrite theirs or Take theirs above, then post again\.$/);
    await expect(page.locator(".artifact-document__refusal")).toBeVisible();
    await expect(page.getByRole("list", { name: "Threads" }).locator(".artifact-thread__post")).toHaveCount(0);
    await shot(page, "doc-3-not-posted");
  } finally {
    await junto.close();
  }
});
