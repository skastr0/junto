import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasDoc, TextNode } from "../../src/shared/canvas";
import type { TasksSinkContract } from "../../src/shared/work-model";
import { canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "_design_screenshots/station_contract");

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
      tasks: { items: [], contract },
    },
  };
};

const fixture = (): CanvasDoc =>
  canvasDoc(
    [
      station("intake", "Intake", 40),
      station("build", "Build", 340, {
        instruction: "Turn an approved brief into working software.",
        claims: [
          {
            id: "claim-one-task-shape",
            text: "Keep one canonical task data structure.",
            severity: "hard",
          },
        ],
        inbound: {
          admission: "operator-gated",
          claimableAfterMs: 60 * 60 * 1000,
        },
        outbound: { emission: "Tests and a real commit" },
      }),
      station("ship", "Ship", 640),
    ],
    [
      {
        id: "intake-build",
        fromNode: "intake",
        toNode: "build",
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

test("station contract has one full-size home with side-specific board entry", async ({}, testInfo) => {
  await mkdir(SHOTS, { recursive: true });
  const vellumCommand = await launchVellum({ seedCanvases: { factory: fixture() } });

  try {
    const { page } = vellumCommand;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    const build = page.locator('.react-flow__node[data-id="build"]');
    await expect(build).toBeVisible({ timeout: 30_000 });

    // The node remains the entry to its work surface; the column affordance
    // chooses which side of the station contract opens.
    await build.getByTestId("tasks-card").dispatchEvent("dblclick");
    const board = page.getByRole("dialog", { name: "Task flow" });
    await expect(board).toBeVisible();

    await board
      .getByTestId("task-lane-inbound")
      .getByRole("button", { name: "Edit arrivals contract" })
      .click();
    const arrivals = board.getByTestId("task-board-contract-inbound");
    await expect(arrivals.getByLabel("Sink stage instruction")).toHaveValue(
      "Turn an approved brief into working software.",
    );
    await expect(arrivals.getByLabel("Claim text")).toHaveValue(
      "Keep one canonical task data structure.",
    );
    await expect(arrivals.getByText("Incoming", { exact: true })).toBeVisible();
    await expect(arrivals.getByText("Outgoing", { exact: true })).toHaveCount(0);
    const arrivalsShot = join(SHOTS, "full-arrivals.png");
    await board.screenshot({ path: arrivalsShot });
    await testInfo.attach("station-contract-full-arrivals", {
      path: arrivalsShot,
      contentType: "image/png",
    });

    await arrivals.getByRole("button", { name: "Close arrivals contract" }).click();
    await board
      .getByTestId("task-lane-outbound")
      .getByRole("button", { name: "Edit departures contract" })
      .click();
    const departures = board.getByTestId("task-board-contract-outbound");
    await expect(departures.getByLabel("Sink stage instruction")).toHaveValue(
      "Turn an approved brief into working software.",
    );
    await expect(departures.getByLabel("Claim text")).toHaveValue(
      "Keep one canonical task data structure.",
    );
    await expect(departures.getByText("Outgoing", { exact: true })).toBeVisible();
    await expect(departures.getByText("Incoming", { exact: true })).toHaveCount(0);
    const departuresShot = join(SHOTS, "full-departures.png");
    await board.screenshot({ path: departuresShot });
    await testInfo.attach("station-contract-full-departures", {
      path: departuresShot,
      contentType: "image/png",
    });
  } finally {
    await vellumCommand.close();
  }
});
