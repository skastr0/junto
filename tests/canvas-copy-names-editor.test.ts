/**
 * Step 61 seeds a canvas with no editor named as this machine's own (0.11/06
 * F6). That is correct only if a NULL editor never reaches a canvas another
 * machine edits: a copy taken in must always name its editor, so the seed
 * lists that machine and never this one. With AUTHORITY_ENABLED on, taking a
 * copy in writes that list itself: a takeover begins the canvas as step 61
 * seeds it, and a newer copy of the same canvas leaves its consensus alone.
 */
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ authority: false }));
vi.mock("@shared/features", async (original) => ({
  ...(await original<typeof import("../src/shared/features")>()),
  get AUTHORITY_ENABLED() { return flags.authority; },
}));

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

const copyOf = (canvas: string, canvasId: string, seq: number) =>
  ({ canvas: asCanvasName(canvas), canvasId, seq, editor: EDITOR, nodes: [], wires: [] });

/** A machine's model over a fresh store, with the authority on or off. */
const machine = (authority: boolean, test: (model: ModelService["Service"], db: DatabaseSync) => Effect.Effect<void, unknown>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        flags.authority = authority;
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
          yield* test(yield* ModelService, db);
        }).pipe(Effect.provide(ModelService.layer), Effect.provide(ModelDependents.empty), Effect.provideService(SqlClient.SqlClient, sql));
      }),
    ).pipe(Effect.provide(Reactivity.layer)),
  );

const createOwn = (model: ModelService["Service"], canvas: string) =>
  model.command(Schema.decodeUnknownSync(Command)({ _tag: "CreateCanvas", canvas }), "operator");

const consensusOf = (db: DatabaseSync, canvas: string) => ({
  consensus: db.prepare("SELECT current_term, voted_for, commit_index, applied_index FROM canvas_consensus WHERE canvas_name = ?").all(canvas),
  list: db.prepare("SELECT position, installation_id FROM canvas_authorities WHERE canvas_name = ? ORDER BY position").all(canvas),
  log: db.prepare("SELECT log_index FROM canvas_log WHERE canvas_name = ?").all(canvas),
});

it("refuses a copy on the wire that names no editor", () => {
  const decode = Schema.decodeUnknownExit(CanvasCopy);
  for (const editor of [null, undefined, ""]) {
    const exit = decode({ canvasName: "factory", canvasId: "canvas-factory", seq: 1, editor, target: SELF, seats: [], peers: [], terminals: [], regions: [], wires: [], resources: [] });
    expect(exit._tag).toBe("Failure");
  }
});

describe.each([false, true])("with the authority %s", (authority) => {
  it("takes a copy in with its editor named, so a replica's list is that machine and never this one", () =>
    machine(authority, (model, db) =>
      Effect.gen(function* () {
        // A replica, and this machine's own canvas that never changed, which a copy of that name replaces.
        yield* createOwn(model, "home");
        yield* model.installCopy(copyOf("factory", "canvas-factory", 3));
        yield* model.installCopy(copyOf("home", "canvas-home-macbook", 2));

        expect(db.prepare("SELECT canvas_name, editor_installation_id FROM canvases ORDER BY canvas_name").all()).toEqual([
          { canvas_name: "factory", editor_installation_id: EDITOR },
          { canvas_name: "home", editor_installation_id: EDITOR },
        ]);
        db.exec(FLEET_CONSENSUS_SEED_SQL);
        expect(db.prepare("SELECT canvas_name, position, installation_id FROM canvas_authorities ORDER BY canvas_name").all()).toEqual([
          { canvas_name: "factory", position: 0, installation_id: EDITOR },
          { canvas_name: "home", position: 0, installation_id: EDITOR },
        ]);
      })));
});

describe("taking a copy in, with the authority on", () => {
  it("over this machine's own canvas, begins it as step 61 seeds it: the copy's editor alone, at term 1, its log gone", () =>
    machine(true, (model, db) =>
      Effect.gen(function* () {
        yield* createOwn(model, "home");
        // The canvas's group had moved on here: a raised term, a vote, a log.
        db.exec(`UPDATE canvas_consensus SET current_term = 5, voted_for = '${SELF}', commit_index = 1, applied_index = 1 WHERE canvas_name = 'home';
          INSERT INTO canvas_log (canvas_name, log_index, term, kind) VALUES ('home', 1, 1, 'list');`);
        yield* model.installCopy(copyOf("home", "canvas-home-macbook", 2));
        expect(consensusOf(db, "home")).toEqual({
          consensus: [{ current_term: 1, voted_for: null, commit_index: 0, applied_index: 0 }],
          list: [{ position: 0, installation_id: EDITOR }],
          log: [],
        });
      })));

  it("a newer copy of the same canvas never lowers its term, clears its vote or replaces its list", () =>
    machine(true, (model, db) =>
      Effect.gen(function* () {
        yield* model.installCopy(copyOf("factory", "canvas-factory", 3));
        expect(consensusOf(db, "factory")).toEqual({
          consensus: [{ current_term: 1, voted_for: null, commit_index: 0, applied_index: 0 }],
          list: [{ position: 0, installation_id: EDITOR }],
          log: [],
        });
        db.exec(`UPDATE canvas_consensus SET current_term = 5, voted_for = '${EDITOR}' WHERE canvas_name = 'factory';
          INSERT INTO canvas_authorities (canvas_name, position, installation_id) VALUES ('factory', 1, '${SELF}');`);
        const held = consensusOf(db, "factory");
        yield* model.installCopy(copyOf("factory", "canvas-factory", 4));
        expect(consensusOf(db, "factory")).toEqual(held);
        expect(held.consensus).toEqual([{ current_term: 5, voted_for: EDITOR, commit_index: 0, applied_index: 0 }]);
      })));

  it("with the authority off, as in ship, writes neither", () =>
    machine(false, (model, db) =>
      Effect.gen(function* () {
        yield* model.installCopy(copyOf("factory", "canvas-factory", 3));
        expect(consensusOf(db, "factory")).toEqual({ consensus: [], list: [], log: [] });
      })));
});
