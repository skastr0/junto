import { resolveVellumHome } from "@shared/vellum-home";
import { join, resolve } from "node:path";

/**
 * Install-local ops database — backfill ledgers and other process bookkeeping
 * that must never travel with product state seeds (dev-from-prod copy of
 * vellum.db). Not product durability; not shared with Remotes via projection.
 *
 * Path: `<VELLUM_HOME>/.vellum/state/install-ops.db`
 */
export const installOpsDatabasePath = (home: string = resolveVellumHome()): string =>
  resolve(join(home, ".vellum", "state", "install-ops.db"));
