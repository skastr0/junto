/**
 * Buckets 1–3 board contract.
 *
 * Seeds authored topology and durable work rows through the harness's scoped
 * SQLite runtime before Electron starts:
 * - tasks sink with a submitted item + an input-required item claimed by the worker
 * - actor edged via tasks criteria
 * - an unblocked publish wire (must not stamp RELATES)
 *
 * Asserts calm/fire phase membership, tasks glance, noise silence.
 *
 * The terminal card sits unwired on purpose: terminal admits no verb, so a
 * wire into it is not a "soft edge" — it is an edge the product drops.
 */
import type { Task, CanvasDoc } from "../../src/shared/canvas";
import {
  artifactsNode,
  claimByNodeId,
  taskItem,
  agentTextNode,
  canvasDoc,
  verbEdge,
  tasksNode,
  terminalTextNode,
} from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const seededTasks: ReadonlyArray<Task> = [
  taskItem("open-1", "queue work", "submitted"),
  // Blocking is worker-state: only a CLAIMED attention task stops its
  // claimant. Claims address the node id.
  {
    ...taskItem("hot-1", "needs human", "input-required"),
    claimedBy: claimByNodeId("worker"),
  },
];

const fixtureNodes = [
  tasksNode({ id: "tasks", x: 40, y: 40, items: seededTasks }),
  agentTextNode({
    id: "worker",
    key: "local:e2e-worker",
    label: "worker seat",
    x: 360,
    y: 40,
  }),
  artifactsNode({ id: "shelf", x: 680, y: 40, items: [] }),
  terminalTextNode({
    id: "term",
    bindingId: "e2e-term-1",
    label: "shell",
    x: 360,
    y: 200,
  }),
];

const fixtureDoc = (): CanvasDoc =>
  canvasDoc(fixtureNodes, [
    verbEdge("e-tasks-worker", "tasks", "worker", "works", fixtureNodes),
    // The unblocked leg: a real wire that renders and stays quiet, since
    // nothing on the artifacts shelf can stop a seat.
    verbEdge("e-worker-shelf", "worker", "shelf", "publishes", fixtureNodes),
  ]);

const CANVAS_NAME = "factory-board";

test.use({
  vellumOptions: {
    seedCanvases: {
      [CANVAS_NAME]: fixtureDoc(),
    },
  },
});

test("factory board: fire on claimed input-required, calm edges silent, tasks glance", async ({
  vellumCommand,
}) => {
  const { page } = vellumCommand;

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

  const tasksCard = page.locator('.react-flow__node[data-id="tasks"]');
  await expect(tasksCard).toBeVisible({ timeout: 30_000 });
  await expect(tasksCard.getByTestId("tasks-glance")).toContainText("in flight");
  await expect(tasksCard.getByTestId("tasks-glance")).toContainText("need input");
  await expect(tasksCard.locator("text=SUBMITTED")).toHaveCount(0);

  const workerShell = page.locator('.react-flow__node[data-id="worker"] .vellum-node');
  await expect(workerShell).toHaveAttribute("data-blocked", "true", { timeout: 15_000 });
  await expect(workerShell).toHaveAttribute("data-attention", "fire");

  // The permanent notify strip must include both the blocked claimant and
  // the attention-bearing sink, even though neither node is inside a region.
  const attentionPills = page.getByTestId("notify-attention-pills");
  await expect(attentionPills).toBeVisible({ timeout: 15_000 });
  await expect(attentionPills).toContainText("worker");
  await expect(attentionPills).toContainText("queue work");

  // The publish wire renders, and unblocked wires stay silent — no face
  // label text "relates" on edge chips.
  await expect(page.locator('[data-testid="rf__edge-e-worker-shelf"]')).toHaveCount(1, {
    timeout: 15_000,
  });
  const edgeFace = await page.locator(".vellum-edge-label").allTextContents();
  expect(edgeFace.every((t) => t.trim().toLowerCase() !== "relates")).toBe(true);

  const term = page.locator('.react-flow__node[data-id="term"]');
  await expect(term).toBeVisible();
  await expect(term.locator("text=/pid \\d+/")).toHaveCount(0);

  // Kind surface replaced the old sidebar inspector. Shell nodes keep no
  // fields sheet (config is kind-strip pops, rename is pencil), so the
  // legacy browser-access fields must never resurface.
  await term.click();
  await expect(page.locator(".rts-kind-surface")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".rts-kind-kind-label")).toContainText("terminal");
  await expect(page.getByRole("button", { name: "Open fields" })).toHaveCount(0);
  await expect(page.locator(".rts-kind-form-panel")).toHaveCount(0);
  await expect(page.locator("text=/browser access/i")).toHaveCount(0);
  await expect(page.locator("text=/vellum-command-browser/i")).toHaveCount(0);
  await expect(page.locator("text=/holds keys/i")).toHaveCount(0);
});

test("submitted-only queue does not block edged actor", async ({ vellumCommand }) => {
  const { page } = vellumCommand;

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

  await expect(page.locator('.react-flow__node[data-id="worker"]')).toBeVisible({
    timeout: 30_000,
  });

  const done = await page.evaluate(
    async ({ name }) => {
      const api = (
        globalThis as unknown as {
          readonly vellumCommand: {
            readonly workTaskTransition: (
              canvas: string,
              nodeId: string,
              taskId: string,
              state: string,
            ) => Promise<{ ok: boolean; code?: string; message?: string }>;
          };
        }
      ).vellumCommand;
      return api.workTaskTransition(name, "tasks", "hot-1", "completed");
    },
    { name: CANVAS_NAME },
  );
  expect(done.ok, done.message ?? done.code).toBe(true);

  const workerShell = page.locator('.react-flow__node[data-id="worker"] .vellum-node');
  await expect(async () => {
    await expect(workerShell).not.toHaveAttribute("data-blocked", "true");
  }).toPass({ timeout: 15_000 });
});
