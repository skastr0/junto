/**
 * Actor ledger — compact top section of the terminal's right context pane.
 *   bun run test:e2e:fast e2e/scenarios/actor-ledger.spec.ts
 *
 * Asserts:
 *   - the ledger renders to the RIGHT of the terminal, below 40% height
 *   - its height is resizable and its content scrolls internally
 *   - collapse parks it to a header; expand restores it
 *   - pinning the surface drops the ledger — the pinned dock keeps only the
 *     connections pane (operator ruling)
 *   - switching to another canvas hides the ledger on the surviving surface
 *     (node-keyed surfaces outlive canvas navigation; the ledger must never
 *     project or mutate a canvas the surface was not opened from)
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { agentTextNode, canvasDoc, textNode } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "actor-ledger-right-pane");
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

test("ledger is a compact resizable section in the right pane and stays out of the pinned dock", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({
    seedCanvases: {
      [CANVAS]: fixture,
      [OTHER_CANVAS]: canvasDoc([textNode("note", "elsewhere", 40, 40)], []),
    },
  });

  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    const hubCard = page.locator('.react-flow__node[data-id="alpha"]');
    await expect(hubCard).toBeVisible({ timeout: 30_000 });
    await hubCard.dblclick();

    const front = page.locator(
      ".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface",
    );
    await expect(front).toBeVisible({ timeout: 20_000 });
    await expect(front.locator("header").first()).toContainText("Alpha hub");

    // Ledger above connections on the right — one modal plate.
    const ledger = front.getByTestId("actor-ledger");
    const rightPane = front.getByTestId("actor-terminal-right-pane");
    await expect(ledger).toBeVisible({ timeout: 10_000 });
    await expect(front.getByTestId("actor-edges-glance")).toBeVisible();
    await expect(ledger.locator(".actor-ledger__section-title")).toHaveText(
      "mail",
    );
    // Fresh actor: kernel mailbox is empty.
    await expect(ledger.locator(".actor-ledger__empty")).toHaveText(
      "No mail yet",
    );

    const geometry = await rightPane.evaluate((pane) => {
      const ledger = pane.querySelector<HTMLElement>(".actor-ledger")!;
      const scroll = pane.querySelector<HTMLElement>(".actor-ledger__scroll")!;
      const stage = pane.parentElement!.querySelector<HTMLElement>(
        ".native-terminal-surface__stage",
      )!;
      const paneBox = pane.getBoundingClientRect();
      const ledgerBox = ledger.getBoundingClientRect();
      const stageBox = stage.getBoundingClientRect();
      const ledgerStyle = getComputedStyle(ledger);
      return {
        ledgerToStage: ledgerBox.left - stageBox.right,
        heightRatio: ledgerBox.height / paneBox.height,
        resize: ledgerStyle.resize,
        scrollOverflow: getComputedStyle(scroll).overflowY,
      };
    });
    expect(geometry.ledgerToStage).toBeGreaterThanOrEqual(-1);
    expect(geometry.heightRatio).toBeLessThan(0.4);
    expect(geometry.resize).toBe("vertical");
    expect(geometry.scrollOverflow).toBe("auto");

    await page.screenshot({
      path: join(SHOTS, "ledger_focus.png"),
      fullPage: false,
    });

    // Collapse to the compact header; expand restores the mail section.
    await ledger.getByRole("button", { name: "Collapse ledger pane" }).click();
    await expect(ledger).toHaveCSS("height", "36px");
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
    await junto.close();
  }
});
