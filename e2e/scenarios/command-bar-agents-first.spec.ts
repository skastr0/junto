import { modelRegion, modelNode } from "../harness/model";
import { modelFixture, modelSeat } from "../harness/model";
/**
 * cmd+K is an agent switcher first.
 *
 * The palette fills most of the window height. With no query the agents lead
 * in one order (blocked, waiting on you, working, ready for review, done and
 * not read, resting, not running), the seat that entered a state most recently
 * first inside it, then regions, notes, and every other kind. A seat that
 * changes state while the palette is open re-ranks, and the cursor stays on
 * its row. With a query
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
import type { Node, Region } from "../../src/shared/model";

import { expect, test, type JuntoHandle } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "command-bar-agents-first");
const CANVAS = "agents-first";
const CREW = 24;

const region = (id: string, label: string, color: string, x: number): Region => modelRegion({
  id,
  label,
  color,
  x,
  y: 0,
  width: 2000,
  height: 900,
});

const seat = (id: string, x: number, y: number): Node =>
  modelSeat({ id, key: `local:e2e-first-${id}`, label: id, harness: "claude", x, y });

const crew = Array.from({ length: CREW }, (_, i) => `crew-${String(i + 1).padStart(2, "0")}`);

// Row order buries the agents under other kinds and puts the most urgent
// seat last, so every rank in the list is the ranking's doing.
const nodes: ReadonlyArray<Node> = [
  modelNode({ id: "l-docs", kind: "link", z: 0, url: "https://example.com/handbook", x: 2240, y: 400, width: 240, height: 96 }),
  modelNode({ id: "n-runbook", kind: "note", z: 0, text: "Ops runbook\nRestart order for the staging fleet.", x: 2240, y: 60, width: 240, height: 96 }),
  region("r-ops", "Ops", "5", 0),
  region("r-research", "Research", "2", 2200),
  seat("ops-idle", 40, 60),
  seat("ops-review", 320, 60),
  seat("ops-work-old", 1160, 60),
  seat("ops-work-new", 1440, 60),
  seat("ops-done", 1720, 60),
  seat("ops-rest", 1960, 60),
  ...crew.map((id, i) => seat(id, 40 + (i % 7) * 280, 220 + Math.floor(i / 7) * 160)),
  seat("ops-waiting", 600, 60),
  seat("ops-blocked", 880, 60),
];

const STAGED = Date.now();

const signal = (nodeId: string, kind: AgentSignalKind, text: string, createdAt: number): AgentSignal => ({
  signalId: `sig-first-${nodeId}`,
  canvasName: CANVAS,
  nodeId,
  kind,
  text,
  createdAt,
  state: "open",
});

// Each crew seat's feedback is a minute older than the one before it, so the
// recency tie-break reads crew-01 first, and ops-review is newer than them all.
const signals: ReadonlyArray<AgentSignal> = [
  signal("ops-blocked", "blocked", "The staging database refuses the new migration.", STAGED - 60_000),
  signal("ops-waiting", "escalate", "Should the export include archived projects?", STAGED - 60_000),
  signal("ops-review", "feedback", "The release notes are drafted.", STAGED - 60_000),
  ...crew.map((id, i) => signal(id, "feedback", "Done, ready for a look.", STAGED - 120_000 - i * 60_000)),
];

const seatEvent = (id: string, state: "working" | "idle", at: number) => ({
  bindingId: `local:e2e-first-${id}`,
  epoch: "e2e",
  state,
  reason: state === "idle" ? "rule:empty_prompt_idle" : "rule:osc_title_working",
  confidence: "high",
  at,
});

// ops-work-new began working after ops-work-old; ops-done ended a turn nobody
// has read; ops-rest idles; ops-idle never reported, so it is not running.
const seatEvents = [
  seatEvent("ops-work-old", "working", STAGED - 50_000),
  seatEvent("ops-work-new", "working", STAGED - 10_000),
  seatEvent("ops-done", "working", STAGED - 40_000),
  seatEvent("ops-done", "idle", STAGED - 30_000),
  seatEvent("ops-rest", "idle", STAGED - 20_000),
];

/** Deliver seat events and signals to every window, as main would. */
const stage = (junto: JuntoHandle, events: ReadonlyArray<unknown>, signalsNow: ReadonlyArray<AgentSignal> = []): Promise<void> =>
  junto.app.evaluate(
    ({ BrowserWindow }, { seatsNow, agentSignals }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        for (const event of seatsNow) window.webContents.send("junto:agent-seat-state-changed", event);
        for (const event of agentSignals) window.webContents.send("junto:agent-signal", event);
      }
    },
    { seatsNow: events, agentSignals: signalsNow },
  );

test.use({ juntoOptions: { seedModels: { [CANVAS]: modelFixture([...nodes], []) }, seedAgentSignals: signals } });

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
  await stage(junto, seatEvents);
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

  // Empty query: agents in one order, newest change first inside a state, then
  // regions, notes, other kinds.
  await expect(titles.first()).toHaveText("ops-blocked");
  await expect(titles.nth(7)).toHaveText("ops-done");
  const order = await titles.allTextContents();
  expect(order.slice(0, 5)).toEqual(["ops-blocked", "ops-waiting", "ops-work-new", "ops-work-old", "ops-review"]);
  expect(order.slice(5, 5 + CREW)).toEqual(crew);
  expect(order.slice(5 + CREW)).toEqual(["ops-done", "ops-rest", "ops-idle", "Ops", "Research", "Ops runbook", "example.com"]);
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
    "ops-work-new",
    "ops-work-old",
    "ops-review",
    "ops-done",
    "ops-rest",
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

test("cmd+K: a seat that changes state re-ranks the open list and the cursor stays on its row", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator(".react-flow__node", { hasText: "ops-blocked" })).toBeVisible({ timeout: 30_000 });
  await stage(junto, seatEvents);
  await page.keyboard.press("Meta+k");
  const titles = page.locator(".command-bar__row-title");
  await expect(titles.nth(7)).toHaveText("ops-done");
  const active = page.locator(".command-bar__row--active .command-bar__row-title");

  // The cursor goes down to ops-work-new.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(active).toHaveText("ops-work-new");

  // ops-rest starts working, newer than both: it joins the working seats above the cursor.
  await stage(junto, [seatEvent("ops-rest", "working", Date.now())]);
  await expect(titles.nth(2)).toHaveText("ops-rest");
  await expect(active).toHaveText("ops-work-new");

  // A crew seat raises a blocker: it leads the list; the cursor still holds its row.
  await stage(junto, [], [signal("crew-07", "blocked", "The build is red.", Date.now())]);
  await expect(titles.first()).toHaveText("crew-07");
  await expect(active).toHaveText("ops-work-new");

  // Enter goes to the seat under the cursor.
  await page.keyboard.press("Enter");
  await expect(page.locator(".react-flow__node.selected", { hasText: "ops-work-new" })).toHaveCount(1);
});
