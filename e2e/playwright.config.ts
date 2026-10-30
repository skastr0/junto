import { registerHooks } from "node:module";
import { defineConfig } from "@playwright/test";

// A vite `?nodeWorker` or `?modulePath` import has no entry under Playwright:
// it resolves to a module with no default export, and its host takes its
// no-worker path, as in the machine core bundle (scripts/build-machine.ts).
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    specifier.endsWith("?nodeWorker") || specifier.endsWith("?modulePath")
      ? { url: "data:text/javascript,export default undefined;", format: "module", shortCircuit: true }
      : nextResolve(specifier, context),
});

// node only: playwright-core's Electron driver's launch handshake times out
// under bun (~30s). Run via the `test:e2e*` scripts (`bun run test:e2e:fast
// <spec>` / `test:e2e:full`), which shell out to the node-installed `playwright`
// binary — never `bun x playwright`.
export default defineConfig({
  testDir: "./scenarios",
  workers: 2,
  // A stray test.only would silently narrow a CI run to one test.
  forbidOnly: Boolean(process.env.CI),
  // No retries: a spec that passes on the second try is a flake to fix, and
  // the startup gate must not hide a first-launch hang.
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  timeout: 90_000,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
