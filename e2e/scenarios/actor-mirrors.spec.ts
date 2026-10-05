/**
 * Actor mirrors — the connections rail as navigation.
 *   bun run test:e2e:fast e2e/scenarios/actor-mirrors.spec.ts
 *
 * Hub actor wired to two peer actors. Asserts:
 *   - actor rows render as mirror buttons
 *   - clicking a mirror swaps the front modal to that actor in place
 *   - the previous surface parks (stays mounted — keep-alive proof)
 *   - Cmd+] / Cmd+[ cycle the sticky ring (hub plus its actor peers), wrapping
 *   - ONE Close press after cycling dismisses the whole modal — the parked
 *     stack never pops one press per cycled actor
 */
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "actor-mirrors";

const fixture = canvasDoc(
  [
    agentTextNode({
      id: "alpha",
      key: "local:e2e-mirror-alpha",
      label: "Alpha hub",
      x: 360,
      y: 40,
    }),
    agentTextNode({
      id: "bravo",
      key: "local:e2e-mirror-bravo",
      label: "Bravo peer",
      x: 660,
      y: 40,
    }),
    agentTextNode({
      id: "charlie",
      key: "local:e2e-mirror-charlie",
      label: "Charlie peer",
      x: 660,
      y: 220,
    }),
  ],
  [
    {
      id: "e-alpha-bravo",
      fromNode: "alpha",
      toNode: "bravo",
      fromSide: "right",
      toSide: "left",
    },
    {
      id: "e-alpha-charlie",
      fromNode: "alpha",
      toNode: "charlie",
      fromSide: "right",
      toSide: "left",
    },
  ],
);

test("connections rail mirrors swap the modal and Cmd+] cycles the ring", async ({}, testInfo) => {
  const junto = await launchJunto({
    seedCanvases: { [CANVAS]: fixture },
  });

  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    const hubCard = page.locator('.react-flow__node[data-id="alpha"]');
    await expect(hubCard).toBeVisible({ timeout: 30_000 });
    await hubCard.dblclick();

    // Front (non-parked) pane carries the active modal; parked panes keep
    // their surfaces alive offscreen.
    const front = page.locator(
      ".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface",
    );
    await expect(front).toBeVisible({ timeout: 20_000 });
    await expect(front.locator("header").first()).toContainText("Alpha hub");

    const glance = front.getByTestId("actor-rail");
    await expect(glance).toBeVisible({ timeout: 10_000 });

    // Two actor mirrors.
    const mirrors = glance.getByTestId("actor-rail-seat");
    await expect(mirrors).toHaveCount(2);

    await page.screenshot({
      path: testInfo.outputPath("rail_mirrors.png"),
      fullPage: false,
    });

    // Click the Bravo mirror: the modal swaps in place.
    await glance.locator('[data-peer-node-id="bravo"]').getByTestId("actor-rail-go").click();
    await expect(front.locator("header").first()).toContainText("Bravo peer", {
      timeout: 20_000,
    });

    // Keep-alive: Alpha's surface parks instead of closing.
    await expect(
      page.locator(".workbench-pane--parked .native-terminal-surface"),
    ).toHaveCount(1);

    // Ring is [alpha, bravo, charlie] anchored at the hub. Cmd+] from bravo
    // reaches charlie, then wraps to alpha; Cmd+[ steps back to charlie.
    await page.keyboard.press("Meta+]");
    await expect(front.locator("header").first()).toContainText("Charlie peer", {
      timeout: 20_000,
    });
    await page.keyboard.press("Meta+]");
    await expect(front.locator("header").first()).toContainText("Alpha hub", {
      timeout: 20_000,
    });
    await page.keyboard.press("Meta+[");
    await expect(front.locator("header").first()).toContainText("Charlie peer", {
      timeout: 20_000,
    });
    await expect(
      page.locator(".workbench-pane--parked .native-terminal-surface"),
    ).toHaveCount(2);

    await page.screenshot({
      path: testInfo.outputPath("after_cycle.png"),
      fullPage: false,
    });

    // Modal semantics: one Close press dismisses the whole stack — front pane
    // AND both parked mirror views — never one press per cycled actor.
    await front
      .locator("header")
      .getByRole("button", { name: "Close view" })
      .click();
    await expect(page.locator(".native-terminal-surface")).toHaveCount(0, {
      timeout: 10_000,
    });
  } finally {
    await junto.close();
  }
});
