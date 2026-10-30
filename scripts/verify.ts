#!/usr/bin/env bun
/**
 * Ship gate. Cheap lints first, then overlapping lanes: typecheck, unit
 * tests, ship-profile gates, compile. Every lane must pass. Vitest is
 * worker-capped so the type checker and electron-vite still get CPU.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "node_modules", ".bin");

type Lane = {
  readonly name: string;
  readonly cmd: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
};

const run = (lane: Lane): Promise<number> =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(lane.cmd[0]!, lane.cmd.slice(1), {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: `${BIN}:${process.env.PATH ?? ""}`,
        ...lane.env,
      },
    });
    child.on("error", (error) => {
      console.error(`verify: ${lane.name} spawn failed: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const status = code === 0 ? "ok" : "FAIL";
      console.error(`verify: ${lane.name} ${status} (${seconds}s)`);
      resolve(code ?? 1);
    });
  });

const allMustPass = async (lanes: readonly Lane[]): Promise<void> => {
  const results = await Promise.all(
    lanes.map(async (lane) => ({ lane, code: await run(lane) })),
  );
  const failed = results.filter((result) => result.code !== 0);
  if (failed.length === 0) return;
  for (const result of failed) {
    console.error(`verify: ${result.lane.name} failed (${result.code})`);
  }
  process.exit(1);
};

await allMustPass([
  { name: "lint:product-name", cmd: ["bun", "scripts/lint-product-name.ts"] },
  { name: "lint:no-canvas-document", cmd: ["bun", "scripts/lint-no-canvas-document.ts", "--enforce"] },
  { name: "lint:no-middot", cmd: ["bun", "scripts/lint-no-middot.ts"] },
  { name: "lint:effect-runpromise", cmd: ["bun", "scripts/lint-effect-runpromise.ts"] },
  { name: "lint:focus-law", cmd: ["bun", "scripts/lint-focus-law.ts"] },
  { name: "lint:overlay", cmd: ["bun", "scripts/lint-overlay.ts"] },
  { name: "lint:layers", cmd: ["bun", "scripts/lint-layers.ts"] },
  { name: "lint:design-tokens", cmd: ["bun", "scripts/lint-design-tokens.ts"] },
  { name: "theme:check", cmd: ["bun", "scripts/theme-build.ts", "--check"] },
]);

const vitestWorkers = process.env.CI === "true" ? "2" : "4";

// Locally the lane is tsrs: on a busy main the TypeScript 7 cache is always
// stale, so tsc costs about 23 cpu-s and 3.4 GB a run against tsrs's 6 and
// 1. CI keeps TypeScript 7 as the reference checker, and the hourly main
// verify runs both and reports any disagreement.
const typecheck: readonly string[] =
  process.env.CI === "true"
    ? ["tsc", "--noEmit", "--incremental", "--tsBuildInfoFile", ".tsbuildinfo"]
    : ["tsrs", "--noEmit", "--incremental", "--tsBuildInfoFile", ".tsrs.tsbuildinfo"];

// Every feature gate test runs in the ship profile. Discovered, not listed:
// a gate added after this file was last edited must not skip CI.
const shipProfileTests = (): string[] =>
  readdirSync(join(ROOT, "tests"))
    .filter(
      (name) =>
        name === "features-build-profile.test.ts" ||
        name === "features-ui-gates.test.ts" ||
        /^features-[a-z0-9-]+-gate\.test\.ts$/u.test(name),
    )
    .sort()
    .map((name) => `tests/${name}`);

// electron-vite must not run beside tests: both download Electron and write
// under out/.
await allMustPass([
  {
    name: "typecheck",
    // The full check owns the incremental cache; seat-made scoped configs
    // that extend tsconfig.json write none.
    cmd: typecheck,
  },
  {
    name: "test",
    cmd: ["bun", "scripts/run-unit-tests.ts", `--maxWorkers=${vitestWorkers}`],
    env: { JUNTO_TEST_FEATURE_PROFILE: "all-on" },
  },
]);

await allMustPass([
  {
    name: "test:features:ship",
    cmd: ["vitest", "run", ...shipProfileTests()],
    env: { JUNTO_TEST_FEATURE_PROFILE: "ship" },
  },
]);

await allMustPass([
  { name: "electron-vite build", cmd: ["electron-vite", "build"] },
]);

// The build above resolved JUNTO_OVERLAY; unset, out/ must hold no overlay.
// Its output is also what the main-bundle gate reads: main's static import
// closure must reach no core module (scripts/lint-main-bundle.ts).
await allMustPass([
  { name: "check:main-bundle", cmd: ["bun", "scripts/lint-main-bundle.ts"] },
  { name: "check:overlay-bundle", cmd: ["bun", "scripts/lint-overlay.ts", "--bundle"] },
]);

// The app built above reaches its first window: a real launch, so a preload
// that throws in the sandbox or a main that throws while registering IPC
// fails here (4cd57bdc3, 3776924fc). CI runs the same spec as its own job
// (verify.yml, free-startup-e2e), with the display and browser deps it needs.
// In a shared checkout HEAD moves under a running verify, so the launch
// expects the commit this build stamped, not whatever HEAD is by then.
if (process.env.CI !== "true") {
  const stamp = JSON.parse(readFileSync(join(ROOT, "out", "build-source.json"), "utf8")) as {
    readonly sourceCommit?: string;
  };
  await allMustPass([
    {
      name: "first window",
      cmd: ["scripts/run-e2e.sh", "e2e/scenarios/free-startup.spec.ts"],
      env: { JUNTO_E2E_EXPECT_COMMIT: stamp.sourceCommit ?? "" },
    },
  ]);
}
