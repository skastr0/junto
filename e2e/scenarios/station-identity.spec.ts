import { join } from "node:path";
import type { CanvasDoc, TextNode } from "../../src/shared/canvas";
import type { TasksSinkContract } from "../../src/shared/work-model";
import { canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const station = (
  id: string,
  name: string,
  x: number,
  contract?: TasksSinkContract,
): TextNode => {
  const node = tasksNode({ id, x, y: 100, items: [] });
  return {
    ...node,
    text: name,
    ether: {
      ...node.ether,
      entity: { kind: "task" },
      tasks: { items: [], stationName: name, contract },
    },
  };
};

const fixture = (): CanvasDoc =>
  canvasDoc(
    [
      station("intake", "Intake", 40),
      station("build", "Build", 340, {
        instruction: "Turn accepted intent into verified product behavior.",
      }),
      station("review", "Review", 640),
      station("ship", "Ship", 940),
    ],
    [
      {
        id: "intake-build",
        fromNode: "intake",
        toNode: "build",
        ether: { flow: { source: "intake", destination: "build" } },
      },
      {
        id: "build-review",
        fromNode: "build",
        toNode: "review",
        ether: { flow: { source: "build", destination: "review" } },
      },
      {
        id: "review-ship",
        fromNode: "review",
        toNode: "ship",
        ether: { flow: { source: "review", destination: "ship" } },
      },
    ],
  );

test("named stations carry through the board and task travel strip", async ({}, testInfo) => {
  const vellumCommand = await launchVellum({
    seedCanvases: { factory: fixture() },
  });

  try {
    const { page } = vellumCommand;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    const build = page.locator('.react-flow__node[data-id="build"]');
    await build.getByTestId("tasks-card").dispatchEvent("dblclick");

    const board = page.getByRole("dialog", { name: "Task flow" });
    await expect(board).toBeVisible();
    await expect(board.getByText("Build", { exact: true })).toBeVisible();
    await expect(
      board.getByText("Turn accepted intent into verified product behavior.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(board.getByTestId("task-lane-outbound")).toContainText(
      "Destinations: Review",
    );

    const boardScreenshot = join(
      process.cwd(),
      "_design_screenshots/station_identity/board.png",
    );
    await board.screenshot({ path: boardScreenshot });
    await testInfo.attach("named-station-board", {
      path: boardScreenshot,
      contentType: "image/png",
    });

    await board.getByTestId("task-board-enqueue").click();
    const creator = page.getByRole("dialog", { name: "Create task" });
    const strip = creator.getByRole("region", {
      name: "Stations this task will travel",
    });
    await expect(strip).toBeVisible();
    for (const name of ["Build", "Review", "Ship"]) {
      await expect(strip.getByRole("heading", { name, exact: true })).toBeVisible();
    }

    const stripScreenshot = join(
      process.cwd(),
      "_design_screenshots/station_identity/strip.png",
    );
    await creator.screenshot({ path: stripScreenshot });
    await testInfo.attach("named-station-strip", {
      path: stripScreenshot,
      contentType: "image/png",
    });
  } finally {
    await vellumCommand.close();
  }
});
