import type { CanvasDoc } from "../../src/shared/canvas";
import {
  agentTextNode,
  canvasDoc,
  claimByNodeId,
  tasksNode,
} from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const fixture = (): CanvasDoc => {
  const seat = claimByNodeId("builder-alpha");
  return canvasDoc(
    [
      tasksNode({
        id: "tasks",
        x: 80,
        y: 80,
        items: [
          {
            id: "thread-task",
            state: "working",
            claimedBy: seat,
            history: [
              {
                messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                role: "user",
                parts: [{ kind: "text", text: "Make task history legible" }],
                taskId: "thread-task",
              },
              {
                messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
                role: "agent",
                parts: [{ kind: "text", text: `claimed by ${seat}` }],
                taskId: "thread-task",
              },
              {
                messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
                role: "agent",
                parts: [{ kind: "text", text: "Connected the chronological timeline." }],
                taskId: "thread-task",
                metadata: { fromSeat: "builder-alpha" },
              },
              {
                messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
                role: "agent",
                parts: [{ kind: "text", text: "defect from review: author was missing" }],
                taskId: "thread-task",
                metadata: {
                  fromSeat: "builder-alpha",
                  "junto.taskThread.kind": "defect",
                },
              },
              {
                messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
                role: "user",
                parts: [{ kind: "text", text: "Keep the owner visible on the card." }],
                taskId: "thread-task",
                metadata: {
                  taskComment: true,
                  fromSeat: "operator",
                  "junto.taskThread.kind": "comment",
                },
              },
            ],
          },
        ],
      }),
      agentTextNode({
        id: "builder-alpha",
        key: "local:builder-alpha",
        label: "Builder Alpha",
        x: 520,
        y: 180,
      }),
    ],
    [{ id: "builder-tasks", fromNode: "builder-alpha", toNode: "tasks" }],
  );
};

test("task detail renders the attributed thread and operator comments notify its owner", async ({}, testInfo) => {
  const junto = await launchJunto({ seedCanvases: { factory: fixture() } });

  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await page
      .locator('.react-flow__node[data-id="tasks"]')
      .getByTestId("tasks-card")
      .dispatchEvent("dblclick");

    const board = page.getByRole("dialog", { name: "Task board" });
    const card = board.getByTestId("task-board-card").filter({
      hasText: "Make task history legible",
    });
    // The claimant chip names the agent's node, never the tasks-board id
    // fallback ("Tasks er-alpha") — a regression the suite used to catch.
    await expect(card.locator(".task-board-card__claimant")).toHaveText(
      /^Builder Alpha$/,
    );

    const ownerShot = testInfo.outputPath("owner-card.png");
    await board.screenshot({ path: ownerShot });
    await testInfo.attach("task-owner-card", {
      path: ownerShot,
      contentType: "image/png",
    });

    await card.click();
    const detail = board.getByRole("complementary", {
      name: "Details for Make task history legible",
    });
    const thread = detail.getByRole("region", { name: "Task thread" });
    await expect(thread).toBeVisible();
    await expect(thread.locator('[data-kind="brief"]')).toContainText("Operator");
    await expect(thread.locator('[data-kind="update"]').first()).toContainText("Builder Alpha");
    await expect(thread.locator('[data-kind="defect"]')).toContainText("defect");
    await expect(thread.locator('[data-kind="comment"]')).toContainText("Operator");

    // The details panel's identity row carries the same agent-named chip.
    await expect(detail.locator(".task-detail-panel__claim")).toHaveText(
      /^Builder Alpha$/,
    );

    const threadShot = testInfo.outputPath("thread-detail.png");
    await board.screenshot({ path: threadShot });
    await testInfo.attach("task-thread-detail", {
      path: threadShot,
      contentType: "image/png",
    });

    const comment = "Operator confirms the owner attribution.";
    await thread.getByRole("textbox", { name: "Add a task comment" }).fill(comment);
    await thread.getByRole("button", { name: "Comment" }).click();
    await expect(thread.getByText(comment)).toBeVisible();

    await expect
      .poll(async () =>
        page.evaluate(async (text) => {
          const api = window.junto;
          if (!api) return false;
          const [canvas] = await api.listCanvases();
          if (!canvas) return false;
          const read = await api.readCanvas(canvas.name);
          const owner = read.doc.nodes.find((node) => node.id === "builder-alpha");
          return Boolean(
            owner?.ether?.messages?.items.some((message) =>
              message.parts.some((part) => part.kind === "text" && part.text.includes(text)),
            ),
          );
        }, comment),
      )
      .toBe(true);

    const commentShot = testInfo.outputPath("thread-comment.png");
    await board.screenshot({ path: commentShot });
    await testInfo.attach("task-thread-comment", {
      path: commentShot,
      contentType: "image/png",
    });
  } finally {
    await junto.close();
  }
});
