/**
 * The focused agent modal must keep the terminal at its reading width while
 * ledger and connections open and close inside one stacked right pane.
 *
 *   bun run test:e2e:fast e2e/scenarios/actor-focus-rails-width.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "design-audit");
const AGENT_LABEL = "rails width worker";

const fixtureDoc = canvasDoc(
  [
    agentTextNode({
      id: "worker",
      key: "local:e2e-rails-worker",
      label: AGENT_LABEL,
      x: 360,
      y: 40,
    }),
    agentTextNode({
      id: "peer",
      key: "local:e2e-rails-peer",
      label: "rails width peer",
      x: 680,
      y: 40,
    }),
  ],
  [
    {
      id: "e-worker-peer",
      fromNode: "worker",
      toNode: "peer",
      fromSide: "right",
      toSide: "left",
    },
  ],
);

type WidthProbe = {
  readonly panel: number;
  readonly stage: number;
  readonly rightPane: number;
  readonly ledgerHeight: number;
  readonly connectionsHeight: number;
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
      rightPane: width(".actor-terminal-right-pane"),
      ledgerHeight:
        document.querySelector(".actor-ledger")?.getBoundingClientRect()
          .height ?? 0,
      connectionsHeight:
        document.querySelector(".actor-edges-glance")?.getBoundingClientRect()
          .height ?? 0,
    };
  });

test("collapsing stacked right-pane sections does not resize the terminal", async () => {
  const junto = await launchJunto();

  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    await page.evaluate(async (document) => {
      const api = window.junto!;
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

    expect(ledgerShut.ledgerHeight).toBeLessThan(bothOpen.ledgerHeight);
    expect(
      Math.abs(ledgerShut.stage - bothOpen.stage),
      `stage ${ledgerShut.stage} vs ${bothOpen.stage} after collapsing the ledger`,
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(ledgerShut.panel - bothOpen.panel),
      "stacked sections must keep the focus panel width stable",
    ).toBeLessThanOrEqual(2);
    expect(ledgerShut.rightPane).toBeCloseTo(bothOpen.rightPane, 0);

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
    expect(bothShut.panel).toBeCloseTo(ledgerShut.panel, 0);
    expect(bothShut.connectionsHeight).toBeLessThan(
      ledgerShut.connectionsHeight,
    );

    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({
      path: join(SHOTS, "actor-focus-rails-collapsed.png"),
      fullPage: false,
    });
  } finally {
    await junto.close();
  }
});
