/**
 * Buckets 1–3 board contract: phase membership, calm vs fire, noise silence.
 *
 * Seeded board:
 * - tasks sink with submitted + input-required items
 * - actor edged via tasks criteria
 * - soft relates edge (no label)
 *
 * Asserts:
 * - submitted alone does not block the actor
 * - input-required blocks the actor (data-blocked + data-attention=fire)
 * - tasks card glance shows in-flight + need input (not seven-chip pile)
 * - soft edge has no "relates" face label
 * - no browser-access wall / pid chrome in inspector for terminal
 */
import type { A2ATask } from "../../src/shared/canvas";
import {
  a2aTask,
  agentTextNode,
  canvasDoc,
  tasksCriteriaEdge,
  tasksNode,
  terminalTextNode,
} from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const CANVAS = "factory-board";

const seededTasks: ReadonlyArray<A2ATask> = [
  a2aTask("open-1", "queue work", "submitted"),
  a2aTask("hot-1", "needs human", "input-required"),
];

test.use({
  vellumOptions: {
    seedCanvases: {
      [CANVAS]: canvasDoc(
        [
          tasksNode({
            id: "tasks",
            x: 40,
            y: 40,
            items: seededTasks,
          }),
          agentTextNode({
            id: "worker",
            key: "local:e2e-worker",
            label: "worker seat",
            x: 360,
            y: 40,
          }),
          terminalTextNode({
            id: "term",
            bindingId: "e2e-term-1",
            label: "shell",
            x: 360,
            y: 200,
          }),
        ],
        [
          tasksCriteriaEdge("e-tasks-worker", "tasks", "worker"),
          // Soft relates — must not paint a RELATES stamp.
          {
            id: "e-soft",
            fromNode: "worker",
            toNode: "term",
            fromSide: "bottom",
            toSide: "top",
          },
        ],
      ),
    },
  },
});

test("factory board: fire on input-required, calm edges silent, tasks glance", async ({
  vellum,
}) => {
  const { page } = vellum;

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

  // Tasks card glance-grade (not seven state chips).
  const tasksCard = page.locator('.react-flow__node[data-id="tasks"]');
  await expect(tasksCard).toBeVisible();
  await expect(tasksCard.getByTestId("tasks-glance")).toContainText("in flight");
  await expect(tasksCard.getByTestId("tasks-glance")).toContainText("need input");
  await expect(tasksCard.locator("text=SUBMITTED")).toHaveCount(0);

  // Actor is blocked by input-required (physics: actors only).
  const workerShell = page.locator('.react-flow__node[data-id="worker"] .vellum-node');
  await expect(workerShell).toHaveAttribute("data-blocked", "true", { timeout: 15_000 });
  await expect(workerShell).toHaveAttribute("data-attention", "fire");

  // Soft relates edge: no face label "relates".
  const relatesStamps = page.locator(".vellum-edge-label", { hasText: /^relates$/i });
  await expect(relatesStamps).toHaveCount(0);

  // Terminal card: no pid dump.
  const term = page.locator('.react-flow__node[data-id="term"]');
  await expect(term).toBeVisible();
  await expect(term.locator("text=/pid \\d+/")).toHaveCount(0);

  // Open terminal inspector — no browser-access instructional wall.
  await term.dblclick();
  await expect(page.locator(".inspector-panel")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("text=/browser access/i")).toHaveCount(0);
  await expect(page.locator("text=/vellum-browser/i")).toHaveCount(0);
  await expect(page.locator("text=/holds keys/i")).toHaveCount(0);
});

test("submitted-only queue does not block edged actor", async ({ vellum }) => {
  const { page } = vellum;

  // Re-seed via IPC if available is heavy; use evaluate to rewrite work store
  // through workTaskTransition when possible — simpler: second test uses
  // a fresh env by replacing task states via window.vellum if exposed.
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

  // Transition hot task to completed so only submitted remains → actor unblocks.
  const hasWork = await page.evaluate(() => typeof window.vellum?.workTaskTransition === "function");
  expect(hasWork).toBe(true);

  const done = await page.evaluate(async () => {
    const res = await window.vellum!.workTaskTransition(
      "factory-board",
      "tasks",
      "hot-1",
      "completed",
    );
    return res;
  });
  expect(done.ok).toBe(true);

  const workerShell = page.locator('.react-flow__node[data-id="worker"] .vellum-node');
  await expect(async () => {
    await expect(workerShell).not.toHaveAttribute("data-blocked", "true");
  }).toPass({ timeout: 15_000 });
});
