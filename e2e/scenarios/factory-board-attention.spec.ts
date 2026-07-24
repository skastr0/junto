/**
 * Buckets 1–3 board contract (authority install — disk seed is not live map).
 *
 * Installs a board via app write path after boot:
 * - tasks sink with submitted + input-required items
 * - actor edged via tasks criteria
 * - soft relates edge (must not stamp RELATES)
 *
 * Asserts calm/fire phase membership, tasks glance, noise silence.
 */
import type { Task, CanvasDoc } from "../../src/shared/canvas";
import {
  taskItem,
  agentTextNode,
  canvasDoc,
  tasksCriteriaEdge,
  tasksNode,
  terminalTextNode,
} from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const seededTasks: ReadonlyArray<Task> = [
  taskItem("open-1", "queue work", "submitted"),
  taskItem("hot-1", "needs human", "input-required"),
];

const fixtureDoc = (): CanvasDoc =>
  canvasDoc(
    [
      tasksNode({ id: "tasks", x: 40, y: 40, items: seededTasks }),
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
      {
        id: "e-soft",
        fromNode: "worker",
        toNode: "term",
        fromSide: "bottom",
        toSide: "top",
      },
    ],
  );

/** Authority-only: write fixture into the boot canvas (list[0]). */
const installBoard = async (
  page: import("@playwright/test").Page,
  doc: CanvasDoc,
): Promise<string> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const runtime = globalThis as unknown as {
            readonly vellum?: { readonly listCanvases: () => Promise<unknown[]> };
          };
          return Boolean(runtime.vellum?.listCanvases);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);

  return page.evaluate(async (document) => {
    const api = (
      globalThis as unknown as {
        readonly vellum: {
          readonly listCanvases: () => Promise<ReadonlyArray<{ name: string }>>;
          readonly createCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly readCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly writeCanvas: (
            name: string,
            doc: unknown,
            expectedRevision?: string,
          ) => Promise<unknown>;
        };
      }
    ).vellum;
    let list = await api.listCanvases();
    let name = list[0]?.name;
    if (!name) {
      const created = await api.createCanvas("factory-board");
      name = created.name;
    }
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
    return name;
  }, doc);
};

test("factory board: fire on input-required, calm edges silent, tasks glance", async ({
  vellum,
}) => {
  const { page } = vellum;

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page, fixtureDoc());

  const tasksCard = page.locator('.react-flow__node[data-id="tasks"]');
  await expect(tasksCard).toBeVisible({ timeout: 30_000 });
  await expect(tasksCard.getByTestId("tasks-glance")).toContainText("in flight");
  await expect(tasksCard.getByTestId("tasks-glance")).toContainText("need input");
  await expect(tasksCard.locator("text=SUBMITTED")).toHaveCount(0);

  const workerShell = page.locator('.react-flow__node[data-id="worker"] .vellum-node');
  await expect(workerShell).toHaveAttribute("data-blocked", "true", { timeout: 15_000 });
  await expect(workerShell).toHaveAttribute("data-attention", "fire");

  // Soft edges stay silent — no face label text "relates" on edge chips.
  const edgeFace = await page.locator(".vellum-edge-label").allTextContents();
  expect(edgeFace.every((t) => t.trim().toLowerCase() !== "relates")).toBe(true);

  const term = page.locator('.react-flow__node[data-id="term"]');
  await expect(term).toBeVisible();
  await expect(term.locator("text=/pid \\d+/")).toHaveCount(0);

  await term.dblclick();
  await expect(page.locator(".inspector-panel")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("text=/browser access/i")).toHaveCount(0);
  await expect(page.locator("text=/vellum-browser/i")).toHaveCount(0);
  await expect(page.locator("text=/holds keys/i")).toHaveCount(0);
});

test("submitted-only queue does not block edged actor", async ({ vellum }) => {
  const { page } = vellum;

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  const canvasName = await installBoard(page, fixtureDoc());

  await expect(page.locator('.react-flow__node[data-id="worker"]')).toBeVisible({
    timeout: 30_000,
  });

  const done = await page.evaluate(
    async ({ name }) => {
      const api = (
        globalThis as unknown as {
          readonly vellum: {
            readonly workTaskTransition: (
              canvas: string,
              nodeId: string,
              taskId: string,
              state: string,
            ) => Promise<{ ok: boolean; code?: string; message?: string }>;
          };
        }
      ).vellum;
      return api.workTaskTransition(name, "tasks", "hot-1", "completed");
    },
    { name: canvasName },
  );
  expect(done.ok, done.message ?? done.code).toBe(true);

  const workerShell = page.locator('.react-flow__node[data-id="worker"] .vellum-node');
  await expect(async () => {
    await expect(workerShell).not.toHaveAttribute("data-blocked", "true");
  }).toPass({ timeout: 15_000 });
});
