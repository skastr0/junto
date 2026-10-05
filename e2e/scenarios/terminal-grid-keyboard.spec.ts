/**
 * The terminal grid and the keyboard, on live seats.
 *   bun run test:e2e:fast e2e/scenarios/terminal-grid-keyboard.spec.ts
 *
 * Three agents open in a grid from the selection's menu. Escape closes the
 * grid while no cell holds the keyboard; with a cell focused, Escape goes
 * to that agent and the grid stays. A press on the gap between cells closes
 * nothing, and the keys typed next reach the agent the operator was typing
 * to, never another one.
 */
import { crewDoc, crewOccupySeat, crewPlayFactory, crewSeat, crewSeatNode, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";

test("[fake-tui] the grid's Escape rule, and a press between cells keeps the keyboard with the agent in use", async () => {
  test.setTimeout(240_000);
  const CANVAS = "grid-keys";
  const ids = ["one", "two", "three"];
  const nodes = ids.map((id, i) => crewSeatNode({ id, x: 40 + i * 320, y: 40 }));
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: crewDoc(nodes) }, afterSeed: installCrewSeatHarness });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await crewPlayFactory(page);
    const seats = ids.map((id) => crewSeat(sandbox, CANVAS, id));
    for (const [i, node] of nodes.entries()) await crewOccupySeat(page, CANVAS, node, seats[i]!);

    const grid = page.getByTestId("terminal-grid-focus");
    const cells = grid.locator(".terminal-grid__cell");
    const openGrid = async (): Promise<void> => {
      await page.locator(".react-flow__pane").click({ position: { x: 20, y: 300 } });
      for (const id of ids) await page.locator(`.react-flow__node[data-id="${id}"]`).click({ modifiers: ["Shift"] });
      await page.locator('.react-flow__node[data-id="two"]').click({ button: "right" });
      await page.getByRole("menuitem", { name: "Open 3 agents in a grid" }).click();
      await expect(cells).toHaveCount(3, { timeout: 10_000 });
    };
    const typingInCell = (): Promise<boolean> =>
      page.evaluate(() => document.activeElement?.closest(".terminal-grid__cell") !== null && document.activeElement !== null);

    // No cell holds the keyboard: Escape closes the grid.
    await openGrid();
    await page.keyboard.press("Escape");
    await expect(grid).toHaveCount(0);

    // A cell holds it: Escape is the agent's, and the grid stays.
    await openGrid();
    await cells.nth(1).locator(".xterm").first().click();
    await expect.poll(typingInCell).toBe(true);
    await page.keyboard.type("to two");
    await page.keyboard.press("Escape");
    await expect.poll(() => seats[1]!.stdinLog(), { timeout: 15_000 }).toContain("to two\u001b");
    await expect(grid).toBeVisible();

    // Typing to three, then a press on the gap between cells one and two.
    await cells.nth(2).locator(".xterm").first().click();
    await expect.poll(typingInCell).toBe(true);
    await page.keyboard.type("to three ");
    await expect.poll(() => seats[2]!.stdinLog(), { timeout: 15_000 }).toContain("to three ");
    const first = (await cells.nth(0).boundingBox())!;
    const second = (await cells.nth(1).boundingBox())!;
    expect(second.x - (first.x + first.width), "there is a gap to press").toBeGreaterThanOrEqual(2);
    await page.mouse.click((first.x + first.width + second.x) / 2, first.y + first.height / 2);
    await expect(grid).toBeVisible();
    await page.keyboard.type("still three");
    await expect.poll(() => seats[2]!.stdinLog(), { message: "the agent in use still gets the keys", timeout: 10_000 }).toContain("to three still three");
    expect(await seats[0]!.stdinLog()).not.toContain("still three");
    expect(await seats[1]!.stdinLog()).not.toContain("still three");
  } finally {
    await junto.close();
  }
});
