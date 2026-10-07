/**
 * Space and the control that has the keyboard: on a canvas node Space is
 * the step to the next agent; on a button it presses the button.
 *
 *   bun run test:e2e:fast e2e/scenarios/space-on-control.spec.ts
 */
import type { Locator } from "@playwright/test";
import { crewDoc, crewSeatNode } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";

test("Space with a canvas node focused goes to the next agent; on a top bar button it presses the button", async () => {
  const SPACE = "chrome-keys-space";
  const a = crewSeatNode({ id: "a", x: 40, y: 40 });
  const b = crewSeatNode({ id: "b", x: 360, y: 40 });
  const junto = await launchJunto({ seedCanvases: { [SPACE]: crewDoc([a, b]) } });
  try {
    const { page } = junto;
    const node = (id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(node("a")).toBeVisible({ timeout: 30_000 });
    const selected = (): Promise<Array<string | null>> =>
      page.locator(".react-flow__node.selected").evaluateAll((nodes) => nodes.map((el) => el.getAttribute("data-id")));

    // The node itself has the keyboard: Space is the step to the next agent.
    await node("a").click();
    await node("a").focus();
    await expect(node("a")).toBeFocused();
    await expect.poll(selected).toEqual(["a"]);
    await page.keyboard.press("Space");
    await expect.poll(selected).toEqual(["b"]);

    // A button has the keyboard: Space presses it, and the selection stays.
    await page.getByRole("button", { name: "Open settings" }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect.poll(selected).toEqual(["b"]);
  } finally {
    await junto.close();
  }
});
