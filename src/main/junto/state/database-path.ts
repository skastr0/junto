import { resolve } from "node:path";
import { demoStateDatabasePath } from "../demo/runtime-isolation";
import { productStateDatabasePath } from "./product-database-path";

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
  resolve(demoStateDatabasePath() ?? productStateDatabasePath());
