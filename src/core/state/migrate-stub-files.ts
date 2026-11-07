import { STUBS_V63_STATE_SCHEMA_SQL } from "../model/state-schema";
import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * A Files node of another machine crosses as a stub (0.11, F1): its geometry
 * and a label only when the operator wrote one, never its host, root, folder
 * name or file count. SQLite widens a CHECK no other way, so `stubs` is
 * rebuilt with `files` in its `stub_of` CHECK and every row is copied as it
 * was. The page-only CHECKs hold as they did.
 */
export const STUB_FILES_REPLACED_TABLES = ["stubs"] as const;

const COLUMNS = [
  "canvas_name",
  "id",
  "x",
  "y",
  "width",
  "height",
  "z_index",
  "color",
  "created_at",
  "updated_at",
  "stub_of",
  "label",
  "host",
] as const;

export const migrateStubFiles = (database: StateSchemaMigrationDatabase): void => {
  const stored = database
    .prepare(`SELECT ${COLUMNS.join(", ")} FROM stubs ORDER BY canvas_name, id`)
    .all() as unknown as ReadonlyArray<Record<(typeof COLUMNS)[number], string | number | null>>;

  database.exec("DROP TABLE stubs");
  database.exec(STUBS_V63_STATE_SCHEMA_SQL);
  const insert = database.prepare(
    `INSERT INTO stubs(${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
  );
  for (const row of stored) insert.run(...COLUMNS.map((column) => row[column]));
  const kept = Number(database.prepare("SELECT count(*) AS n FROM stubs").get()!.n);
  if (kept !== stored.length) throw new Error("a stub did not survive the files stub step");
};
