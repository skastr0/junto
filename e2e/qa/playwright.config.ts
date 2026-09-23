import { defineConfig } from "@playwright/test";

// QA runner config (T0 probes, and the scene seed for the packaged tiers). Same harness and node-only rule as
// e2e/playwright.config.ts; driven by `bun run qa:t0`, never by `--all`.
export default defineConfig({
  testDir: ".",
  testMatch: ["t0.spec.ts", "seed.spec.ts"],
  // Playwright empties outputDir at start; keep it off test-results/ itself so
  // a QA run never deletes the chunk files, the ledger, or another run's output.
  outputDir: "../../test-results/qa-t0/playwright",
  workers: 2,
  reporter: [["list"]],
  timeout: 600_000,
  use: {
    trace: "off",
    screenshot: "off",
  },
});
