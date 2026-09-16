import type { CanvasDoc, TextNode } from "../../src/shared/canvas";
import type { TasksContract } from "../../src/shared/work-model";
import { canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

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
        instructions: "Turn an approved brief into working software.",
        rules: [
          {
            id: "rule-one-task-shape",
            text: "Keep one canonical task data structure.",
          },
        ],
        incoming: {
          admission: "approval",
          waitMs: 60 * 60 * 1000,
        },
        outgoing: { handoff: "Tests and a real commit" },
      }),
      board("ship", "Ship", 640),
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

test("board settings has one full-size home with side-specific board entry", async ({}, testInfo) => {
  const junto = await launchJunto({ seedCanvases: { factory: fixture() } });

  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    const build = page.locator('.react-flow__node[data-id="build"]');
    await expect(build).toBeVisible({ timeout: 30_000 });

    // The node remains the entry to its work surface; the column affordance
    // chooses which side of the board settings opens.
    await build.getByTestId("tasks-card").dispatchEvent("dblclick");
    const board = page.getByRole("dialog", { name: "Task board" });
    await expect(board).toBeVisible();

    await board
      .getByTestId("task-lane-incoming")
      .getByRole("button", { name: "Edit incoming settings" })
      .click();
    const incoming = board.getByTestId("task-board-contract-incoming");
    await expect(incoming.getByLabel("Instructions")).toHaveValue(
      "Turn an approved brief into working software.",
    );
    await expect(incoming.getByLabel("Rule text")).toHaveValue(
      "Keep one canonical task data structure.",
    );
    await expect(incoming.getByText("Incoming", { exact: true })).toBeVisible();
    await expect(incoming.getByText("Outgoing", { exact: true })).toHaveCount(0);
    const incomingShot = testInfo.outputPath("full-incoming.png");
    await board.screenshot({ path: incomingShot });
    await testInfo.attach("board-settings-full-incoming", {
      path: incomingShot,
      contentType: "image/png",
    });

    await incoming.getByRole("button", { name: "Close incoming settings" }).click();
    await board
      .getByTestId("task-lane-outgoing")
      .getByRole("button", { name: "Edit outgoing settings" })
      .click();
    const outgoing = board.getByTestId("task-board-contract-outgoing");
    await expect(outgoing.getByLabel("Instructions")).toHaveValue(
      "Turn an approved brief into working software.",
    );
    await expect(outgoing.getByLabel("Rule text")).toHaveValue(
      "Keep one canonical task data structure.",
    );
    await expect(outgoing.getByText("Outgoing", { exact: true })).toBeVisible();
    await expect(outgoing.getByText("Incoming", { exact: true })).toHaveCount(0);
    const outgoingShot = testInfo.outputPath("full-outgoing.png");
    await board.screenshot({ path: outgoingShot });
    await testInfo.attach("board-settings-full-outgoing", {
      path: outgoingShot,
      contentType: "image/png",
    });
  } finally {
    await junto.close();
  }
});
