/**
 * Ready/complete seats: corner green pulse only — no card-wide square wash.
 * Seeds a herdr pane as agent_status "done".
 *   bun run test:e2e:fast e2e/scenarios/actor-complete-wash.spec.ts
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  oneWorkspaceWorld,
  writeScenario,
} from "../fakes/scenario";
import { canvasDoc, herdrTextNode } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "design-audit");

const HOST = "local";
const PANE_ID = "w1:p1";
const TERMINAL_ID = "term_1";
const LABEL = "complete wash pane";

test("ready/complete shows corner green pulse only (no card wash)", async () => {
  await mkdir(SHOTS, { recursive: true });
  const scenarioDir = await mkdtemp(join(tmpdir(), "vellum-complete-wash-"));
  const herdrScenario = join(scenarioDir, "herdr.json");

  const world = oneWorkspaceWorld();
  // Idle+!seen herdr presentation is "done" → green pulse, no card wash.
  const doneWorld = {
    ...world,
    workspaces: world.workspaces.map((w) => ({
      ...w,
      agent_status: "done",
    })),
    tabs: world.tabs.map((t) => ({ ...t, agent_status: "done" })),
    panes: world.panes.map((p) => ({
      ...p,
      pane_id: PANE_ID,
      terminal_id: TERMINAL_ID,
      agent: "codex",
      agent_status: "done",
      label: LABEL,
    })),
    agents: world.agents.map((a) => ({
      ...a,
      pane_id: PANE_ID,
      terminal_id: TERMINAL_ID,
      agent: "codex",
      agent_status: "done",
      label: LABEL,
    })),
  };
  await writeScenario(herdrScenario, { world: doneWorld });

  const vellumCommand = await launchVellum({
    seedCanvases: {
      "complete-wash": canvasDoc([
        herdrTextNode({
          id: "h1",
          host: HOST,
          paneId: PANE_ID,
          terminalId: TERMINAL_ID,
          label: LABEL,
          x: 120,
          y: 100,
        }),
      ]),
    },
    extraEnv: { FAKE_HERDR_SCENARIO: herdrScenario },
  });

  try {
    const { page } = vellumCommand;

    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 30_000,
    });
    const fit = page.getByRole("button", { name: /fit all/i });
    if (await fit.isVisible().catch(() => false)) await fit.click();
    await page.waitForTimeout(400);

    const node = page.locator(".react-flow__node", { hasText: LABEL });
    await expect(node).toBeVisible({ timeout: 15_000 });

    const complete = node.locator('[data-seat-complete="true"]');
    await expect(complete).toBeVisible({ timeout: 15_000 });

    // Retired: card-wide square wash must not appear.
    await expect(
      complete.locator(
        '.vellum-activity-card-wash, [data-activity-wash="gradient-spin"]',
      ),
    ).toHaveCount(0);

    // Corner mark is green pulse (accessible status), not amber clockwise.
    await expect(
      node.getByRole("status", { name: /done|waiting for look/i }),
    ).toBeVisible();

    await page.waitForTimeout(400);
    await node.screenshot({ path: join(SHOTS, "actor-complete-wash.png") });
    await page.screenshot({
      path: join(SHOTS, "actor-complete-wash-board.png"),
      fullPage: false,
    });
  } finally {
    await vellumCommand.close();
  }
});
