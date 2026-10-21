/**
 * A task comment posted in the task pane is listed (author You, age), still
 * there after the window reloads, and an @ mention of a seat in reach is a chip.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/task-comment-reload.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { taskNodeId } from "../../src/shared/task-model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "task-comment-reload";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/task-comment-reload";

const atlas = modelSeat({ id: "atlas", key: "local:tc-atlas", label: "Atlas", harness: "claude", x: 40, y: 60 });
const board = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "task", id: "board", name: "Ship", x: 400, y: 60, width: 320, height: 220, z: 0 });
const ops = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 800, height: 400 });
const fixture = modelFixture([ops, atlas, board], []);

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const openTask = async (page: Page, title: string): Promise<void> => {
  const card = page.locator('.react-flow__node[data-id="board"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.dblclick();
  await page.getByRole("list", { name: "Tasks" }).locator("button").filter({ hasText: title }).first().click();
  await expect(page.getByTestId("task-thread")).toBeVisible({ timeout: 20_000 });
};

test("a task comment is listed, survives a reload, and an @ seat is a chip", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture } });
  try {
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "bright" } }));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");

    const taskId = mintItemId();
    const created = await page.evaluate(
      ({ canvas, node, taskId, opId }) => window.junto!.resource!.task!.apply(canvas, node, taskId, opId, { kind: "create", taskId, title: "Ship the wire spec" }),
      { canvas: CANVAS, node: taskNodeId(asNodeId("board")), taskId, opId: mintOpId() },
    );
    expect(created.kind).toBe("applied");

    await openTask(page, "Ship the wire spec");
    const thread = page.getByTestId("task-thread");
    const field = thread.getByLabel("Comment on this task");
    await field.click();
    await field.pressSequentially("The wire spec reads clean, ship it");
    await field.press("Enter");
    const posts = page.getByTestId("task-thread-post");
    await expect(posts).toHaveCount(1, { timeout: 20_000 });
    await expect(posts.first()).toContainText("The wire spec reads clean, ship it");
    console.log("POST BEFORE RELOAD:", await posts.first().innerText());
    await shot(page, "1-comment-posted");

    await page.reload();
    await openTask(page, "Ship the wire spec");
    await expect(posts).toHaveCount(1, { timeout: 20_000 });
    await expect(posts.first()).toContainText("The wire spec reads clean, ship it");
    console.log("POST AFTER RELOAD:", await posts.first().innerText());
    await shot(page, "2-after-reload");

    await field.click();
    await field.pressSequentially("over to @");
    const options = page.getByTestId("mention-option");
    await expect(options.filter({ hasText: "Atlas" })).toBeVisible({ timeout: 10_000 });
    await shot(page, "3-at-options");
    await options.filter({ hasText: "Atlas" }).click();
    await field.pressSequentially(" for the merge");
    await field.press("Enter");
    await expect(posts).toHaveCount(2, { timeout: 20_000 });
    const chip = posts.nth(1).getByRole("button", { name: /Atlas/ });
    await expect(chip).toBeVisible();
    console.log("MENTION POST:", await posts.nth(1).innerText());
    await shot(page, "4-mention-chip");
  } finally {
    await junto.close();
  }
});
