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

const isolatedHome = mkdtempSync(join(tmpdir(), "junto-vitest-home-"));
process.env.JUNTO_HOME = isolatedHome;
__resetJuntoHomeCache();
