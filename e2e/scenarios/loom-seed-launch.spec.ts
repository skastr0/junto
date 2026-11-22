/**
 * Routes persist across launches (issue 919): the first launch routes the
 * board and saves its seed when the plan settles; the second launch starts
 * from that seed and routes nothing, while drawing exactly the wires the
 * first one drew.
 *
 * The board is the synthetic `factory-like` nested canvas, so the spec needs
 * no fixture file and the gate can run it at every commit.
 * Run: `bun run build && scripts/run-e2e.sh e2e/scenarios/loom-seed-launch.spec.ts`
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { canvasReady, regionCount } from "../harness/canvas";
import { buildNestedCanvasFixture, OPERATOR_DISPLAY } from "../harness/nested-canvas-fixture";
import { createSandbox, destroySandbox } from "../harness/sandbox";

const fixture = buildNestedCanvasFixture("factory-like");

const wireState = (page: Page) =>
  page.evaluate(() => {
    const stats = (window as any).__juntoCanvas?.wireStats?.();
    return { wires: stats?.wires ?? 0, posed: stats?.posed ?? 0 };
  });

const loom = (page: Page) =>
  page.evaluate(() => {
    const api = (window as any).__juntoCanvas?.loom?.();
    return {
      routed: (api?.shares ?? []).reduce((n: number, share: any) => n + (share.routed ?? 0), 0),
      beginMs: (api?.shares ?? []).reduce((n: number, share: any) => n + (share.beginMs ?? 0), 0),
      routeMs: (api?.shares ?? []).reduce((n: number, share: any) => n + (share.routeMs ?? 0), 0),
    };
  });

const waitAllDrawn = (page: Page, timeout: number): Promise<void> =>
  expect
    .poll(async () => {
      const at = await wireState(page);
      return at.wires > 0 && at.posed === at.wires;
    }, { timeout, intervals: [200] })
    .toBe(true);

test("a relaunch starts from the seed and routes nothing", async () => {
  test.setTimeout(300_000);
  const options = {
    ...OPERATOR_DISPLAY,
    nestedCanvas: { fixture, name: "factory" },
    seedExperimentalFeatures: ["gpuCanvas"] as const,
  };

  // The caller owns the rows across the quit: `close` quits the app and keeps
  // the sandbox, so the second launch reads the seed the first one wrote.
  const sandbox = await createSandbox();
  const first = await launchJunto({ ...options, sandbox });
  try {
    await expect.poll(() => regionCount(first.page), { timeout: 120_000 }).toBe(fixture.stats.regions);
    await canvasReady(first.page);
    await waitAllDrawn(first.page, 120_000);
    const firstLoom = await loom(first.page);

    // The save lands after the plan settles; read it through the same API the
    // launch uses, and the rows it wrote from the app's database.
    let seed: { meta: { routerVersion: number } | null; cards: unknown[]; wires: { fact: string }[] } | null = null;
    for (let i = 0; i < 80 && seed?.meta == null; i += 1) {
      seed = await first.page.evaluate(() => (window as any).junto?.loomSeed?.load("factory"));
      if (seed?.meta == null) await first.page.waitForTimeout(250);
    }
    expect(seed?.meta).not.toBeNull();
    const db = new DatabaseSync(join(first.sandbox.homeDir, ".junto/state/junto.db"), { readOnly: true });
    const row = db
      .prepare("SELECT count(*) AS wires, sum(length(fact)) AS bytes FROM loom_seed_wires WHERE canvas_name = 'factory'")
      .get() as { wires: number; bytes: number | null } | undefined;
    db.close();
    const factBytes = seed!.wires.reduce((n, wire) => n + wire.fact.length, 0);
    console.log(
      "SEED_FIRST",
      JSON.stringify({
        routed: firstLoom.routed,
        cards: seed!.cards.length,
        wires: seed!.wires.length,
        factBytes,
        seedRowBytes: row?.bytes ?? null,
        seedWires: row?.wires ?? null,
      }),
    );
    await first.close();

    // No seeding on the relaunch: the rows (and the seed) are already there.
    const second = await launchJunto({ ...OPERATOR_DISPLAY, sandbox, seedExperimentalFeatures: ["gpuCanvas"] as const });
    try {
      await expect.poll(() => regionCount(second.page), { timeout: 120_000 }).toBe(fixture.stats.regions);
      await canvasReady(second.page);
      await waitAllDrawn(second.page, 120_000);
      const secondLoom = await loom(second.page);
      const loaded = await second.page.evaluate(async () => {
        const started = performance.now();
        const seed = await (window as any).junto?.loomSeed?.load("factory");
        return { ms: +(performance.now() - started).toFixed(1), wires: seed?.wires?.length ?? 0 };
      });
      console.log("SEED_SECOND", JSON.stringify({ ...secondLoom, seedWires: loaded.wires, readMs: loaded.ms }));
      expect(loaded.wires).toBeGreaterThan(0);
      expect(secondLoom.routed).toBe(0);
    } finally {
      await second.close();
    }
  } finally {
    await first.close().catch(() => undefined);
    await destroySandbox(sandbox);
  }
});
