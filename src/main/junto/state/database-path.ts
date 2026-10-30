import { join, resolve } from "node:path";
import { resolveJuntoHome } from "@shared/junto-home";
import { demoStateDatabasePath } from "../demo/runtime-isolation";

/**
 * Resolve the sole product database. Demo mode receives only a process-minted
 * ephemeral database; no environment variable can redirect product authority.
 * Tests that exercise a StateEngine directly inject a path into
 * makeStateEngineLive instead of creating a second runtime convention.
 *
 * Apart from the engine so the boot gate's read-only probe can find the file
 * without linking the engine, the schema and the migration chain into the
 * process that asks.
 */
export const stateDatabasePath = (): string =>
  resolve(
    demoStateDatabasePath() ??
      join(resolveJuntoHome(), ".junto", "state", "junto.db"),
  );
