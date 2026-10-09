/**
 * State migration 17 -> 18 names, on each canvas, the machine that may change
 * it (expand only). Proven on both shipped fixtures brought to version 17 by
 * the real steps: every row already held survives, each canvas is this
 * machine's, and a canvas created afterwards is this machine's too.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRecords } from "../src/main/junto/model/records";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import {
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V17_IDENTITY,
  STATE_SCHEMA_V18_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V17_SQL } from "./fixtures/state-v1/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const copyOf = async (fixture: string): Promise<string> => {
  dir = await mkdtemp(join(tmpdir(), "junto-canvas-editor-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v1/${fixture}`, import.meta.url)), path);
  return path;
};

const open = (path: string): DatabaseSync => {
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
    ).map(({ name }) => [String(name), database.prepare(`SELECT * FROM "${String(name)}"`).all()]),
  );

const versionSeventeenPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 17,
  currentSchemaSql: STATE_SCHEMA_V17_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 17),
};

describe("state migration 17 -> 18 (the machine that edits each canvas)", () => {
  it("freezes the version-seventeen witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V17_SQL)).toEqual(STATE_SCHEMA_V17_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V18_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(expectedStateSchemaIdentity(STATE_SCHEMA_SQL));
  });

  it.each([
    ["command-center-v1.db", "command-center-v1"],
    ["remote-v1.db", "remote-v1"],
  ])("makes every canvas of %s this machine's and leaves every other row as it was", async (fixture, installation) => {
    const database = open(await copyOf(fixture));
    try {
      migrateStateSchema(database, versionSeventeenPlan);
      const { canvases: canvasesBefore, ...before } = snapshot(database);

      const result = migrateStateSchema(database);
      expect(result).toMatchObject({ previousVersion: 17, schemaVersion: 18 });
      expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V18_IDENTITY);
      const { canvases, ...rest } = snapshot(database);
      expect(rest).toEqual(before);
      expect(canvases).toEqual(
        (canvasesBefore as ReadonlyArray<object>).map((row) => ({ ...row, editor_installation_id: installation })),
      );
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("stamps a new canvas with this machine and reads the editor back", async () => {
    const path = await copyOf("command-center-v1.db");
    const runtime = ManagedRuntime.make(Layer.provideMerge(ModelRecords.layer, makeStateEngineLive(path)));
    try {
      const editors = await runtime.runPromise(
        Effect.gen(function* () {
          const records = yield* ModelRecords;
          yield* records.createCanvas("another", "canvas-another");
          return {
            held: yield* records.canvasEditor("factory"),
            created: yield* records.canvasEditor("another"),
            missing: yield* records.canvasEditor("no-such-canvas"),
          };
        }),
      );
      expect(editors).toEqual({ held: "command-center-v1", created: "command-center-v1", missing: undefined });
      const edits = await runtime.runPromise(
        Effect.gen(function* () {
          const records = yield* ModelRecords;
          const sql = yield* SqlClient.SqlClient;
          const own = yield* records.editsCanvas("factory");
          yield* sql`UPDATE canvases SET editor_installation_id = 'another-machine' WHERE canvas_name = 'another'`;
          return { own, copy: yield* records.editsCanvas("another"), missing: yield* records.editsCanvas("no-such-canvas") };
        }),
      );
      expect(edits).toEqual({ own: true, copy: false, missing: true });
    } finally {
      await runtime.dispose();
    }
  });
});
