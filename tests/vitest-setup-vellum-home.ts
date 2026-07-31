/**
 * Keep unbound StateEngine defaults off the operator's production tree.
 *
 * Product default: resolveVellumHome() → ~/.vellum/state/vellum.db
 * Dev: scripts/dev.sh sets VELLUM_HOME=~/.vellum-dev
 * Tests: a process-private temp home so makeStateEngineLive() without a path
 * cannot open or migrate the real DB. Individual tests that inject paths are
 * unchanged; tests that need the real default must set VELLUM_HOME themselves.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetVellumHomeCache } from "../src/shared/vellum-home";

const isolatedHome = mkdtempSync(join(tmpdir(), "vellum-vitest-home-"));
process.env.VELLUM_HOME = isolatedHome;
__resetVellumHomeCache();
