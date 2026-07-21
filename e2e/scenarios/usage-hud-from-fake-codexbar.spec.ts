import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeScenario } from "../fakes/codexbar-scenario";
import { expect, launchVellum, test } from "../harness/launch";

// Real spawn->parse pipeline against a fake `codexbar` on PATH — no demo
// mode. Two separate launches (codexbar's scenario is fixed per process):
// healthy quotas paint the rail, then a malformed-JSON scenario shows the
// typed parse-error degrade (UsageHud.tsx honest selectors — no HUD text
// invented here that the component doesn't actually render).

test("usage HUD renders fake codexbar quotas, then degrades on malformed output", async () => {
  const scenarioDir = await mkdtemp(join(tmpdir(), "vellum-e2e-codexbar-"));

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

  const healthy = await launchVellum({
    extraEnv: { FAKE_CODEXBAR_SCENARIO: healthyScenarioPath },
  });
  try {
    const rail = healthy.page.getByRole("button", { name: "Provider limits", exact: true });
    await expect(rail).toBeVisible({ timeout: 30_000 });
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
    const errorChip = malformed.page.getByRole("button", { name: /Provider limits: usage parse error/ });
    await expect(errorChip).toBeVisible({ timeout: 30_000 });
  } finally {
    await malformed.close();
  }
});
