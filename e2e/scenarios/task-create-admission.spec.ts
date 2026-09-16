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
      entity: { kind: "task", name },
      tasks: { items: [], name, contract },
    },
  };
};

const fixture = (): CanvasDoc =>
  canvasDoc(
    [
      board("intake", "Intake", -240),
      board("build", "Build", 100, {
        incoming: { admission: "approval" },
      }),
      board("review", "Review", 440),
      board("ship", "Ship", 780),
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
  const junto = await launchJunto({
    seedCanvases: { factory: fixture() },
  });

  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    const build = page.locator('.react-flow__node[data-id="build"]');
    await build.getByTestId("tasks-card").dispatchEvent("dblclick");

    const board = page.getByRole("dialog", { name: "Task board" });
    await board.getByTestId("task-board-enqueue").click();
    const creator = page.getByRole("dialog", { name: "Create task" });
    await expect(creator).toBeVisible();

    const title = creator.getByPlaceholder("What needs doing?");
    const description = creator.getByPlaceholder(/Context, constraints/);
    const path = creator.locator(".task-create-dialog__path");
    const criteria = creator.getByPlaceholder(/What must be true/);
    await expect(title).toBeFocused();
    await expect(path).not.toHaveAttribute("open", "");
    await expect(
      creator.getByRole("region", { name: "Task path" }),
    ).toBeHidden();

    const verticalOrder = await Promise.all(
      [title, description, path, criteria].map((locator) =>
        locator.evaluate((element) => element.getBoundingClientRect().top),
      ),
    );
    expect(verticalOrder).toEqual([...verticalOrder].sort((a, b) => a - b));

    await expect(creator.getByRole("button", { name: /Approval/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(creator.getByRole("button", { name: /Immediate/ })).toBeEnabled();
    await expect(creator.getByRole("button", { name: /Me/ })).toBeEnabled();

    const afterScreenshot = testInfo.outputPath("after.png");
    await creator.screenshot({ path: afterScreenshot });
    await testInfo.attach("task-create-after", {
      path: afterScreenshot,
      contentType: "image/png",
    });

    await title.fill("Hold the release proof");
    await description.fill("Verify the release proof before a worker claims it.");
    await creator.getByLabel("Wait before starting duration").fill("12h");
    await creator.getByRole("button", { name: "Create task", exact: true }).click();
    await expect(creator).toBeHidden();

    const incoming = board.getByTestId("task-lane-incoming");
    await expect(incoming.getByText("Hold the release proof", { exact: true })).toBeVisible();
    await expect(incoming.getByText("Awaiting approval", { exact: true })).toBeVisible();
    await incoming.getByRole("button", { name: "Approve", exact: true }).first().click();
    await expect(incoming.getByText(/^Wait 12h/)).toBeVisible();
  } finally {
    await junto.close();
  }
});
