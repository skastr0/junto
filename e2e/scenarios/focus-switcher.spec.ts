/**
 * Focus switcher — hold Control+Tab over an open focus modal.
 *   bun run test:e2e:fast e2e/scenarios/focus-switcher.spec.ts
 *
 * Two actor seats plus a tasks sink. Opening Alpha, then Control+Tab, must:
 *   - show the HUD without closing the modal
 *   - cycle to another model while Control is held
 *   - commit on Control release and leave a focus surface up
 */
import {
  agentTextNode,
  canvasDoc,
  tasksNode,
  worksEdge,
} from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const CANVAS = "focus-switcher";

const fixture = canvasDoc(
  [
    tasksNode({ id: "sink", x: 40, y: 40 }),
    agentTextNode({
      id: "alpha",
      key: "local:e2e-switch-alpha",
      label: "Alpha hub",
      x: 360,
      y: 40,
    }),
    agentTextNode({
      id: "bravo",
      key: "local:e2e-switch-bravo",
      label: "Bravo peer",
      x: 660,
      y: 40,
    }),
  ],
  [worksEdge("e-sink-alpha", "sink", "alpha")],
);

test("Control+Tab HUD cycles focus models without closing the modal", async ({}, testInfo) => {
  const vellumCommand = await launchVellum({
    seedCanvases: { [CANVAS]: fixture },
  });

  try {
    const { page } = vellumCommand;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    const hubCard = page.locator('.react-flow__node[data-id="alpha"]');
    await expect(hubCard).toBeVisible({ timeout: 30_000 });
    await hubCard.dblclick();

    const front = page.locator(
      ".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface",
    );
    await expect(front).toBeVisible({ timeout: 20_000 });
    await expect(front.locator("header").first()).toContainText("Alpha hub");

    await page.keyboard.down("Control");
    await page.keyboard.press("Tab");

    const hud = page.getByTestId("focus-switcher");
    await expect(hud).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId("focus-switcher-selected")).toBeVisible();
    await expect(front).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath("hud.png"),
      fullPage: false,
    });

    await page.keyboard.press("Tab");
    await expect(hud).toBeVisible();

    await page.keyboard.up("Control");
    await expect(hud).toHaveCount(0, { timeout: 8_000 });

    await expect(
      page.locator(".work-focus-shell, .native-terminal-surface, [data-focus-surface='1']").first(),
    ).toBeVisible({ timeout: 10_000 });
  } finally {
    await vellumCommand.close();
  }
});
