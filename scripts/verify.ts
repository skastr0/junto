#!/usr/bin/env bun
/**
 * Ship gate. Cheap lints first, then overlapping lanes: typecheck, unit
 * tests, ship-profile gates, compile. Every lane must pass. Vitest is
 * worker-capped so tsc and electron-vite still get CPU.
 */
import { spawn } from "node:child_process";
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
  { name: "lint:no-middot", cmd: ["bun", "scripts/lint-no-middot.ts"] },
  { name: "lint:effect-runpromise", cmd: ["bun", "scripts/lint-effect-runpromise.ts"] },
  { name: "lint:single-write-seam", cmd: ["bun", "scripts/lint-single-write-seam.ts"] },
]);

const vitestWorkers = process.env.CI === "true" ? "2" : "4";

// electron-vite must not run beside tests: both download Electron and write
// under out/.
await allMustPass([
  { name: "typecheck", cmd: ["tsc", "--noEmit"] },
  {
    name: "test",
    cmd: ["bun", "scripts/run-unit-tests.ts", `--maxWorkers=${vitestWorkers}`],
    env: { VELLUM_COMMAND_TEST_FEATURE_PROFILE: "all-on" },
  },
]);

await allMustPass([
  {
    name: "test:features:ship",
    cmd: [
      "vitest",
      "run",
      "tests/features-build-profile.test.ts",
      "tests/features-browser-gate.test.ts",
      "tests/features-dev-tools-gate.test.ts",
      "tests/features-fleet-gate.test.ts",
      "tests/features-harness-gate.test.ts",
      "tests/features-harness-settings-gate.test.ts",
      "tests/features-hermes-integration-gate.test.ts",
      "tests/features-scheduler-gate.test.ts",
      "tests/features-ui-gates.test.ts",
      "tests/features-usage-gate.test.ts",
    ],
    env: { VELLUM_COMMAND_TEST_FEATURE_PROFILE: "ship" },
  },
]);

await allMustPass([
  { name: "electron-vite build", cmd: ["electron-vite", "build"] },
]);
