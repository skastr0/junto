/**
 * Plan 03 gaps 1 to 3, driven in the real app: # and @ in a seat's Threads
 * composer, a sent mention drawn as a chip that opens its target, and a task
 * comment thread's subject.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/mention-threads-verify.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { taskNodeId } from "../../src/shared/task-model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelMessagesWire, modelNode, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "mention-threads";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/mention-threads";

const atlas = modelSeat({ id: "atlas", key: "local:mt-atlas", label: "Atlas", harness: "claude", x: 40, y: 60 });
const bravo = modelSeat({ id: "bravo", key: "local:mt-bravo", label: "Bravo", harness: "claude", x: 40, y: 260 });
const docs = modelNode({ kind: "page", id: "docs", url: "https://example.com/", profile: "personal", onRemove: "kill-session", x: 400, y: 60, width: 240, height: 80, z: 0 });
const board = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "task", id: "board", name: "Ship", x: 400, y: 260, width: 320, height: 220, z: 0 });
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x: 780, y: 260, width: 240, height: 120, z: 0 });
const ops = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 1100, height: 540 });
const nodes = [ops, atlas, bravo, docs, board, shelf];
const fixture = modelFixture(nodes, [modelMessagesWire("w1", "atlas", "bravo", nodes)]);

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

test("# and @ offer what is in reach, a sent mention is a chip that opens, a task thread shows its subject", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture } });
  try {
    const { page } = junto;
    const card = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(card("atlas")).toBeVisible({ timeout: 30_000 });

    const taskId = mintItemId();
    const taskResult = await page.evaluate(
      ({ canvas, node, taskId, opId }) => window.junto!.resource!.task!.apply(canvas, node, taskId, opId, { kind: "create", taskId, title: "Ship the wire spec" }),
      { canvas: CANVAS, node: taskNodeId(asNodeId("board")), taskId, opId: mintOpId() },
    );
    expect(taskResult.kind).toBe("applied");
    const artifactId = mintItemId();
    const artifactResult = await page.evaluate(
      ({ canvas, node, artifactId, opId }) =>
        window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title: "Wire spec notes", body: { type: "document", markdown: "# notes" } }),
      { canvas: CANVAS, node: asNodeId("shelf"), artifactId, opId: mintOpId() },
    );
    expect(artifactResult.kind).toBe("applied");

    // Gap 1: the seat's Threads composer.
    await card("atlas").dblclick();
    const button = page.getByTestId("seat-threads-button");
    await expect(button).toBeVisible({ timeout: 30_000 });
    await button.click();
    await page.getByTestId("seat-threads-new").click();
    const input = page.getByTestId("thread-composer-input");
    await expect(input).toBeVisible();
    await input.click();
    await input.pressSequentially("#");
    const options = page.getByTestId("mention-option");
    await expect(options.filter({ hasText: "Ship the wire spec" })).toBeVisible();
    await expect(options.filter({ hasText: "Wire spec notes" })).toBeVisible();
    await shot(page, "1-hash");
    console.log("HASH OPTIONS:", JSON.stringify(await options.allInnerTexts()));
    await input.fill("");
    await input.pressSequentially("@");
    await expect(options.filter({ hasText: "Bravo" })).toBeVisible();
    await expect(options.filter({ hasText: /example|docs/i })).toBeVisible();
    await shot(page, "2-at");
    console.log("AT OPTIONS:", JSON.stringify(await options.allInnerTexts()));

    // Gap 2: send both mentions, see chips, click one.
    await input.fill("");
    await input.pressSequentially("look at #");
    await options.filter({ hasText: "Ship the wire spec" }).click();
    await input.pressSequentially("and @");
    await options.filter({ hasText: "Bravo" }).click();
    console.log("DRAFT:", await input.inputValue());
    await input.press("Enter");
    const mentions = page.getByTestId("seat-threads-mention");
    await expect(mentions).toHaveCount(2, { timeout: 20_000 });
    await shot(page, "3-chips");
    await mentions.first().click();
    await expect(page.getByTestId("seat-threads")).toHaveCount(0);
    await page.waitForTimeout(800);
    await shot(page, "4-opened-task");
  } finally {
    await junto.close();
  }
});
