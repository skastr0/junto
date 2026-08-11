/**
 * Completed-task notify stack chrome — solid plate, stacked cards, no dissolve.
 *
 *   bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/completed-task-notify.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "completed-task-notify");

const fixtureDoc = canvasDoc([tasksNode({ id: "tasks", x: 80, y: 80 })]);

const installBoard = async (page: import("@playwright/test").Page): Promise<void> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          Boolean(
            (globalThis as unknown as { vellumCommand?: { listCanvases?: unknown } })
              .vellumCommand?.listCanvases,
          ),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);

  await page.evaluate(async (document) => {
    const api = (
      globalThis as unknown as {
        readonly vellumCommand: {
          readonly listCanvases: () => Promise<ReadonlyArray<{ name: string }>>;
          readonly createCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly readCanvas: (name: string) => Promise<{ revision: string }>;
          readonly writeCanvas: (
            name: string,
            doc: unknown,
            expectedRevision?: string,
          ) => Promise<unknown>;
        };
      }
    ).vellumCommand;
    let list = await api.listCanvases();
    let name = list[0]?.name;
    if (!name) {
      const created = await api.createCanvas("completed-notify");
      name = created.name;
    }
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
  }, fixtureDoc);
};

test("completed task notify plate has solid boundaries and stacks cards", async ({
  vellumCommand,
}) => {
  const { page } = vellumCommand;
  await mkdir(SHOTS, { recursive: true });

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page);
  await page.waitForTimeout(400);

  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          typeof (
            globalThis as unknown as {
              __vellumTestInjectCompletedNotify?: unknown;
            }
          ).__vellumTestInjectCompletedNotify === "function",
        ),
      { timeout: 15_000 },
    )
    .toBe(true);

  await page.evaluate(() => {
    (
      globalThis as unknown as {
        __vellumTestInjectCompletedNotify: (
          items: ReadonlyArray<{ id: string; nodeId: string; brief: string }>,
        ) => void;
      }
    ).__vellumTestInjectCompletedNotify([
      { id: "t1", nodeId: "tasks", brief: "Wire board soft notify" },
      { id: "t2", nodeId: "tasks", brief: "Sticky hotbar leases for actors" },
      { id: "t3", nodeId: "tasks", brief: "Page delete behind feature flag" },
      { id: "t4", nodeId: "tasks", brief: "Durable completed-task dismiss" },
    ]);
  });

  const stack = page.getByTestId("completed-task-notify");
  await expect(stack).toBeVisible({ timeout: 10_000 });
  await expect(stack.locator(".completed-task-notify__item")).toHaveCount(4);
  await expect(stack.locator(".completed-task-notify__chrome-count")).toHaveText("4");

  await page.waitForTimeout(250);
  await stack.screenshot({ path: join(SHOTS, "01-stack-plate.png") });
  await page.screenshot({
    path: join(SHOTS, "02-stack-in-hud.png"),
    fullPage: false,
  });
});
