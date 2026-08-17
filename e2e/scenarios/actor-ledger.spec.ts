/**
 * Actor ledger — the left kernel-standing pane in the terminal focus modal.
 *   bun run test:e2e:fast e2e/scenarios/actor-ledger.spec.ts
 *
 * Asserts:
 *   - the ledger pane renders on the LEFT of an actor focus modal (mail
 *     section with its empty state until real kernel mail exists)
 *   - collapse parks it to a rail; expand restores it
 *   - pinning the surface drops the ledger — the pinned dock keeps only the
 *     connections pane (operator ruling)
 *   - switching to another canvas hides the ledger on the surviving surface
 *     (node-keyed surfaces outlive canvas navigation; the ledger must never
 *     project or mutate a canvas the surface was not opened from)
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { agentTextNode, canvasDoc, textNode } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "_design_screenshots", "actor_ledger");
const CANVAS = "actor-ledger";
const OTHER_CANVAS = "actor-ledger-other";

const fixture = canvasDoc(
  [
    agentTextNode({
      id: "alpha",
      key: "local:e2e-ledger-alpha",
      label: "Alpha hub",
      x: 360,
      y: 40,
    }),
    agentTextNode({
      id: "bravo",
      key: "local:e2e-ledger-bravo",
      label: "Bravo peer",
      x: 660,
      y: 40,
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
  ],
);

test("ledger pane renders left in focus, collapses, and stays out of the pinned dock", async () => {
  await mkdir(SHOTS, { recursive: true });
  const vellumCommand = await launchVellum({
    seedCanvases: {
      [CANVAS]: fixture,
      [OTHER_CANVAS]: canvasDoc([textNode("note", "elsewhere", 40, 40)], []),
    },
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

    // Ledger left, connections right — one modal plate.
    const ledger = front.getByTestId("actor-ledger");
    await expect(ledger).toBeVisible({ timeout: 10_000 });
    await expect(front.getByTestId("actor-edges-glance")).toBeVisible();
    await expect(ledger.locator(".actor-ledger__section-title")).toHaveText(
      "mail",
    );
    // Fresh actor: kernel mailbox is empty.
    await expect(ledger.locator(".actor-ledger__empty")).toHaveText(
      "No mail yet",
    );

    await page.screenshot({
      path: join(SHOTS, "ledger_focus.png"),
      fullPage: false,
    });

    // Collapse to the rail; expand restores the mail section.
    await ledger.getByRole("button", { name: "Collapse ledger pane" }).click();
    await expect(ledger.locator(".actor-ledger__rail-label")).toBeVisible();
    await expect(ledger.locator(".actor-ledger__section-title")).toHaveCount(0);
    await ledger.getByRole("button", { name: "Expand ledger" }).click();
    await expect(ledger.locator(".actor-ledger__section-title")).toHaveText(
      "mail",
    );

    // Pinned dock keeps only the connections pane.
    await front.locator("header").getByRole("button", { name: "Pin" }).click();
    const pinnedSurface = page.locator(
      ".workbench-panes[data-zone='pinned'] .native-terminal-surface",
    );
    await expect(pinnedSurface).toBeVisible({ timeout: 10_000 });
    await expect(pinnedSurface.getByTestId("actor-ledger")).toHaveCount(0);
    await expect(pinnedSurface.getByTestId("actor-edges-glance")).toBeVisible();

    await page.screenshot({
      path: join(SHOTS, "ledger_pinned_absent.png"),
      fullPage: false,
    });

    // Cross-canvas guard: the pinned surface survives canvas navigation, but
    // the ledger must vanish — its projections and actions are bound to the
    // canvas the surface was opened from.
    await page.getByLabel("Active canvas").click();
    await page.getByRole("option", { name: OTHER_CANVAS, exact: true }).click();
    await expect(
      page.locator(`.react-flow__node[data-id="note"]`),
    ).toBeVisible({ timeout: 20_000 });
    await expect(pinnedSurface).toBeVisible();
    await expect(page.getByTestId("actor-ledger")).toHaveCount(0);

    // Switching back restores it (unpin first so it re-enters focus).
    await page.getByLabel("Active canvas").click();
    await page.getByRole("option", { name: CANVAS, exact: true }).click();
    await expect(
      page.locator(`.react-flow__node[data-id="alpha"]`),
    ).toBeVisible({ timeout: 20_000 });
    await pinnedSurface
      .locator("header")
      .getByRole("button", { name: "Unpin" })
      .click();
    await expect(front.getByTestId("actor-ledger")).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await vellumCommand.close();
  }
});
