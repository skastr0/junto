/**
 * The focused agent modal must keep the terminal at its reading width while
 * the side rails open and close around it.
 *
 * The regression this holds shut: the panel budgeted both rails as expanded
 * whatever they were doing, so collapsing one left ~200px of slack inside the
 * panel, the xterm stage flexed into it, and the terminal ran ~190 columns
 * instead of 140. Rails must grow the panel outwards, never take the terminal's
 * width and never hand it more.
 *
 *   bun run test:e2e:fast e2e/scenarios/actor-focus-rails-width.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  agentTextNode,
  canvasDoc,
  tasksCriteriaEdge,
  tasksNode,
} from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "design-audit");
const AGENT_LABEL = "rails width worker";

const fixtureDoc = canvasDoc(
  [
    tasksNode({ id: "tasks", x: 40, y: 40 }),
    agentTextNode({
      id: "worker",
      key: "local:e2e-rails-worker",
      label: AGENT_LABEL,
      x: 360,
      y: 40,
    }),
  ],
  [tasksCriteriaEdge("e-tasks-worker", "tasks", "worker")],
);

type WidthProbe = {
  readonly panel: number;
  readonly stage: number;
  readonly ledger: number;
  readonly connections: number;
};

const probeWidths = async (
  page: import("@playwright/test").Page,
): Promise<WidthProbe | null> =>
  page.evaluate(() => {
    const width = (selector: string): number => {
      const el = document.querySelector(selector);
      return el ? el.getBoundingClientRect().width : 0;
    };
    const surface = document.querySelector(".native-terminal-surface");
    if (!surface) return null;
    const panel = surface.closest(".focus-surface__panel");
    if (!panel) return null;
    return {
      panel: panel.getBoundingClientRect().width,
      stage: width(".native-terminal-surface__stage"),
      ledger: width(".actor-ledger"),
      connections: width(".actor-edges-glance"),
    };
  });

test("collapsing a focus rail narrows the modal, not the terminal", async () => {
  const vellumCommand = await launchVellum();

  try {
    const { page } = vellumCommand;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    await page.evaluate(async (document) => {
      const api = window.vellumCommand!;
      const list = await api.listCanvases();
      const name = list[0]?.name ?? (await api.createCanvas("work")).name;
      const read = await api.readCanvas(name);
      await api.writeCanvas(name, document, read.revision);
    }, fixtureDoc);

    const node = page.locator(".react-flow__node", { hasText: AGENT_LABEL });
    await expect(node).toBeVisible({ timeout: 30_000 });
    await node.dblclick();

    const surface = page.locator(".native-terminal-surface");
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await expect(surface.getByTestId("actor-ledger")).toBeVisible({
      timeout: 15_000,
    });
    await expect(surface.getByTestId("actor-edges-glance")).toBeVisible({
      timeout: 15_000,
    });
    // Enter animation + the settle fit.
    await page.waitForTimeout(700);

    const bothOpen = await probeWidths(page);
    expect(bothOpen, "focus panel probe").toBeTruthy();
    if (!bothOpen) return;
    expect(bothOpen.stage).toBeGreaterThan(400);

    await surface.getByRole("button", { name: "Collapse ledger pane" }).click();
    await expect(page.locator(".actor-ledger--collapsed")).toBeVisible({
      timeout: 5_000,
    });
    await page.waitForTimeout(500);

    const ledgerShut = await probeWidths(page);
    expect(ledgerShut).toBeTruthy();
    if (!ledgerShut) return;

    // The rail gave its width back to the panel, not to the terminal.
    expect(ledgerShut.ledger).toBeLessThan(bothOpen.ledger);
    expect(
      Math.abs(ledgerShut.stage - bothOpen.stage),
      `stage ${ledgerShut.stage} vs ${bothOpen.stage} after collapsing the ledger`,
    ).toBeLessThanOrEqual(2);
    expect(
      bothOpen.panel - ledgerShut.panel,
      "panel must narrow by what the ledger gave up",
    ).toBeGreaterThan(100);

    await surface
      .getByRole("button", { name: "Collapse connections pane" })
      .click();
    await expect(page.locator(".actor-edges-glance--collapsed")).toBeVisible({
      timeout: 5_000,
    });
    await page.waitForTimeout(500);

    const bothShut = await probeWidths(page);
    expect(bothShut).toBeTruthy();
    if (!bothShut) return;

    expect(
      Math.abs(bothShut.stage - bothOpen.stage),
      `stage ${bothShut.stage} vs ${bothOpen.stage} with both rails collapsed`,
    ).toBeLessThanOrEqual(2);
    expect(bothShut.panel).toBeLessThan(ledgerShut.panel);

    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({
      path: join(SHOTS, "actor-focus-rails-collapsed.png"),
      fullPage: false,
    });
  } finally {
    await vellumCommand.close();
  }
});
