/**
 * cmd+K rows show the node, not its kind.
 *
 * An agent row is the seat itself: its portrait in the live ring, the
 * harness in words, and the line its canvas seat is saying. A region row
 * wears the region's colour; every other kind wears its own hue. Frames land
 * in test-results/command-bar-faces/.
 *
 *   bun run test:e2e:fast e2e/scenarios/command-bar-faces.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { AgentSignal } from "../../src/shared/agent-signals";
import type { CanvasNode, GroupNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "command-bar-faces");
const CANVAS = "faces";

const region = (id: string, label: string, color: string | undefined, x: number, instruction?: string): GroupNode => ({
  id,
  type: "group",
  label,
  ...(color ? { color } : {}),
  x,
  y: 0,
  width: 900,
  height: 420,
  ...(instruction ? { ether: { region: { instruction } } } : {}),
});

const note = (id: string, text: string, x: number, y: number): CanvasNode => ({
  id,
  type: "text",
  text,
  x,
  y,
  width: 240,
  height: 96,
});

const nodes: ReadonlyArray<CanvasNode> = [
  region("r-junto", "Junto", "5", 0),
  region("r-yakjev", "Yakjev", "2", 1000),
  region("r-research", "Research", undefined, 2000, "Read the papers the operator flags and write one page each."),
  agentTextNode({ id: "yakjev-1", key: "local:e2e-faces-1", label: "yakjev-1", harness: "claude", x: 1040, y: 60 }),
  agentTextNode({ id: "yakjev-2", key: "local:e2e-faces-2", label: "yakjev-2", harness: "codex", x: 1320, y: 60 }),
  agentTextNode({ id: "junto-1", key: "local:e2e-faces-3", label: "junto-1", harness: "claude", x: 40, y: 60 }),
  note("n-plan", "Production deploy plan\nKeep the staging fleet one build behind main.", 40, 240),
  note("n-sense", "Making sense of things\nAn assistant that knows all my stuff, across the board.", 2040, 60),
  { id: "l-docs", type: "link", url: "https://example.com/handbook", x: 2040, y: 240, width: 240, height: 96 },
  { id: "f-spec", type: "file", file: "docs/security-doctrine.md", x: 2320, y: 240, width: 240, height: 96 },
];

const signals: ReadonlyArray<AgentSignal> = [
  {
    signalId: "sig-faces-1",
    canvasName: CANVAS,
    nodeId: "yakjev-2",
    kind: "escalate",
    text: "Should the export include archived projects?",
    createdAt: Date.now() - 4 * 60_000,
    state: "open",
  },
];

test.use({ juntoOptions: { seedCanvases: { [CANVAS]: canvasDoc([...nodes], []) }, seedAgentSignals: signals } });

const setTheme = async (page: Page, theme: "dark" | "bright"): Promise<void> => {
  await page.evaluate((mode) => window.junto!.settingsPatch({ appearance: { theme: mode } }), theme);
  // Dark is the default edition and carries no attribute.
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
  await page.waitForTimeout(250);
};

const capture = async (page: Page, theme: "dark" | "bright"): Promise<void> => {
  await setTheme(page, theme);
  await page.keyboard.press("Meta+k");
  const input = page.getByTestId("command-bar-input");
  await expect(input).toBeVisible();
  await page.mouse.move(4, 700);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${theme}-01-all.png`) });

  await input.fill("yakje");
  await expect(page.locator(".command-bar__row-title")).toHaveText(["Yakjev", "yakjev-1", "yakjev-2"]);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${theme}-02-agents.png`) });
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
};

test("cmd+K rows: agents as ringed seats, regions and kinds in colour", async ({ junto }) => {
  const { page } = junto;
  await mkdir(SHOTS, { recursive: true });
  await expect(page.locator(".react-flow__node", { hasText: "yakjev-1" })).toBeVisible({ timeout: 30_000 });

  await page.keyboard.press("Meta+k");
  const rows = page.locator(".command-bar__row");
  const agent = rows.filter({ hasText: "yakjev-1" });
  // The seat, not a generic robot: the portrait in its ring, the harness in words.
  await expect(agent.locator(".agent-portrait")).toHaveCount(1);
  await expect(agent.locator(".command-bar__row-detail")).toContainText("Claude Code — ");
  await expect(rows.filter({ hasText: "local:" })).toHaveCount(0);
  // An open signal outranks the control state, as on the canvas seat.
  await expect(rows.filter({ hasText: "yakjev-2" }).locator(".command-bar__row-detail")).toContainText(
    "Codex — waiting on you Should the export include archived projects?",
  );
  // A region wears its own colour; an uncoloured one stays neutral and says its briefing.
  const mark = (title: string) =>
    rows.filter({ has: page.locator(".command-bar__row-title", { hasText: new RegExp(`^${title}$`) }) }).locator(".command-bar__mark");
  await expect(mark("Yakjev")).toHaveAttribute("style", /--mark-hue: var\(--color-orange\)/);
  await expect(mark("Junto")).toHaveAttribute("style", /--mark-hue: var\(--color-cyan\)/);
  await expect(mark("Research")).toHaveAttribute("style", /--mark-hue: var\(--color-dim\)/);
  await expect(rows.filter({ hasText: "Research" }).locator(".command-bar__row-detail")).toHaveText(
    "Read the papers the operator flags and write one page each.",
  );
  await expect(mark("Production deploy plan")).toHaveAttribute("style", /--mark-hue: var\(--color-gold\)/);
  await page.keyboard.press("Escape");

  await capture(page, "dark");
  await capture(page, "bright");
});
