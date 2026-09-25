/**
 * Minimap colored by seat health — seats painted by the same rollup their
 * ring and name line use, in dark and bright. Frames land in
 * test-results/minimap-health/ (disposable, never committed).
 *
 *   bun run test:e2e:fast e2e/scenarios/minimap-health.spec.ts
 *
 * No provider is called. Jev readings and a declared signal are sent from
 * main on their real IPC channels, so they pass the renderer's strict decode
 * exactly as the sidecar's and the signal store's events do.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadHealthValue } from "../../src/shared/thread-health";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "minimap-health");
const CANVAS = "minimap-health";

const seats: ReadonlyArray<readonly [id: string, label: string, health: ThreadHealthValue | undefined]> = [
  ["thrasher", "thrashing seat", "thrashing"],
  ["stuck", "stuck seat", "stuck"],
  ["winner", "succeeding seat", "succeeding"],
  ["steady", "going well seat", "going_well"],
  ["blocked", "declared blocked", undefined],
  ["quiet", "idle seat", undefined],
];

const nodes = seats.map(([id, label], index) =>
  agentTextNode({
    id,
    key: `local:e2e-minimap-${id}`,
    label,
    harness: "claude",
    x: 40 + (index % 3) * 320,
    y: 40 + Math.floor(index / 3) * 200,
  }),
);

/** A region around the first column: a thrashing seat and a going-well one, so its tint is amber. */
const region = { id: "zone", type: "group" as const, label: "first column", x: 0, y: 0, width: 320, height: 380 };

const awarenessEvent = (id: string, value: ThreadHealthValue, at: number) => {
  const bindingId = `local:e2e-minimap-${id}`;
  const assessmentId = `e2e-${id}`;
  return {
    kind: "assessment",
    windowDigest: `digest-${id}`,
    at,
    assessment: {
      bindingId,
      assessmentId,
      availability: "current",
      observedAt: at,
      activity: null,
      concerns: [],
      absences: [],
      unansweredConcerns: [],
      evidence: { digest: `digest-${id}`, capturedAt: at, lines: [] },
      selectedLineId: null,
      unavailableReason: null,
      health: {
        bindingId,
        value,
        confidence: 0.94,
        observedAt: at,
        provenance: { source: "jev", assessmentId, questionId: `health.${value}`, packVersion: "awareness-pack/2" },
        signals: [{ value, probability: 0.94, questionId: `health.${value}` }],
      },
    },
  };
};

test("the minimap paints agent seats by their health rollup", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: canvasDoc([region, ...nodes]) } });
  try {
    const { app, page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.react-flow__node[data-id="thrasher"]')).toBeVisible({ timeout: 60_000 });
    // Every seat inside the camera window, so the map's mask dims none of them.
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await page.waitForTimeout(600);
    const minimap = page.getByTestId("rf__minimap");
    await expect(minimap).toBeVisible({ timeout: 30_000 });

    const at = Date.now();
    const events = seats.flatMap(([id, , health]) => (health ? [awarenessEvent(id, health, at)] : []));
    const signal = {
      signalId: "e2e-signal-blocked",
      canvasName: CANVAS,
      nodeId: "blocked",
      kind: "blocked",
      text: "Need the staging credentials to continue.",
      createdAt: at,
      state: "open",
    };
    await app.evaluate(({ BrowserWindow }, payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        for (const event of payload.events) window.webContents.send("junto:seat-awareness", event);
        window.webContents.send("junto:agent-signal", payload.signal);
      }
    }, { events, signal });

    // Each tone the rollup should paint, on the map itself.
    const fills = async (): Promise<ReadonlyArray<string>> =>
      minimap.locator(".react-flow__minimap-node").evaluateAll((rects) =>
        rects.map((rect) => (rect as SVGRectElement).style.fill),
      );
    await expect
      .poll(async () => (await fills()).join(" | "), { timeout: 20_000 })
      .toMatch(/--color-green/);
    const painted = (await fills()).join(" | ");
    console.log(`MINIMAP FILLS ${painted}`);
    expect(painted).toMatch(/--color-amber/);
    expect(painted).toMatch(/--color-crimson/);
    expect(painted).not.toMatch(/crimson.*crimson/);

    for (const mode of ["dark", "bright"] as const) {
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
      const choice = page
        .getByRole("radiogroup", { name: "Theme", exact: true })
        .getByRole("radio", { name: mode === "bright" ? "Bright" : "Dark", exact: true });
      await choice.click();
      await expect(choice).toHaveAttribute("aria-checked", "true");
      await page.locator(".settings-panel__close").click();
      await page.getByRole("button", { name: "Fit all nodes" }).click();
      await page.waitForTimeout(900);
      await minimap.screenshot({ path: join(SHOTS, `${mode}-minimap.png`) });
      await page.screenshot({ path: join(SHOTS, `${mode}-canvas.png`) });
    }
  } finally {
    await junto.close();
  }
});
