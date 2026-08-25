import { join } from "node:path";
import type { CanvasDoc, GroupNode, TextNode } from "../../src/shared/canvas";
import type { TasksSinkContract } from "../../src/shared/work-model";
import { canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const station = (
  id: string,
  name: string,
  x: number,
  y: number,
  contract?: TasksSinkContract,
): TextNode => {
  const node = tasksNode({ id, x, y, items: [] });
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

const factoryRegion: GroupNode = {
  id: "factory-region",
  type: "group",
  label: "Factory law",
  x: 0,
  y: 0,
  width: 1420,
  height: 620,
  ether: {
    region: {
      contract: {
        claims: [
          {
            id: "one-hard-law",
            text: "Every shipment includes a reproducible verification receipt.",
            severity: "hard",
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
      station("intake", "Intake", 80, 220),
      station("build", "Build", 340, 220, {
        inbound: {
          admission: "operator-gated",
          claimableAfterMs: 60 * 60 * 1000,
        },
      }),
      station("review", "Review", 640, 120),
      station("security", "Security", 640, 340, {
        inbound: { admission: "operator-owned" },
      }),
      station("ship", "Ship", 980, 220),
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
        id: "build-security",
        fromNode: "build",
        toNode: "security",
        ether: { flow: { source: "build", destination: "security" } },
      },
      {
        id: "review-ship",
        fromNode: "review",
        toNode: "ship",
        ether: { flow: { source: "review", destination: "ship" } },
      },
      {
        id: "security-ship",
        fromNode: "security",
        toNode: "ship",
        ether: { flow: { source: "security", destination: "ship" } },
      },
    ],
  );

test("five-stop fork renders one compact line-wide law", async ({}, testInfo) => {
  const vellumCommand = await launchVellum({
    seedCanvases: { factory: fixture() },
  });

  try {
    const { page } = vellumCommand;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    const intake = page.locator('.react-flow__node[data-id="intake"]');
    await intake.getByTestId("tasks-card").dispatchEvent("dblclick");
    const board = page.getByRole("dialog", { name: "Task flow" });
    await board.getByTestId("task-board-enqueue").click();

    const creator = page.getByRole("dialog", { name: "Create task" });
    const routeDisclosure = creator.locator("details.task-create-dialog__line");
    if (await routeDisclosure.count()) {
      await routeDisclosure.evaluate((element: HTMLDetailsElement) => {
        element.open = true;
      });
    }
    const strip = creator.getByRole("region", {
      name: "Stations this task will travel",
    });
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("5 stops, 1 claim, 1 hard");
    await expect(
      strip.getByText(
        "Every shipment includes a reproducible verification receipt.",
        { exact: true },
      ),
    ).toHaveCount(1);
    await expect(strip.getByText("open to workers", { exact: true })).toHaveCount(0);
    await expect(
      strip.getByText("No standing law at this stop.", { exact: true }),
    ).toHaveCount(0);
    await expect(strip.getByText("2 stops on", { exact: true })).toHaveCount(1);
    await expect(strip.getByTestId("task-metro-stop-detail")).toHaveCount(0);

    for (const name of ["Intake", "Build", "Review", "Security", "Ship"]) {
      await expect(
        strip.getByRole("button", { name: new RegExp(`^${name},`) }),
      ).toBeVisible();
    }
    const branch = strip.locator('.task-metro__stage[data-branch="true"]');
    await expect(branch).toHaveCount(1);
    await expect(branch).toContainText("Review");
    await expect(branch).toContainText("Security");
    await expect(
      strip.getByText(
        "Open a stop to add a check there. A skipped branch waives only its own checks.",
        { exact: true },
      ),
    ).toHaveCount(1);
    await expect(strip.getByLabel("Check strength")).toContainText(
      "hard must be answered",
    );
    await expect(strip.getByLabel("Check strength")).toContainText(
      "soft may be waived",
    );

    await strip.getByRole("button", { name: /^Build,/ }).click();
    const details = strip.getByTestId("task-metro-stop-detail");
    await expect(details).toBeVisible();
    await expect(details.getByText("Checks at Build", { exact: true })).toBeVisible();
    await expect(details.getByRole("button", { name: "Add check" })).toBeVisible();
    await expect(
      details.getByRole("button", { name: "Copy an existing check" }),
    ).toContainText("copy existing 1");
    await expect(details.getByRole("button", { name: /claim/i })).toHaveCount(0);
    await details.getByRole("button", { name: "Copy an existing check" }).click();
    await expect(details.getByRole("button", { name: "this line 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(details.getByRole("button", { name: "entire canvas 1" })).toBeVisible();
    await expect(details).toContainText(
      "Showing checks from stations and regions on this line.",
    );
    await creator.locator("*").evaluateAll((elements) => {
      for (const element of elements) {
        if (element instanceof HTMLElement && element.scrollTop > 0) {
          element.scrollTop = 0;
        }
      }
    });

    const screenshot = join(
      process.cwd(),
      "_design_screenshots/task_metro_compact/after.png",
    );
    await creator.screenshot({ path: screenshot });
    await testInfo.attach("task-metro-after", {
      path: screenshot,
      contentType: "image/png",
    });
  } finally {
    await vellumCommand.close();
  }
});
