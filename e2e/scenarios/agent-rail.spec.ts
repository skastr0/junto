import type { Locator, Page } from "@playwright/test";
import { agentTextNode, canvasDoc, verbEdge } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

/**
 * The agent modal's rail: the connected agents, each drawn by the canvas's
 * own seat, expanded or collapsed to a strip of rings. A press on a seat
 * moves the modal to that agent. A voiced preamble shows the canvas's own
 * bubble beside its seat. Everything else about the seat (mail, signals,
 * onboarding) is behind the header's details button.
 */

const CANVAS = "agent-rail";
const PEERS = ["ada", "bea", "cy"];
const nodes = [
  agentTextNode({ id: "lead", key: "local:rail-lead", label: "lead", x: 40, y: 40 }),
  ...PEERS.map((id, i) => agentTextNode({ id, key: `local:rail-${id}`, label: id, x: 360, y: 40 + i * 130 })),
  agentTextNode({ id: "solo", key: "local:rail-solo", label: "solo", x: 700, y: 40 }),
  { id: "note", type: "text" as const, text: "Field notes", x: 40, y: 420, width: 240, height: 90 },
];
const fixture = canvasDoc(nodes, [
  ...PEERS.map((id) => verbEdge(`e-lead-${id}`, "lead", id, "messages", nodes)),
  verbEdge("e-ada-bea", "ada", "bea", "messages", nodes),
]);

const front = (page: Page): Locator =>
  page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");
const rail = (page: Page): Locator => front(page).getByTestId("actor-rail");
const seatIds = (page: Page): Promise<Array<string | null>> =>
  rail(page).getByTestId("actor-rail-seat").evaluateAll((seats) => seats.map((seat) => seat.getAttribute("data-peer-node-id")));
const typingInTerminal = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") === true);

const open = async (page: Page, id: string): Promise<void> => {
  await page.locator(`.react-flow__node[data-id="${id}"]`).dblclick();
  await expect(front(page).locator("header").first()).toContainText(id, { timeout: 20_000 });
};

const say = async (junto: Awaited<ReturnType<typeof launchJunto>>, nodeId: string, text: string): Promise<void> => {
  const now = Date.now();
  await junto.app.evaluate(
    ({ BrowserWindow }, event) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send("junto:preamble", event);
    },
    { preambleId: `rail-${nodeId}-${String(now)}`, canvasName: CANVAS, nodeId, text, expiresAt: now + 60_000, provenance: "agent" },
  );
};

