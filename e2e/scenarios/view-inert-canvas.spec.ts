/**
 * The canvas under an open view is inert.
 *   bun run test:e2e:fast e2e/scenarios/view-inert-canvas.spec.ts
 *
 * With an agent's view open, nothing on the canvas behind it can take the
 * keyboard: not a node, not an edge label. Tab can never land on something
 * the view covers. Closing the view gives the canvas back.
 */
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

test("with a view open the canvas behind it cannot take the keyboard", async () => {
  const junto = await launchJunto({
    seedCanvases: {
      "view-inert": canvasDoc(
        [
          agentTextNode({ id: "one", key: "local:e2e-inert-one", label: "One", x: 40, y: 40 }),
          agentTextNode({ id: "two", key: "local:e2e-inert-two", label: "Two", x: 440, y: 40 }),
        ],
        [{ id: "e-one-two", fromNode: "one", toNode: "two" }],
      ),
    },
  });
  try {
    const { page } = junto;
    const canvas = page.locator(".react-flow");
    const node = page.locator('.react-flow__node[data-id="two"]');
    await expect(node).toBeVisible({ timeout: 30_000 });
    await expect(canvas).not.toHaveAttribute("inert");

    await page.locator('.react-flow__node[data-id="one"]').dblclick();
    const view = page.locator("[data-focus-surface]");
    await expect(view.locator(".native-terminal-surface").first()).toBeVisible({ timeout: 20_000 });
    await expect(canvas).toHaveAttribute("data-modal-inert", "");

    // A late focus call, or a Tab that walked off the end of the view: it does not land.
    await node.evaluate((el) => (el as HTMLElement).focus());
    expect(await node.evaluate((el) => el.contains(document.activeElement))).toBe(false);
    expect(await view.evaluate((el) => el.contains(document.activeElement))).toBe(true);

    // Inert also stops the pointer, and nothing is lost by it: the view and
    // its dim paint over every part of the canvas, so no press was meant for it.
    const covered = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".react-flow__node")).every((card) => {
        const box = card.getBoundingClientRect();
        const front = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return front !== null && front.closest("[data-focus-surface]") !== null;
      }),
    );
    expect(covered, "every card on the canvas is painted over by the view").toBe(true);

    await page.keyboard.press("Meta+w");
    await expect(view).toHaveCount(0);
    await expect(canvas).not.toHaveAttribute("inert");
  } finally {
    await junto.close();
  }
});
