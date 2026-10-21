/**
 * A removed seat lets go of its task (seat-release.ts). The delete asks with
 * the task named, the task goes back to the backlog, and an undo after the
 * task changed says it stays there.
 *
 * Run: `bun run test:e2e:fast e2e/scenarios/seat-release.spec.ts` after a build.
 */
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { modelFixture, modelNode, modelSeat } from "../harness/model";
import { expect, test } from "../harness/launch";

const CANVAS = "seat-release";

test.use({
  juntoOptions: {
    seedModels: {
      [CANVAS]: modelFixture([
        modelSeat({ id: "ada", label: "Ada", x: 0, y: 80 }),
        modelNode({ kind: "task", id: "board", name: "Board", x: 400, y: 80, width: 240, height: 120, z: 0 }),
      ]),
    },
  },
});

const undoKey = process.platform === "darwin" ? "Meta+z" : "Control+z";

test("a seat's delete names its task, sends it to the backlog, and an undo after a change keeps it there", async ({ junto }) => {
  const { page } = junto;
  const seat = page.getByTestId("rf__node-ada");
  await expect(seat).toBeVisible({ timeout: 30_000 });

  const taskId = mintItemId();
  const apply = (command: unknown) =>
    page.evaluate(
      ({ canvas, taskId, opId, command }) =>
        (window as unknown as { junto: { resource: { task: { apply: (...args: unknown[]) => Promise<{ kind: string }> } } } })
          .junto.resource.task.apply(canvas, "board", taskId, opId, command),
      { canvas: CANVAS, taskId, opId: mintOpId(), command },
    );
  expect((await apply({ kind: "create", taskId, title: "fix tabs" })).kind).toBe("applied");
  expect((await apply({ kind: "assign", seat: "ada" })).kind).toBe("applied");

  // Electron's native confirm is not drivable from here: answer it in page, keeping what it asked.
  await page.evaluate(() => {
    const host = window as unknown as { __asked?: string[] };
    host.__asked = [];
    window.confirm = (message?: string) => {
      host.__asked?.push(message ?? "");
      return true;
    };
  });
  await seat.click({ position: { x: 8, y: 8 } });
  await expect(seat).toHaveClass(/selected/);
  await page.screenshot({ path: "test-results/seat-release/1-seat-selected.png" });
  await page.keyboard.press("Backspace");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __asked?: string[] }).__asked ?? [])).toHaveLength(1);
  const asked = (await page.evaluate(() => (window as unknown as { __asked?: string[] }).__asked ?? []))[0] ?? "";
  console.log(`delete asked: ${JSON.stringify(asked)}`);
  expect(asked).toContain("“Ada” holds #1 fix tabs; it goes back to the backlog.");
  await expect(seat).toHaveCount(0);
  await page.screenshot({ path: "test-results/seat-release/2-seat-deleted.png" });

  // A command rules on the task after the delete: the undo cannot give it back.
  expect((await apply({ kind: "edit", title: "fix the tabs" })).kind).toBe("applied");
  await page.keyboard.press(undoKey);
  await expect(seat).toBeVisible();
  const banner = page.locator(".error-banner__message");
  await expect(banner).toHaveText("1 task stays in the backlog: it was changed after the seat was removed.");
  await page.screenshot({ path: "test-results/seat-release/3-undo-kept.png" });
});
