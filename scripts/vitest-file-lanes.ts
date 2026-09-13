#!/usr/bin/env bun
/**
 * Split unit tests into a reusable-worker lane vs an isolated-process lane.
 *
 * Default Vitest forks once per file. Most files are pure Effect/schema/UI
 * assertions and can share a worker. Files that mock modules, mutate env,
 * spawn children, or own SQLite/PTY hosts stay isolated.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = join(ROOT, "tests");

const ISOLATE_HINTS = [
  /vi\.mock\(/,
  /process\.env\.\w+\s*=/,
  /\b(spawnSync|execFileSync|execSync|Bun\.spawn)\b/,
  /makeFakeTerminalProcessAuthority/,
  /LocalSessionHost/,
  /node:sqlite/,
  /makeStateEngineLive/,
  /StateEngineLive/,
  /vi\.stubEnv\(/,
  /vi\.stubGlobal\(/,
] as const;

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return walk(full);
    if (!entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) {
      return [];
    }
    return [full];
  });

const isolate = (path: string, source: string): boolean => {
  const rel = relative(TESTS, path);
  if (rel.startsWith("pty-e2e/")) return true;
  // Live UDS / session pumps share process-local registries; reuse leaks.
  if (rel === "station-remote-report-pump.test.ts") return true;
  if (rel === "operator-control-server.test.ts") return true;
  return ISOLATE_HINTS.some((hint) => hint.test(source));
};

export const vitestFileLanes = (): {
  readonly shared: readonly string[];
  readonly isolated: readonly string[];
} => {
  const shared: string[] = [];
  const isolated: string[] = [];
  for (const path of walk(TESTS)) {
    const source = readFileSync(path, "utf8");
    const rel = relative(ROOT, path);
    if (isolate(path, source)) isolated.push(rel);
    else shared.push(rel);
  }
  shared.sort();
  isolated.sort();
  return { shared, isolated };
};

if (import.meta.main) {
  const lanes = vitestFileLanes();
  console.log(`shared ${lanes.shared.length}`);
  console.log(`isolated ${lanes.isolated.length}`);
}
