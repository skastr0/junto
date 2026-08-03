import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasDoc } from "../../src/shared/canvas";
import { canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const CANVAS_NAME = "special-nodes";
const SHOTS = join(process.cwd(), "test-results", "special-nodes-design");

const fixture = (): CanvasDoc =>
  canvasDoc(
    [
      {
        id: "cron",
        type: "text",
        text: "cron",
        x: 40,
        y: 80,
        width: 210,
        height: 116,
        ether: {
          entity: { kind: "cron" },
          host: "local",
          timer: { everyMinutes: 30 },
        },
      },
      {
        id: "gauge",
        type: "text",
        text: "gauge",
        x: 320,
        y: 80,
        width: 240,
        height: 104,
        ether: {
          entity: { kind: "watcher" },
          host: "local",
          watch: {
            kind: "stat_threshold",
            source: "hermes",
            key: "local:worker",
            stat: "cpu",
            op: "gt",
            value: 80,
          },
        },
      },
      {
        id: "relay",
        type: "text",
        text: "relay",
        x: 630,
        y: 80,
        width: 220,
        height: 104,
        ether: {
          entity: { kind: "relay" },
          host: "local",
          relay: {
            sourceNodeId: "tasks",
            path: "task_state",
            equals: "completed",
          },
        },
      },
      {
        id: "page",
        type: "link",
        url: "https://example.com",
        x: 930,
        y: 70,
        width: 270,
        height: 120,
        ether: {
          entity: { kind: "page" },
          host: "local",
          browser: { profile: "personal", onDelete: "kill-session" },
        },
      },
      tasksNode({ id: "tasks", x: 500, y: 300, items: [] }),
    ],
    [
      {
        id: "cron-effect",
        fromNode: "cron",
        toNode: "tasks",
        ether: { effect: { mode: "enqueue_task", brief: "scheduled review" } },
      },
      {
        id: "gauge-effect",
        fromNode: "gauge",
        toNode: "tasks",
        ether: { effect: { mode: "enqueue_task", brief: "inspect threshold" } },
      },
      {
        id: "relay-effect",
        fromNode: "relay",
        toNode: "tasks",
        ether: { effect: { mode: "enqueue_task", brief: "continue workflow" } },
      },
    ],
  );

test.use({
  vellumOptions: {
    seedCanvases: { [CANVAS_NAME]: fixture() },
  },
});

test("special nodes keep distinct flat silhouettes", async ({ vellum }) => {
  const { page } = vellum;
  await mkdir(SHOTS, { recursive: true });

  for (const id of ["cron", "gauge", "relay", "page"]) {
    const node = page.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(node).toBeVisible({ timeout: 30_000 });
    await expect(node.locator('.vellum-node[data-surface="special"]')).toBeVisible();
  }

  await page.getByRole("button", { name: /fit all/i }).click();
  await page.waitForTimeout(700);
  await page.screenshot({
    path: join(SHOTS, "01-flat-special-nodes.png"),
    fullPage: false,
  });
});
