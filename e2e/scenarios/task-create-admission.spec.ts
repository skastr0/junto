import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasDoc, TextNode } from "../../src/shared/canvas";
import type { TasksSinkContract } from "../../src/shared/work-model";
import { canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "_design_screenshots", "task_creation");

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
      entity: { kind: "task", name },
      tasks: { items: [], contract },
    },
  };
};

const fixture = (): CanvasDoc =>
  canvasDoc(
    [
      station("intake", "Intake", -240),
      station("build", "Build", 100, {
        inbound: { admission: "operator-gated" },
      }),
      station("review", "Review", 440),
      station("ship", "Ship", 780),
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

test("task creation hierarchy and admission", async ({}, testInfo) => {
  await mkdir(SHOTS, { recursive: true });
  const vellumCommand = await launchVellum({
    seedCanvases: { factory: fixture() },
  });

  try {
    const { page } = vellumCommand;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    const build = page.locator('.react-flow__node[data-id="build"]');
    await build.getByTestId("tasks-card").dispatchEvent("dblclick");

    const board = page.getByRole("dialog", { name: "Task flow" });
    await board.getByTestId("task-board-enqueue").click();
    const creator = page.getByRole("dialog", { name: "Create task" });
    await expect(creator).toBeVisible();

    const title = creator.getByPlaceholder("What needs doing?");
    const description = creator.getByPlaceholder(/Context, constraints/);
    const line = creator.locator(".task-create-dialog__line");
    const criteria = creator.getByPlaceholder(/What must be true/);
    await expect(title).toBeFocused();
    await expect(line).not.toHaveAttribute("open", "");
    await expect(
      creator.getByRole("region", { name: "Stations this task will travel" }),
    ).toBeHidden();

    const verticalOrder = await Promise.all(
      [title, description, line, criteria].map((locator) =>
        locator.evaluate((element) => element.getBoundingClientRect().top),
      ),
    );
    expect(verticalOrder).toEqual([...verticalOrder].sort((a, b) => a - b));

    const immediate = creator.getByRole("button", { name: /Immediate/ });
    await expect(immediate).toBeDisabled();
    await expect(immediate).toHaveAttribute(
      "data-vellum-tooltip",
      /sink floor is “Waits for my approval”/,
    );
    await expect(creator.getByText(/Unavailable because the sink floor/)).toBeVisible();
    await expect(creator.getByRole("button", { name: /Approval/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const afterScreenshot = join(SHOTS, "after.png");
    await creator.screenshot({ path: afterScreenshot });
    await testInfo.attach("task-create-after", {
      path: afterScreenshot,
      contentType: "image/png",
    });

    await title.fill("Hold the release proof");
    await description.fill("Verify the release proof before a worker claims it.");
    await creator.getByLabel("Optional hold duration").fill("12h");
    await creator.getByRole("button", { name: "Create task", exact: true }).click();
    await expect(creator).toBeHidden();

    const inbound = board.getByTestId("task-lane-inbound");
    await expect(inbound.getByText("Hold the release proof", { exact: true })).toBeVisible();
    await expect(inbound.getByText("Awaiting approval", { exact: true })).toBeVisible();
    await board.getByRole("button", { name: "Approve to Queue", exact: true }).first().click();
    await expect(inbound.getByText(/^Held 12h/)).toBeVisible();
  } finally {
    await vellumCommand.close();
  }
});
