import type { CanvasDoc, GroupNode, TextNode } from "../../src/shared/canvas";
import type { TasksContract } from "../../src/shared/work-model";
import { canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const board = (
  id: string,
  name: string,
  x: number,
  y: number,
  contract?: TasksContract,
): TextNode => {
  const node = tasksNode({ id, x, y, items: [] });
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

const factoryRegion: GroupNode = {
  id: "factory-region",
  type: "group",
  label: "Factory rules",
  x: 0,
  y: 0,
  width: 1420,
  height: 620,
  ether: {
    region: {
      contract: {
        rules: [
          {
            id: "one-rule",
            text: "Every completed task includes reproducible verification evidence.",
          },
        ],
      },
    },
  },
};

const fixture = (): CanvasDoc =>
  canvasDoc(
    [
      factoryRegion,
      board("intake", "Intake", 80, 220),
      board("build", "Build", 340, 220, {
        incoming: {
          admission: "approval",
          waitMs: 60 * 60 * 1000,
        },
      }),
      board("review", "Review", 640, 120),
      board("security", "Security", 640, 340, {
        incoming: { admission: "operator" },
      }),
      board("ship", "Ship", 980, 220),
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
        id: "build-security",
        fromNode: "build",
        toNode: "security",
        ether: { verb: "feeds" },
      },
      {
        id: "review-ship",
        fromNode: "review",
        toNode: "ship",
        ether: { verb: "feeds" },
      },
      {
        id: "security-ship",
        fromNode: "security",
        toNode: "ship",
        ether: { verb: "feeds" },
      },
    ],
  );

test("five-board fork renders one compact path", async ({}, testInfo) => {
  const vellumCommand = await launchVellum({
    seedCanvases: { factory: fixture() },
  });

  try {
    const { page } = vellumCommand;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    const intake = page.locator('.react-flow__node[data-id="intake"]');
    await intake.getByTestId("tasks-card").dispatchEvent("dblclick");
    const board = page.getByRole("dialog", { name: "Task board" });
    await board.getByTestId("task-board-enqueue").click();

    const creator = page.getByRole("dialog", { name: "Create task" });
    const pathDisclosure = creator.locator("details.task-create-dialog__path");
    if (await pathDisclosure.count()) {
      await pathDisclosure.evaluate((element: HTMLDetailsElement) => {
        element.open = true;
      });
    }
    const strip = creator.getByRole("region", {
      name: "Task path",
    });
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("5 boards, 1 rule");
    await expect(
      strip.getByText(
        "Every completed task includes reproducible verification evidence.",
        { exact: true },
      ),
    ).toHaveCount(1);
    await expect(strip.getByText("Immediate", { exact: true })).toHaveCount(0);
    await expect(strip.getByText("Approval", { exact: true })).toHaveCount(1);
    await expect(strip.getByText("Me", { exact: true })).toHaveCount(1);
    await expect(strip.getByText("2 boards on", { exact: true })).toHaveCount(1);
    await expect(strip.getByText("3 boards on", { exact: true })).toHaveCount(1);

    for (const name of ["Intake", "Build", "Review", "Security", "Ship"]) {
      await expect(
        strip.getByRole("button", { name: new RegExp(`^${name},`) }),
      ).toBeVisible();
    }

    await creator.getByRole("complementary", { name: "Details and hard gates" }).hover();
    const screenshot = testInfo.outputPath("path.png");
    await creator.screenshot({ path: screenshot });
    await testInfo.attach("task-path-after", {
      path: screenshot,
      contentType: "image/png",
    });

    await strip.getByRole("button", { name: /^Build,/ }).click();
    const details = strip.locator(".inspector-section");
    await expect(details.getByText("Rules at Build", { exact: true })).toBeVisible();
    await expect(details.getByRole("button", { name: "Add rule" })).toBeVisible();
    await creator.locator(".task-create-dialog__primary").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await creator.getByRole("complementary", { name: "Details and hard gates" }).hover();
    const expandedScreenshot = testInfo.outputPath("rules-expanded.png");
    await creator.screenshot({ path: expandedScreenshot });
    await testInfo.attach("task-path-rules-expanded", {
      path: expandedScreenshot,
      contentType: "image/png",
    });
  } finally {
    await vellumCommand.close();
  }
});
