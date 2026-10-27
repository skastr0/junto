/**
 * Real-app verify of the board Targets panel: a board lists its outgoing task
 * wires, the Flows / Derives toggle rewrites the wire's verb in the model, and
 * a toggle that would close a derives loop is refused with its reason under
 * the row. Frames land in test-results/board-targets/.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { taskNodeId } from "../../src/shared/task-model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelWire, readModelCanvas } from "../harness/model";

const CANVAS = "verify-targets";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/board-targets";
const decode = (input: unknown): Node => Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })(input);
const at = (x: number, y: number) => ({ x, y, width: 300, height: 200, z: 0 });
const nodes: Node[] = [
  decode({ kind: "task", id: "build", name: "Build", ...at(60, 70) }),
  decode({ kind: "task", id: "review", name: "Review", ...at(560, 70) }),
  decode({ kind: "task", id: "docs", name: "Docs", ...at(560, 400) }),
];
const wires = [
  modelWire("build-review", "build", "review", "flows", nodes),
  modelWire("build-docs", "build", "docs", "derives", nodes),
  modelWire("review-docs", "review", "docs", "derives", nodes),
  modelWire("docs-build", "docs", "build", "flows", nodes),
];

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};
/** An empty board opens its new-task form; a board with one task opens the list, and the settings are one press away. */
const seedTask = async (page: Page, board: string): Promise<void> => {
  const taskId = mintItemId();
  const nodeId = taskNodeId(asNodeId(board));
  const outcome = await page.evaluate(
    ({ canvas, nodeId, taskId, opId }) => window.junto!.resource!.task!.apply(canvas, nodeId, taskId, opId, { kind: "create", taskId, title: "A task" }),
    { canvas: CANVAS, nodeId, taskId, opId: mintOpId() },
  );
  expect(JSON.stringify(outcome)).not.toContain("refused");
  await expect
    .poll(() => page.evaluate(({ canvas, nodeId }) => window.junto!.resource!.task!.list(canvas, nodeId).then((tasks) => tasks.length), { canvas: CANVAS, nodeId }), { timeout: 15_000 })
    .toBe(1);
};
const verbs = async (page: Page): Promise<string[]> =>
  (await readModelCanvas(page, CANVAS)).wires.map((wire) => `${wire.from} ${wire.verb} ${wire.to}`).sort();

test("board targets: list, toggle rewrites the verb, a derives loop is refused", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture(nodes, wires) } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="build"]')).toBeVisible({ timeout: 30_000 });
    await seedTask(page, "build");
    await seedTask(page, "docs");
    // The card's centre can be its add-task button; press the corner instead.
    await page.locator('.react-flow__node[data-id="build"]').dblclick({ position: { x: 10, y: 10 } });
    await page.getByRole("button", { name: "Board settings" }).click();
    const targets = page.getByTestId("board-targets");
    await expect(targets).toBeVisible({ timeout: 15_000 });
    await expect(targets.getByRole("listitem")).toHaveCount(2);
    await shot(page, "1-targets");

    await targets.getByRole("radiogroup", { name: /Review/ }).getByRole("radio", { name: "Derives" }).click();
    await expect.poll(() => verbs(page)).toContain("build derives review");
    await shot(page, "2-review-derives");

    // Build already derives to Docs, so Docs deriving back to Build closes a loop.
    await page.keyboard.press("Escape");
    await page.locator('.react-flow__node[data-id="docs"]').dblclick({ position: { x: 10, y: 10 } });
    await page.getByRole("button", { name: "Board settings" }).click();
    const docs = page.getByTestId("board-targets");
    await docs.getByRole("radiogroup", { name: /Build/ }).getByRole("radio", { name: "Derives" }).click();
    await expect(docs.getByRole("alert")).toContainText("would create a cycle", { timeout: 15_000 });
    await expect.poll(() => verbs(page)).toContain("docs flows build");
    await shot(page, "3-refused");
  } finally {
    await junto.close();
  }
});
