/**
 * Task node glance: counters, identity, and layout on the canvas card and the
 * board header.
 *
 * Counter semantics (both surfaces): "open" = submitted + working; needs-input
 * renders as its own disjoint counter; "done" counts completed only — failed,
 * canceled, and rejected work is settled but never done.
 *
 * Identity: an unnamed board on a generic node id reads "Tasks" — never the
 * stacked "Tasks tasks". A authored name always wins.
 *
 * Layout: the glance header gives the title its own row; the counters stack
 * below, so a 240px node no longer truncates its identity to "Ta…".
 *
 * Run: npx electron-vite build && scripts/run-e2e.sh e2e/scenarios/task-node-glance.spec.ts
 */
import type { CanvasDoc } from "../../src/shared/canvas";
import {
  agentTextNode,
  canvasDoc,
  claimByNodeId,
  taskItem,
  tasksNode,
} from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const fixture = (): CanvasDoc =>
  canvasDoc(
    [
      tasksNode({
        id: "tasks",
        x: 80,
        y: 80,
        items: [
          taskItem("queued-1", "Queued task one", "submitted"),
          taskItem("queued-2", "Queued task two", "submitted"),
          {
            ...taskItem("working", "Working task", "working"),
            claimedBy: claimByNodeId("builder-1"),
          },
          {
            ...taskItem("input", "Clarify release scope", "input-required"),
            claimedBy: claimByNodeId("builder-2"),
          },
          taskItem("done-1", "Completed task alpha", "completed"),
          taskItem("failed-1", "Failed task", "failed"),
          taskItem("canceled-1", "Canceled task", "canceled"),
          taskItem("rejected-1", "Rejected task", "rejected"),
        ],
      }),
      agentTextNode({
        id: "builder-1",
        key: "local:builder-1",
        label: "builder one",
        x: 520,
        y: 300,
      }),
      agentTextNode({
        id: "builder-2",
        key: "local:builder-2",
        label: "builder two",
        x: 820,
        y: 300,
      }),
    ],
    [
      { id: "e-builder1-tasks", fromNode: "builder-1", toNode: "tasks" },
      { id: "e-builder2-tasks", fromNode: "builder-2", toNode: "tasks" },
    ],
  );

test.use({
  juntoOptions: {
    seedCanvases: { factory: fixture() },
  },
});

test("task glance and board header agree on open counters, identity, and closed lane copy", async ({
  junto,
}) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  const node = page.locator('.react-flow__node[data-id="tasks"]');
  await expect(node).toBeVisible({ timeout: 30_000 });
  const card = node.getByTestId("tasks-card");
  await expect(card).toBeVisible({ timeout: 15_000 });

  // 2 submitted + 1 working are open; the input-required wait is separate;
  // done counts completed only (failed / canceled / rejected never inflate it).
  await expect(card.getByTestId("tasks-glance")).toHaveText("3 open - 1 need input");
  await expect(card.getByTestId("tasks-glance-completed")).toHaveText("1 done");

  // Generic-id identity: the unnamed board must not read "Tasks tasks".
  await expect(card.locator(".factory-glance__header")).toContainText("Tasks");
  const headerText = await card.locator(".factory-glance__header").textContent();
  expect(headerText).not?.toContain("Tasks tasks");

  // Stacked layout: the title owns its row at the default 240px node width.
  // The app re-homes native titles onto data-junto-tooltip (TooltipLayer).
  const title = card.locator(".factory-glance__header .truncate").first();
  await expect(title).toHaveAttribute("data-junto-tooltip", "Tasks");
  const titleBox = await title.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(titleBox.scrollWidth).toBeLessThanOrEqual(titleBox.clientWidth);

  // Counters sit below the identity row, inside the card.
  const stats = page
    .locator('.react-flow__node[data-id="tasks"] [data-testid="tasks-glance"]')
    .locator("..");
  const statsBox = await stats.evaluate((el) => {
    const cardBox = el.closest('[data-testid="tasks-card"]')!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const headerBox = el
      .closest('[data-testid="tasks-card"]')!
      .querySelector(".factory-glance__header")!
      .getBoundingClientRect();
    return {
      belowHeader: box.top >= headerBox.bottom - 1,
      insideCard:
        box.top >= cardBox.top &&
        box.bottom <= cardBox.bottom &&
        box.right <= cardBox.right,
    };
  });
  expect(statsBox.belowHeader).toBe(true);
  expect(statsBox.insideCard).toBe(true);

  // The first preview row stays visible under the stacked counters.
  const firstRow = card.locator(".factory-glance__row").first();
  await expect(firstRow).toBeVisible();

  // Board header mirrors the glance counters and copy.
  await card.dispatchEvent("dblclick");
  const board = page.getByRole("dialog", { name: "Task board" });
  await expect(board).toBeVisible();
  await expect(board.getByText("3 open - 1 need input")).toBeVisible();

  // The Closed lane hint covers every terminal state, not only completion.
  const closed = board.getByTestId("task-lane-closed");
  await expect(closed).toContainText("Finished or stopped work");
  await expect(closed.getByTestId("task-board-card")).toHaveCount(4);
});

test("a long authored title keeps its identity row readable", async ({
  junto,
}) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  const node = page.locator('.react-flow__node[data-id="tasks"]');
  await expect(node).toBeVisible({ timeout: 30_000 });

  // Rename through the RTS pencil, then verify the title renders unclipped.
  await node.click();
  const strip = page.locator(".rts-kind-surface");
  await strip.getByRole("button", { name: "Rename" }).first().click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Release queue for the factory floor");
  await page.keyboard.press("Enter");

  const card = node.getByTestId("tasks-card");
  const title = card.locator(".factory-glance__header .truncate").first();
  await expect(title).toHaveAttribute(
    "data-junto-tooltip",
    "Release queue for the factory floor",
    { timeout: 10_000 },
  );
  const titleBox = await title.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  // A long title may truncate (the tooltip carries the full name), but the
  // identity row must own the card width again — the stacked counters no
  // longer crush it to a few characters.
  expect(titleBox.clientWidth).toBeGreaterThanOrEqual(120);
});
