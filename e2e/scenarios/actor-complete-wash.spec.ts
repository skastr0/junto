/**
 * Visual iteration for actor ready/complete card wash.
 * Seeds a herdr pane as agent_status "done" (green pulse + GradientSpin wash).
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

test("ready/complete wash uses GradientSpin small cells over the card", async () => {
  await mkdir(SHOTS, { recursive: true });
  const scenarioDir = await mkdtemp(join(tmpdir(), "vellum-complete-wash-"));
  const herdrScenario = join(scenarioDir, "herdr.json");

  const world = oneWorkspaceWorld();
  // Idle+!seen herdr presentation is "done" → green pulse + card wash.
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

  const vellum = await launchVellum({
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
    const { page } = vellum;

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

    const wash = complete.locator(
      '.vellum-activity-card-wash[data-activity-wash="gradient-spin"]',
    );
    await expect(wash).toBeVisible();

    // Corner mark is green pulse (accessible status), not amber clockwise.
    await expect(
      node.getByRole("status", { name: /done|waiting for look/i }),
    ).toBeVisible();

    // GradientSpin: small cells matching ActivityMark density (4px pitch).
    const spin = wash.locator(".vellum-activity-card-wash__spin");
    await expect(spin).toBeVisible();
    const cellBox = await spin.evaluate((el) => {
      const cell = el.querySelector("span span") as HTMLElement | null;
      if (!cell) return null;
      const r = cell.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    expect(cellBox).not.toBeNull();
    expect(cellBox!.w).toBeGreaterThanOrEqual(3);
    expect(cellBox!.w).toBeLessThanOrEqual(6);
    expect(cellBox!.h).toBeGreaterThanOrEqual(3);
    expect(cellBox!.h).toBeLessThanOrEqual(6);

    await page.waitForTimeout(600);
    await node.screenshot({ path: join(SHOTS, "actor-complete-wash.png") });
    await page.screenshot({
      path: join(SHOTS, "actor-complete-wash-board.png"),
      fullPage: false,
    });
  } finally {
    await vellum.close();
  }
});
