/**
 * State migration 28 -> 29 names every artifact version's body by content
 * ref and retires the required `body_json` for a nullable `inline_body_json`.
 * Proven on both shipped fixtures brought to version 28 by the real steps:
 * every other row survives as it was, and a version held before the step
 * keeps its body as canonical bytes under the ref `artifactBodyRef` names.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V28_IDENTITY,
  STATE_SCHEMA_V29_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { artifactBodyRef } from "../src/main/junto/work/artifact-repository";
import { STATE_SCHEMA_V28_SQL, STATE_SCHEMA_V29_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-artifact-body-refs-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v13/${fixture}`, import.meta.url)), path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const snapshot = (database: DatabaseSync) =>
  Object.fromEntries(
    (
      database
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity'
            ORDER BY name`,
        )
        .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
    ).map(({ name }) => [String(name), database.prepare(`SELECT * FROM "${String(name)}" ORDER BY 1, 2`).all()]),
  );

/** The real steps, with the name first boot would give fixed so the proof does not depend on where it runs. */
const named = <T extends { readonly toVersion: number; readonly migrate: (database: DatabaseSync) => void }>(step: T): T =>
  step.toVersion === 21 ? { ...step, migrate: (database: DatabaseSync) => migrateMachineNames(database, "macbook") } : step;

const planTo = (version: number, currentSchemaSql: string) => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map(named),
});

const ID = "01J0000000000000000000000A";
const OP = "01J0000000000000000000000B";

/** A document artifact at version 2, written the way version 28 stored bodies: plain JSON, keys unsorted. */
const seedVersions = (database: DatabaseSync) => {
  database
    .prepare(
      `INSERT INTO artifact_heads (canvas_name, artifact_id, node_id, type, title, version,
        created_by_json, updated_at, archived, task_ids_json)
       VALUES ('factory', ?, 'artifacts-1', 'document', 'Notes', 2, '{"kind":"operator"}', 2, 0, '[]')`,
    )
    .run(ID);
  const version = database.prepare(
    `INSERT INTO artifact_versions (canvas_name, artifact_id, version, op_id, author_json, at, edit_json, body_json)
     VALUES ('factory', ?, ?, ?, '{"kind":"operator"}', ?, ?, ?)`,
  );
  version.run(ID, 1, OP, 1, null, '{"type":"document","markdown":""}');
  version.run(ID, 2, OP, 2, '{"kind":"replace"}', '{"type":"document","markdown":"# two"}');
};

describe("state migration 28 -> 29 (artifact body refs)", () => {
  it("freezes the witness the step starts from and the one it ends at", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V28_SQL)).toEqual(STATE_SCHEMA_V28_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V29_SQL)).toEqual(STATE_SCHEMA_V29_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "rebuilds artifact_versions in %s and leaves every other row as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, planTo(28, STATE_SCHEMA_V28_SQL));
        seedVersions(database);
        const before = snapshot(database);

        const result = migrateStateSchema(database, planTo(29, STATE_SCHEMA_V29_SQL));
        expect(result).toMatchObject({ previousVersion: 28, schemaVersion: 29 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V29_IDENTITY);

        const after = snapshot(database);
        const others = (snap: Record<string, unknown>) =>
          Object.fromEntries(Object.entries(snap).filter(([name]) => name !== "artifact_versions"));
        expect(others(after)).toEqual(others(before));
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const rows = database
          .prepare("SELECT version, edit_json, body_ref_json, inline_body_json FROM artifact_versions ORDER BY version")
          .all() as unknown as ReadonlyArray<{ version: number; edit_json: string | null; body_ref_json: string; inline_body_json: string }>;
        expect(rows.map((row) => [row.version, row.edit_json])).toEqual([[1, null], [2, '{"kind":"replace"}']]);
        const two = { type: "document", markdown: "# two" } as const;
        expect(JSON.parse(rows[1]!.inline_body_json)).toEqual(two);
        expect(JSON.parse(rows[1]!.body_ref_json)).toEqual(artifactBodyRef(two));
        // The stored bytes are exactly the bytes the ref names.
        expect(Buffer.byteLength(rows[1]!.inline_body_json)).toBe(artifactBodyRef(two).byteLength);
      } finally {
        database.close();
      }
    },
  );

  it("holds a pending version: a ref with no inline body", async () => {
    const database = await openCopy("command-center-v13.db");
    try {
      migrateStateSchema(database, planTo(29, STATE_SCHEMA_V29_SQL));
      database
        .prepare(
          `INSERT INTO artifact_heads (canvas_name, artifact_id, node_id, type, title, version,
            created_by_json, updated_at, archived, task_ids_json)
           VALUES ('factory', ?, 'artifacts-1', 'document', 'Notes', 1, '{"kind":"operator"}', 1, 0, '[]')`,
        )
        .run(ID);
      const insert = database.prepare(
        `INSERT INTO artifact_versions (canvas_name, artifact_id, version, op_id, author_json, at, edit_json, body_ref_json, inline_body_json)
         VALUES ('factory', ?, 1, ?, '{"kind":"operator"}', 1, NULL, ?, NULL)`,
      );
      insert.run(ID, OP, JSON.stringify(artifactBodyRef({ type: "document", markdown: "" })));
      expect(database.prepare("SELECT inline_body_json FROM artifact_versions").get()).toEqual({ inline_body_json: null });
    } finally {
      database.close();
    }
  });
});
