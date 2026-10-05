import type { Locator, Page } from "@playwright/test";
import {
  crewDoc,
  crewMessagesEdge,
  crewOccupySeat,
  crewPlayFactory,
  crewSeat,
  crewSeatNode,
  installCrewSeatHarness,
} from "../harness/crew-fixture";
import { agentTextNode, canvasDoc, verbEdge } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

/**
 * The agent modal's rail at its edges, found by driving the real app in the
 * operator's dark theme: a press on blank chrome, a seat line beside its
 * onboarding chip, and a bubble beside an agent whose session has ended.
 */

const CANVAS = "rail-edges";
const PEERS = ["ada", "bea", "cy"];
const nodes = [
  agentTextNode({ id: "lead", key: "local:edges-lead", label: "lead", x: 40, y: 40 }),
  ...PEERS.map((id, i) => agentTextNode({ id, key: `local:edges-${id}`, label: id, x: 360, y: 40 + i * 130 })),
];
const fixture = canvasDoc(nodes, PEERS.map((id) => verbEdge(`e-lead-${id}`, "lead", id, "messages", nodes)));

const front = (page: Page): Locator =>
  page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");
const rail = (page: Page): Locator => front(page).getByTestId("actor-rail");
const header = (page: Page): Locator => front(page).locator("header").first();
const typingInTerminal = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") === true);

const dark = async (page: Page): Promise<void> => {
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

/** The point inside `locator` where nothing but the locator itself is hit: blank chrome. */
const blankPoint = (locator: Locator): Promise<{ x: number; y: number } | null> =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    for (let y = box.bottom - 6; y > box.top + 4; y -= 8) {
      for (let x = box.left + 6; x < box.right - 4; x += 8) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || !element.contains(hit)) continue;
        if (hit.closest("button, a, input, textarea, select, [role='button'], [tabindex], .xterm, .junto-preamble")) continue;
        return { x, y };
      }
    }
    return null;
  });

