/**
 * Keep unbound StateEngine defaults off the operator's production tree.
 *
 * Product default: resolveVellumCommandHome() → ~/.vellum-command/state/vellum.db
 * Dev: scripts/dev.sh sets VELLUM_COMMAND_HOME=~/.vellum-command-dev
 * Tests: a process-private temp home so makeStateEngineLive() without a path
 * cannot open or migrate the real DB. Individual tests that inject paths are
 * unchanged; tests that need the real default must set VELLUM_COMMAND_HOME themselves.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetVellumCommandHomeCache } from "../src/shared/vellum-home";

const isolatedHome = mkdtempSync(join(tmpdir(), "vellum-vitest-home-"));
process.env.VELLUM_COMMAND_HOME = isolatedHome;
__resetVellumCommandHomeCache();
