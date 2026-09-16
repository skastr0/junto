import { resolveVellumCommandHome } from "@shared/vellum-home";
import { join, resolve } from "node:path";

/**
 * Install-local ops database — backfill ledgers and other process bookkeeping
 * that must never travel with product state seeds (dev-from-prod copy of
 * vellum-command.db). Not product durability; not shared with Remotes via projection.
 *
 * Path: `<JUNTO_HOME>/.vellum-command/state/install-ops.db`
 */
export const installOpsDatabasePath = (home: string = resolveVellumCommandHome()): string =>
  resolve(join(home, ".vellum-command", "state", "install-ops.db"));
