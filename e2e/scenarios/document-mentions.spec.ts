/**
 * Mentions in a live document: a mention link is the seat's, task's or
 * artifact's chip in the line, and a bang mention alone on its line is the
 * preview card. Shots in both themes.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { mentionHref } from "../../src/shared/mention";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { taskNodeId } from "../../src/shared/task-model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "doc-mentions";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/document-mentions";
const decode = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" });
const ops = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 1200, height: 500 });
const atlas = modelSeat({ id: "atlas", key: "local:dm-atlas", label: "Atlas", harness: "claude", x: 40, y: 60 });
const board = decode({ kind: "task", id: "board", name: "Ship", x: 400, y: 60, width: 320, height: 220, z: 0 });
const shelf = decode({ kind: "artifacts", id: "shelf", label: "Shelf", x: 760, y: 60, width: 280, height: 160, z: 0 });

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

test("mention links are chips in the line, bang mentions are cards", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([ops, atlas, board, shelf], []) } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    const taskId = mintItemId();
    await page.evaluate(
      ({ canvas, node, taskId, opId }) => window.junto!.resource!.task!.apply(canvas, node, taskId, opId, { kind: "create", taskId, title: "Ship the wire spec" }),
      { canvas: CANVAS, node: taskNodeId(asNodeId("board")), taskId, opId: mintOpId() },
    );
    const pricingId = mintItemId();
    await page.evaluate(
      ({ canvas, node, artifactId, opId }) =>
        window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title: "Pricing pages", body: { type: "document", markdown: "Superset Pro is $16 to $20 a user per month." } }),
      { canvas: CANVAS, node: asNodeId("shelf"), artifactId: pricingId, opId: mintOpId() },
    );
    const seat = mentionHref({ kind: "seat", nodeId: asNodeId("atlas") }, CANVAS);
    const task = mentionHref({ kind: "task", nodeId: asNodeId("board"), taskId }, CANVAS);
    const pricing = mentionHref({ kind: "artifact", nodeId: asNodeId("shelf"), artifactId: pricingId }, CANVAS);
    const markdown = [
      "# Launch plan",
      "",
      `Over to [@Atlas](${seat}) for [#Ship the wire spec](${task}), numbers in [Pricing pages](${pricing}).`,
      "",
      `- [ ] [@Atlas](${seat}) reads the notes`,
      "",
      `![Ship the wire spec](${task})`,
      "",
      `![@Atlas](${seat})`,
      "",
      `![Pricing pages](${pricing})`,
    ].join("\n");
    await page.evaluate(
      ({ canvas, node, artifactId, opId, markdown }) =>
        window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title: "Launch plan", body: { type: "document", markdown } }),
      { canvas: CANVAS, node: asNodeId("shelf"), artifactId: mintItemId(), opId: mintOpId(), markdown },
    );
    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    await page.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: "Launch plan" }).first().click();
    await expect(page.locator(".artifact-head__meta")).toHaveText("Document, version 1", { timeout: 15_000 });

    const chips = page.getByTestId("document-mention-chip");
    await expect(chips).toHaveCount(4, { timeout: 15_000 });
    await expect(page.locator(".cm-md-embed")).toHaveCount(3);
    for (const theme of ["dark", "bright"] as const) {
      await page.evaluate((next) => window.junto!.settingsPatch({ appearance: { theme: next } }), theme);
      // Dark is the base: html carries no data-theme.
      if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
      else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
      await shot(page, `chips-${theme}`);
    }
  } finally {
    await junto.close();
  }
});
