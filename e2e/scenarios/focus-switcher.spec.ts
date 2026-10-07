/**
 * The agent switcher: hold Cmd and tap the backtick, anywhere.
 *   bun run test:e2e:fast e2e/scenarios/focus-switcher.spec.ts
 *
 * Seats in two regions, one blocked and one ready for review. With Alpha's
 * terminal open, Cmd+backtick must:
 *   - bring the switcher up over the terminal without closing it
 *   - list the agents that need the operator first, and come up on the first
 *   - open the chosen agent when Cmd is let go
 *
 * Frames land in test-results/focus-switcher/.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSignal } from "../../src/shared/agent-signals";
import type { CanvasNode, GroupNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "focus-switcher");
const CANVAS = "focus-switcher";

const region = (
  id: string,
  label: string,
  color: string,
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): GroupNode => ({ id, type: "group", label, color, ...box });

const seat = (id: string, label: string, x: number, y: number): CanvasNode =>
  agentTextNode({ id, key: `local:e2e-switch-${id}`, label, x, y });

const nodes: ReadonlyArray<CanvasNode> = [
  region("r-junto", "Junto", "5", { x: 0, y: 0, width: 1500, height: 520 }),
  region("r-surfaces", "Surfaces", "2", { x: 40, y: 60, width: 700, height: 420 }),
  region("r-pty", "PTY", "4", { x: 780, y: 60, width: 680, height: 420 }),
  seat("alpha", "Alpha hub", 80, 120),
  seat("bravo", "Bravo peer", 380, 120),
  seat("charlie", "Charlie", 80, 300),
  seat("delta", "Delta", 820, 120),
  seat("echo", "Echo", 1120, 120),
  seat("foxtrot", "Foxtrot", 820, 300),
  seat("golf", "Golf", 1600, 120),
];

const signal = (nodeId: string, kind: AgentSignal["kind"], text: string): AgentSignal => ({
  signalId: `sig-switch-${nodeId}`,
  canvasName: CANVAS,
  nodeId,
  kind,
  text,
  createdAt: Date.now() - 3 * 60_000,
  state: "open",
});

const signals: ReadonlyArray<AgentSignal> = [
  signal("echo", "blocked", "The release key is missing from the vault."),
  signal("charlie", "feedback", "The export screen is ready to look at."),
];

test("Cmd+backtick brings up the agents, the ones that need the operator first", async () => {
  const junto = await launchJunto({
    seedCanvases: { [CANVAS]: canvasDoc([...nodes], []) },
    seedAgentSignals: signals,
  });

  try {
    const { page } = junto;
    await mkdir(SHOTS, { recursive: true });
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));

    const hubCard = page.locator('.react-flow__node[data-id="alpha"]');
    await expect(hubCard).toBeVisible({ timeout: 30_000 });
    await hubCard.dblclick();

    const front = page.locator(
      ".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface",
    );
    await expect(front).toBeVisible({ timeout: 20_000 });
    await expect(front.locator("header").first()).toContainText("Alpha hub");

    await page.keyboard.down("Meta");
    await page.keyboard.press("Backquote");

    const hud = page.getByTestId("focus-switcher");
    await expect(hud).toBeVisible({ timeout: 8_000 });
    await expect(front).toBeVisible();

    // An operator modal: the shared dim, and the list holds the keyboard.
    await expect(hud).toHaveAttribute("data-layer", "operator");
    await expect(hud.locator("[data-layer-backdrop]")).toBeVisible();
    await expect(hud.getByRole("listbox")).toBeFocused();

    // Blocked, then ready for review, then the rest by name.
    const cards = hud.getByRole("option");
    await expect(cards).toHaveCount(7);
    const order = await cards.evaluateAll((all) => all.map((card) => card.getAttribute("data-node-id")));
    expect(order.slice(0, 2)).toEqual(["echo", "charlie"]);
    const selected = page.getByTestId("focus-switcher-selected");
    await expect(selected).toHaveAttribute("data-node-id", "echo");
    // Each card says where the agent sits, and reads as agent, state, region.
    await expect(selected).toHaveAccessibleName("Echo blocked Junto / PTY");
    await expect(selected.getByTestId("focus-switcher-crumb")).toHaveText("Junto / PTY");
    await expect(hud.locator('[data-node-id="golf"]').getByTestId("focus-switcher-crumb")).toHaveCount(0);
    // The card's name is its own text: no tooltip repeats it over the card.
    await page.waitForTimeout(400);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, "switcher-dark.png") });

    await page.keyboard.press("Backquote");
    await expect(selected).toHaveAttribute("data-node-id", "charlie");

    await page.keyboard.up("Meta");
    await expect(hud).toHaveCount(0, { timeout: 8_000 });
    await expect(front.locator("header").first()).toContainText("Charlie", { timeout: 10_000 });

    // Escape closes it, nothing opened, and the keyboard is back in the terminal.
    await page.keyboard.down("Meta");
    await page.keyboard.press("Backquote");
    await expect(hud).toBeVisible({ timeout: 8_000 });
    await page.keyboard.press("Escape");
    await expect(hud).toHaveCount(0);
    await page.keyboard.up("Meta");
    await expect(front.locator("header").first()).toContainText("Charlie");
    expect(await page.evaluate(() => document.activeElement?.closest(".native-terminal-surface") !== null)).toBe(true);
  } finally {
    await junto.close();
  }
});
