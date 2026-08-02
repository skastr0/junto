import type { CanvasDoc } from "../../src/shared/canvas";
import { canvasDoc, taskItem, tasksNode } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const installBoard = async (
  page: import("@playwright/test").Page,
  doc: CanvasDoc,
): Promise<void> => {
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

  await page.evaluate(async (document) => {
    const api = (
      globalThis as unknown as {
        readonly vellum: {
          readonly listCanvases: () => Promise<ReadonlyArray<{ name: string }>>;
          readonly createCanvas: (name: string) => Promise<{ name: string }>;
          readonly readCanvas: (name: string) => Promise<{ revision: string }>;
          readonly writeCanvas: (
            name: string,
            doc: unknown,
            expectedRevision?: string,
          ) => Promise<unknown>;
        };
      }
    ).vellum;
    const list = await api.listCanvases();
    const name = list[0]?.name ?? (await api.createCanvas("task-board-ux")).name;
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
  }, doc);
};

test("task board supports creation, operator responses, layered status, and body dragging", async () => {
  const fixture = canvasDoc([
    tasksNode({
      id: "tasks",
      x: 80,
      y: 80,
      items: [
        taskItem("queued", "Queued task", "submitted"),
        {
          ...taskItem("working", "Working task", "working"),
          metadata: {
            claimedBy: "local:builder",
            workRole: "Builder",
            details: "A claimed task ready for a whole-card drag.",
          },
        },
        {
          ...taskItem("input", "Clarify release scope", "input-required"),
          metadata: {
            claimedBy: "local:builder",
            workRole: "Release Engineer",
          },
          history: [
            ...taskItem("input", "Clarify release scope", "input-required").history,
            {
              messageId: "input-question",
              role: "agent",
              parts: [
                {
                  kind: "text",
                  text: "Should the release include the experimental station adapter?",
                },
              ],
              taskId: "input",
            },
          ],
        },
        {
          ...taskItem("completed", "Completed task", "completed"),
          metadata: {
            details: "Review the worker's proof before accepting the completion.",
          },
        },
      ],
    }),
  ]);
  const vellum = await launchVellum();

  try {
    const { page } = vellum;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await installBoard(page, fixture);
    await expect(page.locator('.react-flow__node[data-id="tasks"]')).toBeVisible({
      timeout: 30_000,
    });
    await page
      .locator('.react-flow__node[data-id="tasks"]')
      .getByTestId("tasks-card")
      .dispatchEvent("dblclick");

    const board = page.getByRole("dialog", { name: "Task flow" });
    await expect(board).toBeVisible();

    await board.getByRole("button", { name: "Enqueue", exact: true }).click();
    const creator = page.getByRole("dialog", { name: "Create task" });
    await expect(creator).toBeVisible();
    const creatorPanel = creator.locator(".focus-surface__panel");
    await expect(creatorPanel).toBeVisible();
    const creatorOwnsCenter = await creatorPanel.evaluate((panel) => {
      const rect = panel.getBoundingClientRect();
      const top = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return top instanceof Node && panel.contains(top);
    });
    expect(creatorOwnsCenter).toBe(true);
    const titleInput = creator.getByPlaceholder("What needs doing?");
    await expect(titleInput).toBeFocused();
    await titleInput.pressSequentially("Audit");

    // A work-plane write emits the same canvas projection notification that
    // used to flush and blur the active task input. The caret must stay in the
    // creator while the board receives that live update.
    await page.evaluate(async () => {
      const api = window.vellum!;
      const canvas = (await api.listCanvases())[0];
      if (!canvas) throw new Error("No canvas available for focus regression");
      const result = await api.workTaskCreate(canvas.name, "tasks", "Background projection update", { details: "Background projection update" });
      if (!result.ok) throw new Error(result.message);
    });
    await expect(board.getByText("Background projection update", { exact: true })).toBeVisible();
    await expect(titleInput).toBeFocused();
    await expect(titleInput).toHaveValue("Audit");
    await titleInput.pressSequentially(" release authority");
    await creator.getByPlaceholder("e.g. Security Agent").fill("Security Agent");
    await creator
      .getByPlaceholder(/Context, constraints/)
      .fill("Verify the signing boundary and return the exact proof receipt.");
    await creator.getByRole("button", { name: "Create task", exact: true }).click();
    await expect(creator).toBeHidden();

    const createdCard = board.getByLabel("Open details for Audit release authority");
    await expect(createdCard).toBeVisible();
    const createdDetails = board.getByRole("complementary", {
      name: "Details for Audit release authority",
    });
    await expect(createdDetails).toContainText("Security Agent");
    await expect(createdDetails).toContainText(
      "Verify the signing boundary and return the exact proof receipt.",
    );
    await createdDetails.getByRole("button", { name: "Close task details" }).click();

    await board.getByLabel("Open details for Clarify release scope").click();
    const inputDetails = board.getByRole("complementary", {
      name: "Details for Clarify release scope",
    });
    await expect(inputDetails.getByText("Input required", { exact: true })).toBeVisible();
    await expect(inputDetails).toContainText(
      "Should the release include the experimental station adapter?",
    );
    await inputDetails
      .getByLabel("Your response")
      .fill("No. Keep this release scoped to the stable station adapters.");
    await inputDetails.getByRole("button", { name: "Send input & resume" }).click();
    await expect(
      board.getByTestId("task-lane-working").getByText("Clarify release scope", { exact: true }),
    ).toBeVisible();
    await expect(inputDetails.getByText("Operator")).toBeVisible();
    await expect(inputDetails).toContainText(
      "Keep this release scoped to the stable station adapters.",
    );

    const statusMenu = inputDetails.getByRole("button", { name: "Change task status" });
    await statusMenu.click();
    const statusList = page.getByRole("listbox", { name: "Change task status" });
    await expect(statusList).toBeVisible();
    await expect(statusList.getByText("Move to Needs input", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(statusList).toBeHidden();
    await inputDetails.getByRole("button", { name: "Close task details" }).click();

    await board.getByLabel("Open details for Completed task").click();
    const completedDetails = board.getByRole("complementary", {
      name: "Details for Completed task",
    });
    await expect(
      completedDetails.getByRole("heading", { name: "Reject and re-enqueue" }),
    ).toBeVisible();
    await completedDetails
      .getByLabel("QA rejection comment")
      .fill("The release receipt is missing from the completion evidence.");
    await completedDetails
      .getByRole("button", { name: "Reject and re-enqueue task" })
      .click();
    await expect(
      board.getByTestId("task-lane-queue").getByText("Completed task", { exact: true }),
    ).toBeVisible();
    await expect(completedDetails).toContainText("QA rejects: 1");
    await expect(completedDetails).toContainText(
      "The release receipt is missing from the completion evidence.",
    );
    await completedDetails.getByRole("button", { name: "Close task details" }).click();

    const actionTrigger = board.getByRole("button", { name: "Actions for Queued task" });
    await actionTrigger.click();
    const actionMenu = page.getByRole("menu");
    await expect(actionMenu).toBeVisible();
    await board.getByText("Ready to be claimed", { exact: true }).click();
    await expect(actionMenu).toBeHidden();

    const workingCard = board.getByLabel("Open details for Working task");
    const inputLane = board.getByTestId("task-lane-input");
    const sourceBox = await workingCard.boundingBox();
    const targetBox = await inputLane.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    if (!sourceBox || !targetBox) return;

    await page.mouse.move(
      sourceBox.x + sourceBox.width * 0.72,
      sourceBox.y + sourceBox.height * 0.72,
    );
    await page.mouse.down();
    await page.mouse.move(
      targetBox.x + targetBox.width * 0.5,
      targetBox.y + Math.min(180, targetBox.height * 0.4),
      { steps: 14 },
    );
    await page.mouse.up();

    await expect(inputLane.getByText("Working task", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await vellum.close();
  }
});

test("Kanban enqueue opens the normal modal above the task flow", async () => {
  const fixture = canvasDoc([
    tasksNode({
      id: "tasks",
      x: 80,
      y: 80,
      items: [],
    }),
  ]);
  const vellum = await launchVellum();

  try {
    const { page } = vellum;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await installBoard(page, fixture);
    const tasksNodeCard = page.locator('.react-flow__node[data-id="tasks"]');
    await expect(tasksNodeCard).toBeVisible({ timeout: 30_000 });
    await tasksNodeCard.getByTestId("tasks-card").dispatchEvent("dblclick");

    const board = page.getByRole("dialog", { name: "Task flow" });
    await expect(board).toBeVisible();
    await board.getByTestId("task-board-enqueue").click();

    const creator = page.getByRole("dialog", { name: "Create task" });
    await expect(creator).toBeVisible();
    await expect(page.getByTestId("task-enqueue-surface")).toHaveCount(0);

    const creatorPanel = creator.locator(".focus-surface__panel");
    const creatorOwnsCenter = await creatorPanel.evaluate((panel) => {
      const rect = panel.getBoundingClientRect();
      const top = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return top instanceof Node && panel.contains(top);
    });
    expect(creatorOwnsCenter).toBe(true);

    await creator.getByRole("button", { name: "Close task creator" }).click();
    await expect(creator).toBeHidden();
    await expect(board).toBeVisible();
  } finally {
    await vellum.close();
  }
});
