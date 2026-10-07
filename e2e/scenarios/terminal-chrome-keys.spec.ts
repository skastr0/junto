/**
 * The keyboard's way out of an agent's terminal and back: Cmd+Up lands on
 * the first header button and shows it, Tab walks the header and then the
 * connections without falling into the terminal, Cmd+Down hands typing back.
 *
 *   bun run test:e2e:fast e2e/scenarios/terminal-chrome-keys.spec.ts
 */
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
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "chrome-keys";
const lead = crewSeatNode({ id: "lead", x: 40, y: 40 });
const peer = crewSeatNode({ id: "peer", x: 360, y: 40 });
const fixture = crewDoc([lead, peer], [crewMessagesEdge("e-lead-peer", "lead", "peer", [lead, peer])]);

const front = (page: Page): Locator =>
  page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");

/** Where the keyboard is: in the header, the connections, the terminal, or elsewhere. */
const place = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!active) return "nowhere";
    if (active.classList.contains("xterm-helper-textarea")) return "terminal";
    if (active.closest(".native-terminal-surface > header")) return "header";
    if (active.closest('[data-testid="actor-rail"]')) return "connections";
    return "elsewhere";
  });

test("[fake-tui] Cmd+Up shows where it landed, Tab reaches the connections, Cmd+Down returns typing", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: fixture }, afterSeed: installCrewSeatHarness });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    const seat = crewSeat(sandbox, CANVAS, "lead");
    await crewOccupySeat(page, CANVAS, lead, seat);
    await crewOccupySeat(page, CANVAS, peer, crewSeat(sandbox, CANVAS, "peer"));

    await page.locator('.react-flow__node[data-id="lead"]').dblclick();
    await expect(front(page)).toBeVisible({ timeout: 20_000 });
    await expect(front(page).getByTestId("actor-rail-go").first()).toBeVisible({ timeout: 10_000 });

    // Enter the terminal as an operator does: with a click.
    await front(page).locator(".xterm").first().click();
    await expect.poll(() => place(page)).toBe("terminal");

    // Out: the first header control has the keyboard, and a ring is drawn on it.
    await page.keyboard.press("Meta+ArrowUp");
    await expect.poll(() => place(page)).toBe("header");
    const ring = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement;
      const style = getComputedStyle(active);
      return {
        first: active === document.querySelector(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface > header button"),
        focusVisible: active.matches(":focus-visible"),
        drawn: (style.outlineStyle !== "none" && style.outlineWidth !== "0px") || style.boxShadow !== "none",
      };
    });
    expect(ring).toEqual({ first: true, focusVisible: true, drawn: true });
    await page.mouse.move(2, 2);
    await page.screenshot({ path: testInfo.outputPath("ring-after-cmd-up.png") });

    // Tab walks the header, then the connections; it never falls into the terminal.
    const walk: string[] = ["header"];
    for (let presses = 0; presses < 14 && walk[walk.length - 1] !== "connections"; presses += 1) {
      await page.keyboard.press("Tab");
      walk.push(await place(page));
    }
    expect(walk).not.toContain("terminal");
    expect(walk[walk.length - 1]).toBe("connections");
    await expect(front(page).getByTestId("actor-rail-toggle")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(front(page).getByTestId("actor-rail-go").first()).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("ring-on-connection.png") });

    // Back: typing is in the terminal again, from the connections and from the header.
    await page.keyboard.press("Meta+ArrowDown");
    await expect.poll(() => place(page)).toBe("terminal");
    await page.keyboard.press("Meta+ArrowUp");
    await expect.poll(() => place(page)).toBe("header");
    await page.keyboard.press("Meta+ArrowDown");
    await expect.poll(() => place(page)).toBe("terminal");
    // And what is typed next reaches the agent's own process.
    await page.keyboard.type("back in the shell");
    await expect.poll(() => seat.stdinLog(), { timeout: 20_000 }).toContain("back in the shell");
  } finally {
    await junto.close();
  }
});