test("a seat in the rail is the canvas seat, and a press on it moves to that agent, expanded and collapsed", async () => {
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: fixture } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="lead"]')).toBeVisible({ timeout: 30_000 });
    await open(page, "lead");
    await expect(rail(page)).toHaveAttribute("data-rail", "expanded");
    expect((await seatIds(page)).sort()).toEqual(["ada", "bea", "cy"]);

    // The same component as the node: its test id, its 52px seat ring, its line.
    const seat = rail(page).locator('[data-peer-node-id="ada"]');
    await expect(seat.getByTestId("agent-seat")).toHaveCount(1);
    await expect(seat.locator('.junto-mark[data-mark-size="seat"] .agent-portrait')).toBeVisible();
    await expect(seat.getByTestId("agent-seat-line")).toHaveText(
      (await page.locator('.react-flow__node[data-id="ada"]').getByTestId("agent-seat-line").innerText()).trim(),
    );

    // Expanded: a press anywhere on the seat moves to ada, focus lands in her
    // terminal, and the rail is now hers.
    await seat.getByTestId("agent-seat-line").click({ force: true });
    await expect(front(page).locator("header").first()).toContainText("ada", { timeout: 20_000 });
    await expect.poll(() => typingInTerminal(page)).toBe(true);
    expect((await seatIds(page)).sort()).toEqual(["bea", "lead"]);

    // By keyboard: the seat is a real button, named for the agent and its state.
    const go = rail(page).locator('[data-peer-node-id="lead"]').getByTestId("actor-rail-go");
    await expect(go).toHaveAccessibleName(/^Go to lead, /);
    await go.focus();
    // The keyboard stays where the operator put it while ada's session settles
    // under it: the terminal does not take focus back from the rail.
    await expect(front(page).locator(".native-terminal-surface__status")).not.toContainText("starting", { timeout: 20_000 });
    await page.waitForTimeout(500);
    await expect(go).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(front(page).locator("header").first()).toContainText("lead", { timeout: 20_000 });
    await expect.poll(() => typingInTerminal(page)).toBe(true);

    // Collapsed: the same seat, ring alone, and the portrait still moves.
    await rail(page).getByTestId("actor-rail-toggle").click();
    await expect(rail(page)).toHaveAttribute("data-rail", "collapsed");
    const strip = rail(page).locator('[data-peer-node-id="cy"]');
    await expect(strip.getByTestId("agent-seat")).toHaveCount(1);
    await expect(strip.locator('.junto-mark[data-mark-size="seat"] .agent-portrait')).toBeVisible();
    await expect(strip.getByTestId("agent-seat-line")).toHaveCount(0);
    await strip.locator(".agent-portrait").click({ force: true });
    await expect(front(page).locator("header").first()).toContainText("cy", { timeout: 20_000 });
    await expect.poll(() => typingInTerminal(page)).toBe(true);
    expect(await seatIds(page)).toEqual(["lead"]);

    // The choice holds for the next agent, and right after an expand the press still works.
    await expect(rail(page)).toHaveAttribute("data-rail", "collapsed");
    await rail(page).getByTestId("actor-rail-toggle").click();
    await expect(rail(page)).toHaveAttribute("data-rail", "expanded");
    await rail(page).locator('[data-peer-node-id="lead"]').getByTestId("actor-rail-go").click();
    await expect(front(page).locator("header").first()).toContainText("lead", { timeout: 20_000 });
  } finally {
    await junto.close();
  }
});

test("the rail snaps between its two widths, and a seat with no connections has none", async () => {
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: fixture } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="lead"]')).toBeVisible({ timeout: 30_000 });
    await open(page, "lead");
    const stage = front(page).locator(".native-terminal-surface__stage");
    // Polled: the panel settles from its entry animation first.
    await expect.poll(async () => Math.round((await rail(page).boundingBox())!.width)).toBe(248);
    const wide = (await stage.boundingBox())!.width;

    await rail(page).getByTestId("actor-rail-toggle").click();
    await expect(rail(page)).toHaveAttribute("data-rail", "collapsed");
    await expect.poll(async () => Math.round((await rail(page).boundingBox())!.width)).toBe(68);
    // The terminal never loses room to a collapse.
    await expect.poll(async () => (await stage.boundingBox())!.width).toBeGreaterThanOrEqual(wide);
    // Other connections wait for the expanded rail.
    await expect(rail(page).getByTestId("actor-rail-others")).toHaveCount(0);

    await front(page).locator("header").getByRole("button", { name: "Close view", exact: true }).first().click();
    await open(page, "solo");
    await expect(front(page).getByTestId("actor-rail")).toHaveCount(0);
    // No empty column: the stage ends where the body ends.
    const body = front(page).locator(".native-terminal-surface__body");
    const lone = front(page).locator(".native-terminal-surface__stage");
    await expect
      .poll(async () => {
        const [stageBox, bodyBox] = [(await lone.boundingBox())!, (await body.boundingBox())!];
        return Math.abs(stageBox.x + stageBox.width - (bodyBox.x + bodyBox.width));
      })
      .toBeLessThan(1);
  } finally {
    await junto.close();
  }
});

