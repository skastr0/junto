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
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "_design_screenshots", "actor_ledger");
const CANVAS = "actor-ledger";

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
  } finally {
    await vellumCommand.close();
  }
});
