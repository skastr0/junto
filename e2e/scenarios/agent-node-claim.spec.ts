/**
 * An actor drawn as an agent node must say what it is working, on the node
 * itself — the canvas is where the operator looks, and opening a surface to
 * find out which task a seat holds is the attrition this removes.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  agentTextNode,
  canvasDoc,
  tasksCriteriaEdge,
  tasksNode,
} from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "design-audit");

const fixtureDoc = canvasDoc(
  [
    tasksNode({ id: "tasks", x: 40, y: 40 }),
    agentTextNode({
      id: "worker",
      key: "local:worker",
      label: "Claude Code · opus",
      x: 40,
      y: 260,
    }),
  ],
  [tasksCriteriaEdge("e-tasks", "tasks", "worker")],
);

test("an agent node shows the task its seat has claimed", async () => {
  await mkdir(SHOTS, { recursive: true });
  const vellum = await launchVellum();

  try {
    const { page } = vellum;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    const canvas = await page.evaluate(async (document) => {
      const api = window.vellum!;
      const list = await api.listCanvases();
      const name = list[0]?.name ?? (await api.createCanvas("work")).name;
      const read = await api.readCanvas(name);
      await api.writeCanvas(name, document, read.revision);
      return name;
    }, fixtureDoc);

    const node = page.locator(".react-flow__node", { hasText: "Claude Code" });
    await expect(node).toBeVisible({ timeout: 30_000 });
    // Nothing claimed yet: the line is absent, not an empty placeholder.
    await expect(node.getByTestId("claimed-task")).toHaveCount(0);

    // The claimant is the compiled seat for this node — node identity alone is
    // never claim authority, so the strip must resolve through the projection.
    const seatId = await page.evaluate(async (name) => {
      const read = await window.vellum!.readCanvas(name);
      return read.actorRefs.find((actor) => actor.nodeId === "worker")?.seatId;
    }, canvas);
    expect(seatId, "the agent node must compile to exactly one actor seat")
      .toBeTruthy();

    const created = await page.evaluate(
      ([name]) => window.vellum!.workTaskCreate(name, "tasks", "Display claim task on the node"),
      [canvas] as const,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const claimed = await page.evaluate(
      ([name, taskId, actor]) =>
        window.vellum!.workTaskClaim(name, "tasks", taskId, actor),
      [canvas, created.data.id, "worker"] as const,
    );
    expect(JSON.stringify(claimed)).toContain('"ok":true');

    await expect(node.getByText("Display claim task on the node")).toBeVisible({
      timeout: 15_000,
    });

    await page.screenshot({
      path: join(SHOTS, "21a-agent-node-claim.png"),
      fullPage: false,
    });
  } finally {
    await vellum.close();
  }
});
