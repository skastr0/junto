/**
 * Step 61 seeds a canvas with no editor named as this machine's own (0.11/06
 * F6). That is correct only if a NULL editor never reaches a canvas another
 * machine edits: a copy taken in must always name its editor, so the seed
 * lists that machine and never this one.
 */
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { FLEET_CONSENSUS_SEED_SQL, FLEET_CONSENSUS_STATE_SCHEMA_SQL } from "../src/main/junto/fleet/state-schema";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelService } from "../src/main/junto/model/service";
import { MODEL_STATE_SCHEMA_SQL } from "../src/main/junto/model/state-schema";
import { installSqlCommitCallbacks } from "../src/main/junto/state/sql-commit";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { CanvasCopy } from "../src/shared/canvas-copy";
import { Command, asCanvasName } from "../src/shared/model";

const SELF = "mini-installation";
const EDITOR = "macbook-installation";

it("refuses a copy on the wire that names no editor", () => {
  const decode = Schema.decodeUnknownExit(CanvasCopy);
  for (const editor of [null, undefined, ""]) {
    const exit = decode({ canvasName: "factory", canvasId: "canvas-factory", seq: 1, editor, target: SELF, seats: [], peers: [], terminals: [], regions: [], wires: [], resources: [] });
    expect(exit._tag).toBe("Failure");
  }
});

it("takes a copy in with its editor named, so step 61 lists that machine and never this one", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* Effect.acquireRelease(Effect.sync(() => new DatabaseSync(":memory:")), (opened) => Effect.sync(() => opened.close()));
        db.exec(MODEL_STATE_SCHEMA_SQL);
        db.exec(`CREATE TABLE installation(singleton INTEGER PRIMARY KEY, installation_id TEXT);
          CREATE TABLE machine_configuration(singleton INTEGER PRIMARY KEY, machine_name TEXT);
          CREATE TABLE machine_peers(machine_name TEXT, installation_id TEXT, retired_at TEXT);
          INSERT INTO installation VALUES (1, '${SELF}');
          INSERT INTO machine_configuration VALUES (1, 'mini');`);
        db.exec(FLEET_CONSENSUS_STATE_SCHEMA_SQL);
        const sql = yield* makeSqliteClient(db);
        installSqlCommitCallbacks(sql);
        yield* Effect.gen(function* () {
          const model = yield* ModelService;
          // A replica, and this machine's own canvas that never changed, which a copy of that name replaces.
          yield* model.command(Schema.decodeUnknownSync(Command)({ _tag: "CreateCanvas", canvas: "home" }), "operator");
          yield* model.installCopy({ canvas: asCanvasName("factory"), canvasId: "canvas-factory", seq: 3, editor: EDITOR, nodes: [], wires: [] });
          yield* model.installCopy({ canvas: asCanvasName("home"), canvasId: "canvas-home-macbook", seq: 2, editor: EDITOR, nodes: [], wires: [] });
        }).pipe(Effect.provide(ModelService.layer), Effect.provide(ModelDependents.empty), Effect.provideService(SqlClient.SqlClient, sql));

        expect(db.prepare("SELECT canvas_name, editor_installation_id FROM canvases ORDER BY canvas_name").all()).toEqual([
          { canvas_name: "factory", editor_installation_id: EDITOR },
          { canvas_name: "home", editor_installation_id: EDITOR },
        ]);
        db.exec(FLEET_CONSENSUS_SEED_SQL);
        expect(db.prepare("SELECT canvas_name, position, installation_id FROM canvas_authorities ORDER BY canvas_name").all()).toEqual([
          { canvas_name: "factory", position: 0, installation_id: EDITOR },
          { canvas_name: "home", position: 0, installation_id: EDITOR },
        ]);
      }),
    ).pipe(Effect.provide(Reactivity.layer)),
  ));
