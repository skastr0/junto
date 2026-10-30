import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import {
  featureViteDefines,
  resolveBuildFeatures,
} from "./scripts/build-features";
import { overlayAlias, resolveOverlay } from "./scripts/overlay";

// Mirrors electron.vite.config.ts's alias map. Vitest does not read
// electron-vite's own config file, so without this, any test that reaches a
// `@shared/*` VALUE import (not just a type-only import, which erases at
// transpile time) fails with "Cannot find package '@shared/...'" — the gap
// this file closes. Before this existed, the one test that needed it
// (b5-races-canvases.test.ts) worked around the gap with its own per-file
// `vi.mock("@shared/canvas", ...)` redirect; this makes that workaround
// unnecessary for every test going forward.
const testFeatureEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  ...(process.env.JUNTO_TEST_FEATURE_PROFILE
    ? { JUNTO_FEATURE_PROFILE: process.env.JUNTO_TEST_FEATURE_PROFILE }
    : {}),
};

/**
 * `?nodeWorker` is electron-vite's worker entry suffix: the build turns it into
 * a worker factory, and every runtime with no worker entry gets `undefined`
 * instead (the machine core bundle does the same). Units tests get that, for
 * every such import, and each host already handles it: the state engine skips
 * its maintenance worker (maintenance.ts:40) and backs up on the calling
 * thread (backup-host.ts), the Files index takes no worker
 * (index-worker-host.ts), and a mail read that cannot go off main reads on
 * main (work/service.ts, offMain).
 */
const nodeWorkerStub = {
  name: "junto-node-worker-stub",
  enforce: "pre" as const,
  resolveId(id: string): string | undefined {
    return id.endsWith("?nodeWorker") ? "\0junto-node-worker-stub" : undefined;
  },
  load(id: string): string | undefined {
    return id === "\0junto-node-worker-stub" ? "export default undefined;" : undefined;
  },
};

export default defineConfig({
  plugins: [nodeWorkerStub],
  // Tests default to the exact shipping profile. Feature-specific suites opt
  // into all-on or individual JUNTO_* overrides before Vitest starts.
  define: featureViteDefines(resolveBuildFeatures(testFeatureEnvironment)),
  test: {
    // e2e/ specs use @playwright/test's own `test`/`expect` and launch a
    // real Electron app — vitest's default glob would otherwise pick up
    // every *.spec.ts under e2e/ and try to run it as a vitest test.
    // infra/ owns its own package, lockfile, dependencies, and deployment
    // lifecycle. It is not part of the application test surface.
    // A build an agent keeps under .amp/ is not the test surface either.
    exclude: [...configDefaults.exclude, "e2e/**", "infra/**", ".amp/**", "**/.amp/**"],
    // Unbound StateEngineLive / stateDatabasePath() must never resolve to
    // the operator's ~/.junto production tree during unit tests.
    setupFiles: [
      resolve(__dirname, "tests/vitest-setup-junto-home.ts"),
      // No-op unless the lane runner hands over the disabled tests.
      resolve(__dirname, "tests/vitest-setup-disabled-tests.ts"),
    ],
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      "@main": resolve(__dirname, "src/main"),
      "@renderer": resolve(__dirname, "src/renderer"),
      // Tests always run against the open-source stub, whatever the shell sets.
      ...overlayAlias(resolveOverlay({})),
    },
  },
});
