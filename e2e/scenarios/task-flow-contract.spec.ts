import { join } from "node:path";
import type { CanvasDoc, TextNode } from "../../src/shared/canvas";
import type { TasksSinkContract } from "../../src/shared/work-model";
import { canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const station = (
  id: string,
  label: string,
  x: number,
  contract?: TasksSinkContract,
): TextNode => {
  const node = tasksNode({ id, x, y: 100, items: [] });
  return {
    ...node,
    text: label,
    ether: {
      ...node.ether,
      entity: { kind: "task", name: label },
      tasks: { items: [], stationName: label, contract },
    },
  };
};

const fixture = (): CanvasDoc =>
  canvasDoc(
    [
      station("intake", "Intake", 40),
      station("build", "Build", 340, {
        inbound: {
          admission: "operator-gated",
          claimableAfterMs: 12 * 60 * 60 * 1000,
        },
        outbound: { emission: "operator-gated" },
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
        id: "build-ship",
        fromNode: "build",
        toNode: "ship",
        ether: { flow: { source: "build", destination: "ship" } },
      },
    ],
  );

test("flow columns teach their real route and open the matching contract side", async ({}, testInfo) => {
  const vellumCommand = await launchVellum({
    seedCanvases: { factory: fixture() },
  });

  try {
    const { page } = vellumCommand;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    const build = page.locator('.react-flow__node[data-id="build"]');
    await expect(build).toBeVisible({ timeout: 30_000 });
    await build.getByTestId("tasks-card").dispatchEvent("dblclick");

    const board = page.getByRole("dialog", { name: "Task flow" });
    await expect(board).toBeVisible();
    await expect(board.getByText("Awaiting approval", { exact: true })).toHaveCount(0);

    const inbound = board.getByTestId("task-lane-inbound");
    await expect(inbound).toContainText("Admission: Approval");
    await expect(inbound).toContainText("Bake: 12h");
    await expect(inbound).toContainText("Arrivals from Intake land here.");

    const outbound = board.getByTestId("task-lane-outbound");
    await expect(outbound).toContainText("Destinations: Review and Ship");
    await expect(outbound).toContainText("Completed work goes to Review and Ship.");

    await inbound.getByRole("button", { name: "Edit arrivals contract" }).press("Enter");
    const arrivals = board.getByTestId("task-board-contract-inbound");
    await expect(arrivals).toBeVisible();
    await expect(arrivals.getByText("arrivals", { exact: true })).toBeVisible();
    await expect(arrivals.getByText("departures", { exact: true })).toHaveCount(0);
    const arrivalsScreenshot = join(
      process.cwd(),
      "_design_screenshots/task_flow/arrivals-contract.png",
    );
    await board.screenshot({ path: arrivalsScreenshot });
    await testInfo.attach("task-flow-arrivals-contract", {
      path: arrivalsScreenshot,
      contentType: "image/png",
    });

    await arrivals.getByRole("button", { name: "Close arrivals contract" }).click();
    await outbound.getByRole("button", { name: "Edit departures contract" }).click();
    const departures = board.getByTestId("task-board-contract-outbound");
    await expect(departures).toBeVisible();
    await expect(departures.getByText("departures", { exact: true })).toBeVisible();
    await expect(departures.getByText("arrivals", { exact: true })).toHaveCount(0);
    const departuresScreenshot = join(
      process.cwd(),
      "_design_screenshots/task_flow/departures-contract.png",
    );
    await board.screenshot({ path: departuresScreenshot });
    await testInfo.attach("task-flow-departures-contract", {
      path: departuresScreenshot,
      contentType: "image/png",
    });
  } finally {
    await vellumCommand.close();
  }
});
