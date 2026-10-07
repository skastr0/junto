import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { agentTextNode, canvasDoc, verbEdge } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

/**
 * Pinning is behind a build flag that is off in every profile. With it off
 * nothing offers a pin: not the agent view's header, not a note, not a node's
 * toolbar, and no side dock ever appears. Frames land in
 * test-results/pinning-off/.
 *
 *   scripts/with-app-run-lock.sh scripts/run-e2e.sh e2e/scenarios/pinning-off.spec.ts
 */

const SHOTS = join(process.cwd(), "test-results", "pinning-off");
const CANVAS = "pinning-off";
const nodes = [
  agentTextNode({ id: "lead", key: "local:pin-lead", label: "lead", x: 40, y: 40 }),
  agentTextNode({ id: "ada", key: "local:pin-ada", label: "ada", x: 360, y: 40 }),
  { id: "note", type: "text" as const, text: "# Field notes\n\nNothing pins here.", x: 40, y: 260, width: 240, height: 120 },
];
const fixture = canvasDoc(nodes, [verbEdge("e-lead-ada", "lead", "ada", "messages", nodes)]);

const front = (page: Page): Locator =>
  page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");

/** Nothing on screen offers a pin, and there is no dock. */
const expectNoPinAnywhere = async (page: Page, where: string): Promise<void> => {
  await expect(page.getByRole("button", { name: /^(pin|unpin)\b/i }), `${where}: no pin button`).toHaveCount(0);
  await expect(page.getByRole("button", { name: /pinned$/i }), `${where}: no open-pinned button`).toHaveCount(0);
  await expect(page.getByLabel("Pinned work surface dock"), `${where}: no dock`).toHaveCount(0);
  await expect(page.locator('.workbench-panes[data-zone="pinned"]'), `${where}: no pinned zone`).toHaveCount(0);
};

test("with pinning off no surface offers a pin and no dock appears", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: fixture } });
  try {
    const { page } = junto;
    const lead = page.locator('.react-flow__node[data-id="lead"]');
    await expect(lead).toBeVisible({ timeout: 30_000 });

    // A selected node's toolbar: open, never open pinned.
    await lead.click();
    await expectNoPinAnywhere(page, "canvas with a seat selected");

    // The agent view: its header ends in details, Params and Close.
    await lead.dblclick();
    const header = front(page).locator("header").first();
    await expect(header).toContainText("lead", { timeout: 20_000 });
    await expect(header.getByRole("button", { name: "Close view", exact: true })).toBeVisible();
    await expectNoPinAnywhere(page, "agent view");
    await page.waitForTimeout(400);
    await header.screenshot({ path: join(SHOTS, "agent-view-header.png") });
    await page.screenshot({ path: join(SHOTS, "agent-view.png") });

    // A second agent from the rail stays in the same view; still no dock.
    await front(page).locator('[data-peer-node-id="ada"]').getByTestId("actor-rail-go").click();
    await expect(front(page).locator("header").first()).toContainText("ada", { timeout: 20_000 });
    await expectNoPinAnywhere(page, "after moving to a second agent");
    await front(page).locator("header").getByRole("button", { name: "Close view", exact: true }).first().click();
    await expect(front(page)).toHaveCount(0);

    // A note: done and nothing else to move it.
    await page.locator('.react-flow__node[data-id="note"]').dblclick();
    const note = page.getByTestId("note-workbench-surface");
    await expect(note).toBeVisible({ timeout: 10_000 });
    await expectNoPinAnywhere(page, "note editor");
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, "note-editor.png") });
  } finally {
    await junto.close();
  }
});
