/**
 * An automation's signal in the needs-you feed (0.11/09 H2): it reads as the
 * kind it raises, from the Automations node it lives on, with one row of
 * answers and an Open run in place of Open seat. Answering it is recorded
 * without mail to that node, which is no seat.
 *
 *   scripts/with-app-run-lock.sh sh -c 'JUNTO_FEATURE_PROFILE=all-on electron-vite build && scripts/run-e2e.sh e2e/scenarios/feed-automation-signal.spec.ts'
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { AgentSignal } from "../../src/shared/agent-signals";
import type { Region } from "../../src/shared/model";
import { modelFixture, modelNode, modelRegion, modelSeat, type ModelFixture } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "feed-automation-signal");
const CANVAS = "feed-automation";
const NODE = "routines";
const AUTOMATION_ID = "01M62Q58WDSXMG4YBXNKR2RB91";
const FIRING_ID = "01M62Q58WDSXMG4YBXNKR2RB92";

const fixture = (): ModelFixture =>
  modelFixture([
    modelRegion({ id: "writing", label: "Writing", color: "5", x: 0, y: 0, width: 1000, height: 500 }) as Region,
    modelSeat({ id: "lead", key: "local:e2e-automation-lead", label: "lead", x: 40, y: 340 }),
    modelNode({ kind: "automations", id: NODE, label: "Routines", x: 40, y: 60, width: 260, height: 120, z: 1 }),
  ]);

// The node holds no automation here (the harness seeds none), so the card falls
// back to the node's title, which is the older reader's own answer.
const signal: AgentSignal = {
  signalId: "sig-ask",
  canvasName: CANVAS,
  nodeId: NODE,
  kind: "escalate",
  text: "Which post goes out first?",
  createdAt: Date.now() - 10 * 60_000,
  state: "open",
  source: { kind: "automation", automationId: AUTOMATION_ID, nodeId: NODE, firingId: FIRING_ID },
};

const stateOf = async (page: Page, signalId: string) => {
  const signals = await page.evaluate((canvas) => window.junto!.agentSignalsList(canvas), CANVAS);
  const found = signals.find((candidate) => candidate.signalId === signalId);
  return { state: found?.state, response: found?.response?.text };
};

test("an automation's signal reads as its kind, opens the run, and answers without a seat", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture() }, seedAgentSignals: [signal] });
  try {
    const { page } = junto;
    await expect(page.locator(`.react-flow__node[data-id="${NODE}"]`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("operator-feed-trigger")).toHaveAttribute("aria-label", "Needs you, 1", {
      timeout: 10_000,
    });
    await page.keyboard.press("Meta+I");
    const feed = page.getByTestId("operator-feed");
    await expect(feed).toBeVisible({ timeout: 10_000 });

    const card = feed.getByTestId("operator-feed-card");
    await expect(card).toHaveAttribute("data-kind", "escalate");
    await expect(card).toContainText("Routines");
    await expect(card).toContainText("waiting on you");

    const pane = page.getByTestId("operator-feed-detail");
    // One row of answers: a quiet note would spare no seat, because there is none.
    await expect(pane.getByTestId("quick-replies")).toBeVisible();
    await expect(pane.getByTestId("quiet-notes")).toHaveCount(0);
    await expect(pane.getByTestId("quick-replies").getByRole("button").first()).toHaveAttribute(
      "data-junto-tooltip",
      'Reply "Yes" to Routines: the automation gets it as your answer (1)',
    );
    const keys = pane.getByTestId("operator-feed-keys");
    await expect(keys).toContainText("open run");
    await expect(keys).not.toContainText("open seat");
    await expect(pane.getByRole("button", { name: "Open the run in Routines" })).toBeVisible();
    await page.mouse.move(4, 700);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, "automation-signal.png") });

    // 1 answers it: recorded, no mail to the Automations node, the card closes.
    await page.keyboard.press("1");
    await expect(feed.locator("[data-item-id='signal:sig-ask']")).toHaveCount(0, { timeout: 10_000 });
    expect(await stateOf(page, "sig-ask")).toEqual({ state: "answered", response: "Yes" });
  } finally {
    await junto.close();
  }
});
