import type { CanvasDoc, TextNode } from "../../src/shared/canvas";
import { canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const operatorBoard = (
  id: string,
  label: string,
  x: number,
): TextNode => {
  const node = tasksNode({ id, x, y: 100, items: [] });
  return {
    ...node,
    text: label,
    ether: {
      ...node.ether,
      entity: { kind: "task", name: label },
      tasks: {
        items: [],
        name: label,
        contract: { incoming: { admission: "operator" } },
      },
    },
  };
};

const fixture = (): CanvasDoc =>
  canvasDoc(
    [
      operatorBoard("plan", "Plan", 80),
      operatorBoard("build", "Build", 400),
      operatorBoard("verify", "Verify", 720),
    ],
    [
      {
        id: "plan-build",
        fromNode: "plan",
        toNode: "build",
        ether: { verb: "feeds" },
      },
      {
        id: "build-verify",
        fromNode: "build",
        toNode: "verify",
        ether: { verb: "feeds" },
      },
    ],
  );

test("operator sends a task back to a deep visited board", async () => {
  const vellumCommand = await launchVellum({
    seedCanvases: { factory: fixture() },
  });

  try {
    const { page } = vellumCommand;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    const seeded = await page.evaluate(async () => {
      const api = window.vellumCommand!;
      const canvas = (await api.listCanvases())[0];
      if (!canvas) throw new Error("No canvas available for defect fixture");
      const created = await api.workTaskCreate(
        canvas.name,
        "plan",
        "Repair the release proof",
        { details: "Drive the real deep-target defect path." },
      );
      if (!created.ok) throw new Error(created.message);
      const taskId = created.data.id;
      const atBuild = await api.workTaskTransition(
        canvas.name,
        "plan",
        taskId,
        "completed",
        "Plan accepted",
        { artifacts: [] },
        { next: "build" },
      );
      if (!atBuild.ok) throw new Error(atBuild.message);
      const atVerify = await api.workTaskTransition(
        canvas.name,
        "build",
        taskId,
        "completed",
        "Build accepted",
        { artifacts: [] },
        { next: "verify" },
      );
      if (!atVerify.ok) throw new Error(atVerify.message);
      return { canvas: canvas.name, taskId };
    });

    const verifyNode = page.locator('.react-flow__node[data-id="verify"]');
    await expect(verifyNode).toBeVisible({ timeout: 30_000 });
    await verifyNode.getByTestId("tasks-card").dispatchEvent("dblclick");

    const board = page.getByRole("dialog", { name: "Task board" });
    await expect(board).toBeVisible();
    await board.getByLabel("Open details for Repair the release proof").click();
    const details = board.getByRole("complementary", {
      name: "Details for Repair the release proof",
    });
    await details.getByTestId("task-operator-defect-open").click();

    const targetDisclosure = details.locator(
      ".task-operator-panel__defect-targets",
    );
    await expect(targetDisclosure).toContainText("Build");
    await targetDisclosure.locator("summary").click();
    const targets = details.getByRole("group", { name: "Defect target" });
    await expect(targets.getByRole("radio", { name: "Plan" })).toBeVisible();
    await expect(targets.getByRole("radio", { name: "Build" })).toBeChecked();
    await targets.getByRole("radio", { name: "Plan" }).check();
    await expect(details).toContainText(
      "Work already accepted before Plan stays accepted; everything from Plan onward is redone.",
    );

    await details
      .getByPlaceholder("What is wrong, and what would make it right?")
      .fill("The plan chose the wrong release proof.");
    await details.getByTestId("task-operator-defect-send").click();

    await expect
      .poll(async () =>
        page.evaluate(async ({ canvas, taskId }) => {
          const read = await window.vellumCommand!.readCanvas(canvas);
          const itemAt = (nodeId: string) =>
            read.doc.nodes
              .find((node) => node.id === nodeId)
              ?.ether?.tasks?.items.find((task) => task.id === taskId);
          const returned = itemAt("plan");
          const rejected = itemAt("verify");
          return {
            returnedState: returned?.state,
            returnedHome: returned?.visits?.at(-1)?.board,
            returnedEpoch: returned?.epoch,
            defectTarget: returned?.defects?.at(-1)?.target,
            defectInThread: returned?.history.some((message) =>
              message.parts.some(
                (part) =>
                  part.kind === "text" &&
                  part.text.includes("defect from \"verify\": The plan chose the wrong release proof."),
              ),
            ),
            rejectedState: rejected?.state,
          };
        }, seeded),
      )
      .toEqual({
        returnedState: "submitted",
        returnedHome: "plan",
        returnedEpoch: 1,
        defectTarget: "plan",
        defectInThread: true,
        rejectedState: "rejected",
      });
  } finally {
    await vellumCommand.close();
  }
});
