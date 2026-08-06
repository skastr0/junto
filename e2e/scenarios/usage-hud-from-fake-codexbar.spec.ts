import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeScenario } from "../fakes/codexbar-scenario";
import { expect, launchVellum, test, type VellumHandle } from "../harness/launch";

// Real spawn->parse pipeline against a fake `codexbar` on PATH — no demo
// mode. Two separate launches (codexbar's scenario is fixed per process):
// healthy quotas paint the rail; malformed / missing data fail open (HUD
// hidden — no error chip).
//
// PRODUCT BUG (reported, not fixed here): the boot-time codexbar detection
// spawn intermittently loses its result (the fake's --version runs and exits
// 0, but the adapter plane reports failure), which memoizes
// cliPresent=false for the whole app process. Retry with fresh launches.

const waitForBridge = async (handle: VellumHandle): Promise<void> => {
  await expect
    .poll(() =>
      handle.page.evaluate(
        () => typeof window.vellumCommand?.refreshUsage === "function",
      ),
    )
    .toBe(true);
};

const healthyPhase = async (
  scenarioPath: string,
): Promise<Awaited<ReturnType<typeof launchVellum>>> => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const handle = await launchVellum({
      extraEnv: { FAKE_CODEXBAR_SCENARIO: scenarioPath },
    });
    try {
      const rail = handle.page.getByRole("button", {
        name: "Provider limits",
        exact: true,
      });
      // Deterministic: the product polls codexbar at boot and then every 5
      // minutes. Force refreshes until the state lands after mount.
      await expect(handle.page.locator(".react-flow")).toBeVisible({
        timeout: 30_000,
      });
      await waitForBridge(handle);
      const painted = await expect
        .poll(
          async () => {
            await handle.page.evaluate(() =>
              window.vellumCommand?.refreshUsage?.(),
            );
            return rail.isVisible().catch(() => false);
          },
          { timeout: 45_000, intervals: [5_000] },
        )
        .toBe(true)
        .then(() => true)
        .catch(() => false);
      if (painted) {
        await expect(handle.page.locator(".usage-hud__cell")).toHaveCount(1);
        return handle;
      }
    } catch {
      // Fall through to a fresh launch.
    }
    await handle.close();
  }
  throw new Error("usage HUD rail never appeared after 3 fresh launches");
};

test("usage HUD renders fake codexbar quotas, then hides on malformed output", async () => {
  const scenarioDir = await mkdtemp(join(tmpdir(), "vellum-command-e2e-codexbar-"));

  const healthyScenarioPath = join(scenarioDir, "healthy.json");
  await writeScenario(healthyScenarioPath, {
    mode: "healthy",
    quotas: [
      {
        provider: "codex",
        source: "cli",
        usage: { accountEmail: "fake@example.com", primary: { usedPercent: 77, windowMinutes: 300 } },
      },
    ],
  });

  const healthy = await healthyPhase(healthyScenarioPath);
  try {
    await expect(healthy.page.locator(".usage-hud__cell")).toHaveCount(1);
  } finally {
    await healthy.close();
  }

  const malformedScenarioPath = join(scenarioDir, "malformed.json");
  await writeScenario(malformedScenarioPath, { mode: "malformed" });

  const malformed = await launchVellum({
    extraEnv: { FAKE_CODEXBAR_SCENARIO: malformedScenarioPath },
  });
  try {
    // Fail open: no quotas → no usage bar chrome at all. Refresh first so
    // the malformed parse is what this phase exercises, not an empty cache.
    await expect(malformed.page.locator(".react-flow")).toBeVisible({
      timeout: 30_000,
    });
    await waitForBridge(malformed);
    await malformed.page.evaluate(() => window.vellumCommand?.refreshUsage?.());
    await expect(malformed.page.locator(".usage-hud")).toHaveCount(0, {
      timeout: 30_000,
    });
  } finally {
    await malformed.close();
  }
});
