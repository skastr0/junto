import type { CanvasDoc, TextNode } from "../../src/shared/canvas";
import type { TasksContract } from "../../src/shared/work-model";
import { canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const board = (
  id: string,
  label: string,
  x: number,
  contract?: TasksContract,
): TextNode => {
  const node = tasksNode({ id, x, y: 100, items: [] });
  return {
    ...node,
    text: label,
    ether: {
      ...node.ether,
      entity: { kind: "task", name: label },
      tasks: { items: [], name: label, contract },
    },
  };
};

const fixture = (): CanvasDoc =>
  canvasDoc(
    [
      board("intake", "Intake", 40),
      board("build", "Build", 340, {
        incoming: {
          admission: "approval",
          waitMs: 12 * 60 * 60 * 1000,
        },
        outgoing: { handoff: "hand the baton" },
      }),
      board("review", "Review", 640),
      board("ship", "Ship", 940),
    ],
    [
      {
        id: "intake-build",
        fromNode: "intake",
        toNode: "build",
        ether: { verb: "feeds" },
      },
      {
        id: "build-review",
        fromNode: "build",
        toNode: "review",
        ether: { verb: "feeds" },
      },
      {
        id: "build-ship",
        fromNode: "build",
        toNode: "ship",
        ether: { verb: "feeds" },
      },
    ],
  );

test("path columns explain task movement and open the matching Board settings side", async ({}, testInfo) => {
  const vellumCommand = await launchVellum({
    seedCanvases: { factory: fixture() },
  });

  try {
    const { page } = vellumCommand;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    const build = page.locator('.react-flow__node[data-id="build"]');
    await expect(build).toBeVisible({ timeout: 30_000 });
    await build.getByTestId("tasks-card").dispatchEvent("dblclick");

    const board = page.getByRole("dialog", { name: "Task board" });
    await expect(board).toBeVisible();
    await expect(board.getByText("Awaiting approval", { exact: true })).toHaveCount(0);

    const incoming = board.getByTestId("task-lane-incoming");
    await expect(incoming).toContainText("Starts: Approval");
    await expect(incoming).toContainText("Wait: 12h");
    await expect(incoming).toContainText("Tasks from Intake land here.");

    const outgoing = board.getByTestId("task-lane-outgoing");
    await expect(outgoing).toContainText("Sent on to Review and Ship");
    await expect(outgoing).toContainText("Completed tasks move to Review and Ship.");

    await incoming.getByRole("button", { name: "Edit incoming settings" }).press("Enter");
    const incomingPanel = board.getByTestId("task-board-contract-incoming");
    await expect(incomingPanel).toBeVisible();
    await expect(incomingPanel.getByText("Incoming", { exact: true })).toBeVisible();
    await expect(incomingPanel.getByText("Outgoing", { exact: true })).toHaveCount(0);
    const incomingScreenshot = testInfo.outputPath("incoming-contract.png");
    await board.screenshot({ path: incomingScreenshot });
    await testInfo.attach("task-board-incoming-contract", {
      path: incomingScreenshot,
      contentType: "image/png",
    });

    await incomingPanel.getByRole("button", { name: "Close incoming settings" }).click();
    await outgoing.getByRole("button", { name: "Edit outgoing settings" }).click();
    const outgoingPanel = board.getByTestId("task-board-contract-outgoing");
    await expect(outgoingPanel).toBeVisible();
    await expect(outgoingPanel.getByText("Outgoing", { exact: true })).toBeVisible();
    await expect(outgoingPanel.getByText("Incoming", { exact: true })).toHaveCount(0);
    const outgoingScreenshot = testInfo.outputPath("outgoing-contract.png");
    await board.screenshot({ path: outgoingScreenshot });
    await testInfo.attach("task-board-outgoing-contract", {
      path: outgoingScreenshot,
      contentType: "image/png",
    });
  } finally {
    await vellumCommand.close();
  }
});