test("[fake-tui] a press on blank chrome of the agent modal leaves the keyboard in the terminal", async () => {
  test.setTimeout(240_000);
  const LIVE = "rail-edges-blank";
  const lead = crewSeatNode({ id: "lead", x: 40, y: 40 });
  const peer = crewSeatNode({ id: "peer", x: 360, y: 40 });
  const junto = await launchJunto({
    seedCanvases: { [LIVE]: crewDoc([lead, peer], [crewMessagesEdge("e-lp", "lead", "peer", [lead, peer])]) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await dark(page);
    await crewPlayFactory(page);
    const leadSeat = crewSeat(sandbox, LIVE, "lead");
    await crewOccupySeat(page, LIVE, lead, leadSeat);
    await crewOccupySeat(page, LIVE, peer, crewSeat(sandbox, LIVE, "peer"));
    await page.locator('.react-flow__node[data-id="lead"]').dblclick();
    await expect(header(page)).toContainText("lead", { timeout: 20_000 });
    await expect(rail(page)).toHaveAttribute("data-rail", "expanded");

    let typed = "";
    const pressBlank = async (where: string, target: Locator, word: string): Promise<void> => {
      await front(page).locator(".xterm").first().click();
      await expect.poll(() => typingInTerminal(page)).toBe(true);
      const point = await blankPoint(target);
      expect(point, `${where}: no blank point found`).not.toBeNull();
      await page.mouse.click(point!.x, point!.y);
      await expect.poll(() => typingInTerminal(page), { message: `after a press on ${where}`, timeout: 3_000 }).toBe(true);
      // The modal is still up, and what the operator types next reaches the agent.
      await expect(header(page)).toContainText("lead");
      await page.keyboard.type(word);
      typed += word;
      await expect.poll(() => leadSeat.stdinLog(), { timeout: 20_000 }).toContain(typed);
    };

    await pressBlank("the blank header", header(page), "one ");
    await pressBlank("the empty rail under the seats, expanded", rail(page).locator(".actor-rail__list"), "two ");
    await rail(page).getByTestId("actor-rail-toggle").click();
    await expect(rail(page)).toHaveAttribute("data-rail", "collapsed");
    await pressBlank("the empty rail under the seats, collapsed", rail(page).locator(".actor-rail__list"), "three ");

    // With the seat details open, the same press closes them and the keyboard is back.
    await front(page).locator(".xterm").first().click();
    await header(page).getByTestId("seat-details-button").click();
    const details = page.locator('[data-layer="popover"][data-testid="seat-details-popover"]');
    await expect(details).toBeVisible();
    const point = await blankPoint(header(page));
    await page.mouse.click(point!.x, point!.y);
    await expect(details).toHaveCount(0);
    await expect.poll(() => typingInTerminal(page), { timeout: 3_000 }).toBe(true);

    // A control keeps what it did: the toggle keeps its own focus, a seat still moves.
    const toggle = rail(page).getByTestId("actor-rail-toggle");
    await toggle.click();
    await expect(rail(page)).toHaveAttribute("data-rail", "expanded");
    await page.waitForTimeout(400);
    expect(await typingInTerminal(page), "a press on the rail toggle is not a blank press").toBe(false);
    await rail(page).getByTestId("actor-rail-seat").getByTestId("actor-rail-go").click();
    await expect(header(page)).toContainText("peer", { timeout: 20_000 });
    await expect.poll(() => typingInTerminal(page)).toBe(true);
  } finally {
    await junto.close();
  }
});

test("a bubble beside an agent whose session has ended can still be read and closed", async () => {
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: fixture } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="lead"]')).toBeVisible({ timeout: 30_000 });
    await dark(page);
    await page.locator('.react-flow__node[data-id="lead"]').dblclick();
    await expect(header(page)).toContainText("lead", { timeout: 20_000 });
    // No harness is installed in the sandbox, so the session ends and the surface says so.
    await expect(front(page).locator(".native-terminal-surface__dead")).toBeVisible({ timeout: 30_000 });

    for (const mode of ["expanded", "collapsed"] as const) {
      if (mode === "collapsed") await rail(page).getByTestId("actor-rail-toggle").click();
      await expect(rail(page)).toHaveAttribute("data-rail", mode);
      const now = Date.now();
      await junto.app.evaluate(
        ({ BrowserWindow }, event) => {
          for (const window of BrowserWindow.getAllWindows()) window.webContents.send("junto:preamble", event);
        },
        { preambleId: `edges-${mode}-${String(now)}`, canvasName: CANVAS, nodeId: "ada", text: `speaking beside an ended session (${mode})`, expiresAt: now + 60_000, provenance: "agent" },
      );
      const bubble = rail(page).locator('[data-testid="node-preamble"][data-node-id="ada"]');
      await expect(bubble).toBeVisible({ timeout: 10_000 });
      // Nothing lies over the card or its close button.
      for (const part of [".junto-preamble__card", ".junto-preamble__close"]) {
        const onTop = await bubble.locator(part).evaluate((element) => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return hit?.closest(".junto-preamble") ? "bubble"
            : `${hit?.tagName.toLowerCase() ?? "nothing"}.${String(hit?.className ?? "")}`;
        });
        expect(onTop, `${mode}: what is on top at the centre of ${part}`).toBe("bubble");
      }
      // A real press, not a forced one, closes it.
      await bubble.locator(".junto-preamble__close").click({ timeout: 5_000 });
      await expect(bubble).toHaveCount(0);
    }
  } finally {
    await junto.close();
  }
});

test("[fake-tui] a rail seat that is not onboarded still shows its whole state line", async () => {
  test.setTimeout(240_000);
  const LIVE = "rail-edges-live";
  const lead = crewSeatNode({ id: "lead", x: 40, y: 40 });
  const peer = crewSeatNode({ id: "peer", x: 360, y: 40 });
  const junto = await launchJunto({
    seedCanvases: { [LIVE]: crewDoc([lead, peer], [crewMessagesEdge("e-lp", "lead", "peer", [lead, peer])]) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await dark(page);
    await crewPlayFactory(page);
    const peerSeat = crewSeat(sandbox, LIVE, "peer");
    await crewOccupySeat(page, LIVE, lead, crewSeat(sandbox, LIVE, "lead"));
    await crewOccupySeat(page, LIVE, peer, peerSeat);
    await page.locator('.react-flow__node[data-id="lead"]').dblclick();
    await expect(front(page)).toBeVisible({ timeout: 20_000 });
    const seat = rail(page).getByTestId("actor-rail-seat");
    const line = seat.getByTestId("agent-seat-line");

    // Working, then idle: the seat finished and nobody has read it. Its longest ordinary line.
    await peerSeat.control({ screen: { mode: "working" } });
    await expect(line).toHaveText("working", { timeout: 20_000 });
    await peerSeat.control({ screen: { mode: "idle" } });
    await expect(line).toHaveText("done, not read yet", { timeout: 20_000 });
    await expect(seat).toContainText(/not onboarded/i);
    // The words are all on screen: the line is not cut to an ellipsis.
    const cut = await line.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    expect(cut.scroll, `the state line needs ${String(cut.scroll)}px and has ${String(cut.client)}px`).toBeLessThanOrEqual(cut.client);
  } finally {
    await junto.close();
  }
});
