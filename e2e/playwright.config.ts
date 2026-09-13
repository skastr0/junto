import { defineConfig } from "@playwright/test";

// node only: playwright-core's Electron driver's launch handshake times out
// under bun (~30s). Run via the `test:e2e*` scripts (`bun run test:e2e:fast
// <spec>` / `test:e2e:full`), which shell out to the node-installed `playwright`
// binary — never `bun x playwright`.
export default defineConfig({
  testDir: "./scenarios",
  workers: 2,
  reporter: [["list"]],
  timeout: 90_000,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
