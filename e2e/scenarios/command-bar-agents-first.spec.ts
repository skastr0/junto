/**
 * cmd+K is an agent switcher first.
 *
 * The palette fills most of the window height. With no query the agents lead,
 * most urgent first (blocked, waiting on you, ready for review, working,
 * resting, offline), then regions, notes, and every other kind. With a query
 * agents rank above other kinds at the same match quality. Each agent row is
 * the canvas seat's own live ring: its loop steps on the shared clock while
 * the row is on screen, even with the canvas pulled back to the far tier, and
 * holds still under reduced motion. Frames land in
 * test-results/command-bar-agents-first/.
 *
 *   bun run test:e2e:fast e2e/scenarios/command-bar-agents-first.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { AgentSignal, AgentSignalKind } from "../../src/shared/agent-signals";
import type { CanvasNode, GroupNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "command-bar-agents-first");
const CANVAS = "agents-first";
const CREW = 24;

const region = (id: string, label: string, color: string, x: number): GroupNode => ({
  id,
  type: "group",
  label,
  color,
  x,
  y: 0,
  width: 2000,
  height: 900,
});

const seat = (id: string, x: number, y: number): CanvasNode =>
  agentTextNode({ id, key: `local:e2e-first-${id}`, label: id, harness: "claude", x, y });

const crew = Array.from({ length: CREW }, (_, i) => `crew-${String(i + 1).padStart(2, "0")}`);

// Document order buries the agents under other kinds and puts the most urgent
// seat last, so every rank in the list is the ranking's doing.
const nodes: ReadonlyArray<CanvasNode> = [
  { id: "l-docs", type: "link", url: "https://example.com/handbook", x: 2240, y: 400, width: 240, height: 96 },
  { id: "n-runbook", type: "text", text: "Ops runbook\nRestart order for the staging fleet.", x: 2240, y: 60, width: 240, height: 96 },
  region("r-ops", "Ops", "5", 0),
  region("r-research", "Research", "2", 2200),
  seat("ops-idle", 40, 60),
  seat("ops-review", 320, 60),
  ...crew.map((id, i) => seat(id, 40 + (i % 7) * 280, 220 + Math.floor(i / 7) * 160)),
  seat("ops-waiting", 600, 60),
  seat("ops-blocked", 880, 60),
];

const signal = (nodeId: string, kind: AgentSignalKind, text: string): AgentSignal => ({
  signalId: `sig-first-${nodeId}`,
  canvasName: CANVAS,
  nodeId,
  kind,
  text,
  createdAt: Date.now() - 60_000,
  state: "open",
});

const signals: ReadonlyArray<AgentSignal> = [
  signal("ops-blocked", "blocked", "The staging database refuses the new migration."),
  signal("ops-waiting", "escalate", "Should the export include archived projects?"),
  signal("ops-review", "feedback", "The release notes are drafted."),
  ...crew.map((id) => signal(id, "feedback", "Done, ready for a look.")),
];

test.use({ juntoOptions: { seedCanvases: { [CANVAS]: canvasDoc([...nodes], []) }, seedAgentSignals: signals } });

/** Pull the camera back with ctrl+wheel until the viewport scale is near `goal`. */
const zoomTo = async (page: Page, goal: number): Promise<void> => {
  await page.evaluate((target) => {
    const read = (): number =>
      new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a;
    const flow = document.querySelector(".react-flow")!.getBoundingClientRect();
    for (let i = 0; i < 200; i += 1) {
      const now = read();
      if (Math.abs(now - target) / target < 0.04) break;
      document.querySelector(".react-flow__pane")?.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: now > target ? 20 : -20,
          ctrlKey: true,
          clientX: flow.x + flow.width / 2,
          clientY: flow.y + flow.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }, goal);
  await page.waitForTimeout(1_200);
};

const setTheme = async (page: Page, theme: "dark" | "bright"): Promise<void> => {
  await page.evaluate((mode) => window.junto!.settingsPatch({ appearance: { theme: mode } }), theme);
  // Dark is the default edition and carries no attribute.
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
  await page.waitForTimeout(250);
};

const frameOf = (page: Page): Promise<string | null> => page.locator("html").getAttribute("data-mark-frame");

test("cmd+K: tall, agents first by urgency, live rings on visible rows", async ({ junto }) => {
  const { page } = junto;
  await mkdir(SHOTS, { recursive: true });
  await expect(page.locator(".react-flow__node", { hasText: "ops-blocked" })).toBeVisible({ timeout: 30_000 });
  // The operator's board: pulled back past the near tier.
  await zoomTo(page, 0.25);
  await expect(page.locator("html")).toHaveAttribute("data-canvas-tier", "far");

  await page.keyboard.press("Meta+k");
  const input = page.getByTestId("command-bar-input");
  await expect(input).toBeVisible();
  const titles = page.locator(".command-bar__row-title");

  // Tall: the list fills most of the window.
  const palette = await page.locator(".command-bar").boundingBox();
  const windowHeight = await page.evaluate(() => window.innerHeight);
  expect(palette!.height).toBeGreaterThan(windowHeight * 0.88);

  // Empty query: agents by urgency, then regions, notes, other kinds.
  await expect(titles.first()).toHaveText("ops-blocked");
  const order = await titles.allTextContents();
  expect(order.slice(0, 3)).toEqual(["ops-blocked", "ops-waiting", "ops-review"]);
  expect(order.slice(3, 3 + CREW)).toEqual(crew);
  expect(order.slice(3 + CREW)).toEqual(["ops-idle", "Ops", "Research", "Ops runbook", "example.com"]);
  const rows = page.locator(".command-bar__row");
  await expect(rows.first().locator(".command-bar__row-detail")).toContainText("blocked The staging database");

  // Live rings: the first row's loop steps on the shared clock at the far tier.
  const firstMark = rows.first().locator(".junto-mark");
  await expect(firstMark).toHaveAttribute("data-mark-motion", "loop");
  await expect(firstMark).toHaveAttribute("data-mark-visible", "");
  const before = await frameOf(page);
  await expect.poll(() => frameOf(page), { timeout: 2_000 }).not.toBe(before);
  // Only rows on screen animate: the last crew row is below the fold until scrolled to.
  const lastCrew = rows.filter({ hasText: crew[CREW - 1]! }).locator(".junto-mark");
  await expect(lastCrew).toHaveAttribute("data-mark-motion", "loop");
  await expect(lastCrew).not.toHaveAttribute("data-mark-visible", "");
  await page.locator(".command-bar__list").evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await expect(lastCrew).toHaveAttribute("data-mark-visible", "");
  await expect(firstMark).not.toHaveAttribute("data-mark-visible", "");
  await page.locator(".command-bar__list").evaluate((list) => {
    list.scrollTop = 0;
  });

  for (const theme of ["dark", "bright"] as const) {
    await setTheme(page, theme);
    await page.mouse.move(4, 700);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${theme}-01-empty.png`) });
  }
  await setTheme(page, "dark");

  // A query: agents above other kinds at the same match quality; the rest
  // keep document order (the note was authored before the region). The crew
  // match last, through their region path alone.
  await input.fill("ops");
  await expect(titles).toHaveText([
    "ops-blocked",
    "ops-waiting",
    "ops-review",
    "ops-idle",
    "Ops runbook",
    "Ops",
    ...crew,
  ]);
  await page.screenshot({ path: join(SHOTS, "dark-02-query.png") });

  // Keyboard: down one row, Enter focuses that seat and closes the palette.
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toHaveClass(/command-bar__row--active/);
  await page.keyboard.press("Enter");
  await expect(input).toHaveCount(0);
  await expect(page.locator(".react-flow__node.selected", { hasText: "ops-waiting" })).toHaveCount(1);

  // Reduced motion: the rings hold their rest pose, the clock stops stamping.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("Meta+k");
  await expect(input).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-surface-motion", "paused");
  await expect(page.locator("html")).not.toHaveAttribute("data-mark-frame", /.*/);
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "no-preference" });
});
