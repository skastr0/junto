import { resolveJuntoHome } from "@shared/junto-home";
import { join, resolve } from "node:path";

/**
 * Install-local ops database — backfill ledgers and other process bookkeeping
 * that must never travel with product state seeds (dev-from-prod copy of
 * junto.db). Not product durability; not shared with Remotes via projection.
 *
 * Path: `<JUNTO_HOME>/.junto/state/install-ops.db`
 */
export const installOpsDatabasePath = (home: string = resolveJuntoHome()): string =>
  resolve(join(home, ".junto", "state", "install-ops.db"));
