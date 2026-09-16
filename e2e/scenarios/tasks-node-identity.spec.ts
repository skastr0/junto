import type { CanvasDoc, TextNode } from "../../src/shared/canvas";
import type { TasksContract } from "../../src/shared/work-model";
import { canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const board = (
  id: string,
  name: string,
  x: number,
  contract?: TasksContract,
): TextNode => {
  const node = tasksNode({ id, x, y: 100, items: [] });
  return {
    ...node,
    text: name,
    ether: {
      ...node.ether,
      entity: { kind: "task" },
      tasks: { items: [], name, contract },
    },
  };
};

const fixture = (): CanvasDoc =>
  canvasDoc(
    [
      board("intake", "Intake", 40),
      board("build", "Build", 340, {
        instructions: "Turn accepted intent into verified product behavior.",
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
        id: "review-ship",
        fromNode: "review",
        toNode: "ship",
        ether: { verb: "feeds" },
      },
    ],
  );

test("named boards carry through the board and task path", async ({}, testInfo) => {
  const junto = await launchJunto({
    seedCanvases: { factory: fixture() },
  });

  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    const build = page.locator('.react-flow__node[data-id="build"]');
    await build.getByTestId("tasks-card").dispatchEvent("dblclick");

    const board = page.getByRole("dialog", { name: "Task board" });
    await expect(board).toBeVisible();
    await expect(board.getByText("Build", { exact: true })).toBeVisible();
    await expect(
      board.getByText("Turn accepted intent into verified product behavior.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(board.getByTestId("task-lane-outgoing")).toContainText(
      "Sent on to Review",
    );

    const boardScreenshot = testInfo.outputPath("board.png");
    await board.screenshot({ path: boardScreenshot });
    await testInfo.attach("named-board-board", {
      path: boardScreenshot,
      contentType: "image/png",
    });

    await board.getByTestId("task-board-enqueue").click();
    const creator = page.getByRole("dialog", { name: "Create task" });
    await creator.locator("details.task-create-dialog__path").evaluate(
      (element: HTMLDetailsElement) => {
        element.open = true;
      },
    );
    const strip = creator.getByRole("region", {
      name: "Task path",
    });
    await expect(strip).toBeVisible();
    for (const name of ["Build", "Review", "Ship"]) {
      await expect(
        strip.getByRole("button", { name: new RegExp(`^${name},`) }),
      ).toBeVisible();
    }

    const stripScreenshot = testInfo.outputPath("path.png");
    await creator.screenshot({ path: stripScreenshot });
    await testInfo.attach("named-board-path", {
      path: stripScreenshot,
      contentType: "image/png",
    });
  } finally {
    await junto.close();
  }
});
