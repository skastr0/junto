/**
 * Seed isolated dev state from production when shapes match.
 *
 * Copies ~/.vellum/state/vellum.db into $VELLUM_HOME/.vellum/state/ only when
 * prod's live schema fingerprint equals this build's current schema. Otherwise
 * leaves the isolated tree alone so schema work can migrate independently.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_STATE_SCHEMA_VERSION } from "../src/main/vellum/state/migrations";
import { STATE_SCHEMA_SQL } from "../src/main/vellum/state/schema";
import {
  actualStateSchemaSha256,
  expectedStateSchemaIdentity,
} from "../src/main/vellum/state/schema-identity";

const prodDb = join(homedir(), ".vellum", "state", "vellum.db");
const vellumHome =
  process.env.VELLUM_HOME?.trim() || join(homedir(), ".vellum-dev");
const devDb = join(vellumHome, ".vellum", "state", "vellum.db");

const log = (message: string): void => {
  process.stderr.write(`vellum dev: ${message}\n`);
};

if (!existsSync(prodDb)) {
  log("no production database; keeping isolated state");
  process.exit(0);
}

const expected = expectedStateSchemaIdentity(STATE_SCHEMA_SQL);
let prodVersion = -1;
let prodActual = "";

const prod = new DatabaseSync(prodDb, {
  open: true,
  readOnly: true,
  allowExtension: false,
});
try {
  const row = prod.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  prodVersion = Number(row?.user_version);
  prodActual = actualStateSchemaSha256(prod);
} finally {
  prod.close();
}

if (
  prodVersion !== CURRENT_STATE_SCHEMA_VERSION ||
  prodActual !== expected.actualSchemaSha256
) {
  log(
    `prod schema v${prodVersion} (actual ${prodActual.slice(0, 12)}…) ≠ current v${CURRENT_STATE_SCHEMA_VERSION}; keeping isolated state`,
  );
  process.exit(0);
}

mkdirSync(dirname(devDb), { recursive: true, mode: 0o700 });
for (const suffix of ["", "-wal", "-shm"] as const) {
  const path = `${devDb}${suffix}`;
  if (existsSync(path)) unlinkSync(path);
}

// Best-effort coherent copy: checkpoint prod if unlocked, then copy main file.
try {
  const writable = new DatabaseSync(prodDb, {
    open: true,
    readOnly: false,
    allowExtension: false,
  });
  try {
    writable.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    writable.close();
  }
} catch {
  // Prod may be locked by a running app; still copy the main file.
}

copyFileSync(prodDb, devDb);
log(`seeded isolated state from production (v${prodVersion})`);
