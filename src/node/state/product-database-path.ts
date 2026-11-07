import { join, resolve } from "node:path";
import { resolveJuntoHome } from "@shared/junto-home";

/**
 * The installed product database, never the demo one. Apart from
 * ./database-path so a process that only probes it (main's boot gate) links no
 * demo directory: the demo database is the core's, minted fresh each run.
 */
export const productStateDatabasePath = (): string =>
  resolve(join(resolveJuntoHome(), ".junto", "state", "junto.db"));
