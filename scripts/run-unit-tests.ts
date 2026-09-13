#!/usr/bin/env bun
/**
 * Full unit suite: reusable workers for state-free files, isolated forks for
 * mocks/env/spawn/SQLite/PTY. Targeted `vitest run <file>` still uses the
 * default isolated config.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vitestFileLanes } from "./vitest-file-lanes";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");
const extra = process.argv.slice(2);
const lanes = vitestFileLanes();

const run = (
  label: string,
  isolate: boolean,
  files: readonly string[],
): void => {
  const started = Date.now();
  const result = spawnSync(
    VITEST,
    ["run", isolate ? "--isolate" : "--no-isolate", ...files, ...extra],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    },
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    console.error(`unit-tests: ${label} FAIL (${seconds}s)`);
    process.exit(result.status ?? 1);
  }
  console.error(`unit-tests: ${label} ok (${seconds}s)`);
};

run("shared", false, lanes.shared);
run("isolated", true, lanes.isolated);
