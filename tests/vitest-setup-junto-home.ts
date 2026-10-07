/**
 * Keep unbound StateEngine defaults off the operator's production tree.
 *
 * Product default: resolveJuntoHome() → ~/.junto/state/junto.db
 * Dev: scripts/dev.sh sets JUNTO_HOME=~/.junto-dev
 * Tests: a process-private temp home so makeStateEngineLive() without a path
 * cannot open or migrate the real DB. Individual tests that inject paths are
 * unchanged; tests that need the real default must set JUNTO_HOME themselves.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetJuntoHomeCache } from "../src/shared/junto-home";
import { unitTestEnvironment } from "../scripts/unit-test-environment";

// Also protect direct `vitest run <file>` calls, before test imports execute.
// Tests that exercise auth explicitly install their own synthetic values.
const sanitized = unitTestEnvironment(process.env);
for (const name of Object.keys(process.env)) {
  if (!Object.hasOwn(sanitized, name)) delete process.env[name];
}

const isolatedHome = mkdtempSync(join(tmpdir(), "junto-vitest-home-"));
process.env.JUNTO_HOME = isolatedHome;
__resetJuntoHomeCache();
