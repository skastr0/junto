#!/usr/bin/env bun
/**
 * Full unit suite: reusable workers for state-free files, isolated forks for
 * mocks/env/spawn/SQLite/PTY, then the files marked to run alone, one at a
 * time. Targeted `vitest run <file>` still uses the
 * default isolated config.
 *
 * `--lane=shared|isolated|alone` runs one lane, so CI gives each its own job.
 * Every other flag goes to Vitest (`--shard=1/2`, `--maxWorkers=2`).
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vitestFileLanes } from "./vitest-file-lanes";
import { unitTestEnvironment } from "./unit-test-environment";
import { formatQuarantine, readQuarantine } from "./ci-quarantine";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");
const LANES = ["shared", "isolated", "alone"] as const;
type LaneName = (typeof LANES)[number];
const laneFlag = process.argv.slice(2).find((arg) => arg.startsWith("--lane="));
const extra = process.argv.slice(2).filter((arg) => arg !== laneFlag);
const only = laneFlag?.slice("--lane=".length);
if (only !== undefined && !LANES.includes(only as LaneName)) {
  console.error(`unit-tests: unknown --lane=${only}; expected ${LANES.join(", ")}`);
  process.exit(2);
}
const selected = (lane: LaneName): boolean => only === undefined || only === lane;
const lanes = vitestFileLanes();

const quarantine = readQuarantine();
const report = formatQuarantine(quarantine);
console.error(report);
const inCi = process.env.CI === "true";
if (inCi && process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${report}\n\`\`\`\n`);
}
// Whole files leave the lane; single tests are skipped by
// tests/vitest-setup-ci-quarantine.ts.
const quarantinedFiles = new Set(
  inCi ? quarantine.filter((entry) => entry.test === "*").map((entry) => entry.file) : [],
);
const quarantinedTests = inCi ? quarantine.filter((entry) => entry.test !== "*") : [];
const laneFiles = (files: readonly string[]): readonly string[] =>
  files.filter((file) => !quarantinedFiles.has(file));

// Electron's package downloads its binary synchronously on first require.
// Cold parallel workers otherwise race while unpacking the same directory.
const runtime = spawnSync(process.execPath, ["-e", "require('electron')"], {
  cwd: ROOT,
  stdio: "inherit",
  env: unitTestEnvironment(process.env),
});
if (runtime.status !== 0) process.exit(runtime.status ?? 1);

const run = (
  label: string,
  isolate: boolean,
  files: readonly string[],
  flags: readonly string[] = [],
): void => {
  if (files.length === 0) return;
  const started = Date.now();
  const result = spawnSync(
    VITEST,
    ["run", isolate ? "--isolate" : "--no-isolate", ...flags, ...files, ...extra],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...unitTestEnvironment(process.env),
        ...(quarantinedTests.length > 0
          ? { JUNTO_CI_QUARANTINE: JSON.stringify(quarantinedTests) }
          : {}),
      },
    },
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    console.error(`unit-tests: ${label} FAIL (${seconds}s)`);
    process.exit(result.status ?? 1);
  }
  console.error(`unit-tests: ${label} ok (${seconds}s)`);
};

if (selected("shared")) run("shared", false, laneFiles(lanes.shared));
if (selected("isolated")) run("isolated", true, laneFiles(lanes.isolated));
if (selected("alone")) run("alone", true, laneFiles(lanes.alone), ["--no-file-parallelism"]);