test("a voiced preamble shows the canvas bubble beside its seat and never takes the keyboard", async () => {
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: fixture } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="lead"]')).toBeVisible({ timeout: 30_000 });
    await open(page, "lead");
    await front(page).locator(".xterm").first().click();
    await expect.poll(() => typingInTerminal(page)).toBe(true);

    for (const mode of ["expanded", "collapsed"] as const) {
      if (mode === "collapsed") await rail(page).getByTestId("actor-rail-toggle").click();
      await expect(rail(page)).toHaveAttribute("data-rail", mode);
      await front(page).locator(".xterm").first().click();
      await say(junto, "bea", `rolling out step two (${mode})`);

      // The same element the canvas node wears: test id, class, card.
      const bubble = rail(page).locator('[data-testid="node-preamble"][data-node-id="bea"]');
      await expect(bubble).toBeVisible({ timeout: 10_000 });
      await expect(bubble).toHaveClass(/(^| )junto-preamble( |$)/);
      await expect(bubble.locator(".junto-preamble__card .junto-preamble__text")).toHaveText(`rolling out step two (${mode})`);
      await expect(page.locator('.react-flow__node[data-id="bea"] [data-testid="node-preamble"]')).toHaveCount(1);

      // It did not move the keyboard, and it sits beside the rail, over no seat.
      expect(await typingInTerminal(page)).toBe(true);
      const card = (await bubble.locator(".junto-preamble__card").boundingBox())!;
      const railBox = (await rail(page).boundingBox())!;
      expect(card.x + card.width).toBeLessThanOrEqual(railBox.x);

      // A press on the seat beside its bubble still moves to that agent.
      await rail(page).locator('[data-peer-node-id="bea"]').getByTestId("actor-rail-go").click();
      await expect(front(page).locator("header").first()).toContainText("bea", { timeout: 20_000 });
      await rail(page).locator('[data-peer-node-id="lead"]').getByTestId("actor-rail-go").click();
      await expect(front(page).locator("header").first()).toContainText("lead", { timeout: 20_000 });

      // Its own close button dismisses it, on the canvas too: one store.
      await rail(page).locator('[data-testid="node-preamble"][data-node-id="bea"] .junto-preamble__close').click({ force: true });
      await expect(rail(page).locator('[data-testid="node-preamble"][data-node-id="bea"]')).toHaveCount(0);
      await expect(page.locator('.react-flow__node[data-id="bea"] [data-testid="node-preamble"]')).toHaveCount(0);
    }
  } finally {
    await junto.close();
  }
});

test("pinned beside the canvas, the rail moves to an agent in the dock and hands it the keyboard", async () => {
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: fixture } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="lead"]')).toBeVisible({ timeout: 30_000 });
    await open(page, "lead");
    await front(page).locator("header").getByRole("button", { name: "Pin", exact: true }).click();
    const dock = page.locator(".work-surface-dock--pinned");
    await expect(dock.getByTestId("actor-rail")).toHaveAttribute("data-zone", "pinned");
    await expect(page.locator('[data-focus-surface="1"]')).toHaveCount(0);

    await dock.locator('[data-peer-node-id="ada"]').getByTestId("actor-rail-go").click();
    const shown = dock.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");
    await expect(shown.locator("header").first()).toContainText("ada", { timeout: 20_000 });
    // Still pinned, no modal; the keyboard is in ada's terminal, and lead stays in the dock behind her.
    await expect(page.locator('[data-focus-surface="1"]')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement;
          return (
            active?.classList.contains("xterm-helper-textarea") === true &&
            active.closest(".work-surface-dock--pinned .workbench-pane:not(.workbench-pane--parked)") !== null
          );
        }),
      )
      .toBe(true);
    await expect(dock.locator(".native-terminal-surface")).toHaveCount(2);
  } finally {
    await junto.close();
  }
});

test("seat details open from the header and hold what left the rail", async () => {
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: fixture } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="lead"]')).toBeVisible({ timeout: 30_000 });
    await open(page, "lead");
    // Nothing but agents in the rail.
    await expect(rail(page).getByTestId("actor-ledger-mail")).toHaveCount(0);

    // Opened from a focused terminal, it gives the keyboard back when it closes.
    await front(page).locator(".xterm").first().click();
    await expect.poll(() => typingInTerminal(page)).toBe(true);
    await front(page).locator("header").getByTestId("seat-details-button").click();
    const details = page.locator('[data-layer="popover"][data-testid="seat-details-popover"]');
    await expect(details).toBeVisible();
    await expect(details.getByTestId("actor-ledger-mail")).toContainText("No mail yet");
    await expect(details.getByText(/delivered|prompt|notice/i)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
    // Escape closed the popover only, and typing goes to the terminal again.
    await expect(front(page)).toBeVisible();
    await expect.poll(() => typingInTerminal(page)).toBe(true);
  } finally {
    await junto.close();
  }
});
