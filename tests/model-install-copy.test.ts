/**
 * A machine taking the copy of a canvas another machine edits: the copy
 * replaces what it holds when it is newer, nothing on it can be changed here,
 * and every follower of the canvas is told to read it again.
 */
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelService } from "../src/main/junto/model/service";
import { MODEL_STATE_SCHEMA_SQL } from "../src/main/junto/model/state-schema";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { installSqlCommitCallbacks } from "../src/main/junto/state/sql-commit";
import { Command, Node, asCanvasName, type CanvasesChanged } from "../src/shared/model";
import { seat as seatNode, wire } from "./support/model-nodes";

const SELF = "mini-installation";
const EDITOR = "macbook-installation";
const canvas = asCanvasName("factory");

const node = Schema.decodeUnknownSync(Node);
const own = (id: string, more: object = {}) =>
  node({ ...seatNode(id, { host: "mini" as never, agentKey: "mini:claude" }), ...more });
const peer = (id: string) =>
  node({ kind: "peer", id, x: 0, y: 0, width: 240, height: 100, z: 0, label: id, host: "macbook", seatId: `seat_${"a".repeat(64)}` });
const region = node({ kind: "region", id: "remote", x: -50, y: -50, width: 900, height: 600, z: 0, hold: false, label: "Remote" });

const copy = (seq: number, more: Partial<Parameters<ModelService["Service"]["installCopy"]>[0]> = {}) => ({
  canvas,
  canvasId: "canvas-factory",
  seq,
  editor: EDITOR,
  nodes: [region, own("peer"), peer("lead")],
  wires: [wire("lead-to-peer", "lead", "peer", "messages"), wire("peer-to-lead", "peer", "lead", "messages")],
  ...more,
});

const run = (
  test: (model: ModelService["Service"], db: DatabaseSync) => Effect.Effect<void, unknown>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(":memory:")),
          (opened) => Effect.sync(() => opened.close()),
        );
        db.exec(MODEL_STATE_SCHEMA_SQL);
        db.exec(`CREATE TABLE installation(singleton INTEGER PRIMARY KEY,installation_id TEXT);
          CREATE TABLE machine_configuration(singleton INTEGER PRIMARY KEY,machine_name TEXT);
          CREATE TABLE machine_peers(machine_name TEXT,installation_id TEXT,retired_at TEXT);
          INSERT INTO installation VALUES(1,'${SELF}');
          INSERT INTO machine_configuration VALUES(1,'mini');`);
        const sql = yield* makeSqliteClient(db);
        installSqlCommitCallbacks(sql);
        yield* Effect.gen(function* () {
          yield* test(yield* ModelService, db);
        }).pipe(
          Effect.provide(ModelService.layer),
          Effect.provide(ModelDependents.empty),
          Effect.provideService(SqlClient.SqlClient, sql),
        );
      }),
    ).pipe(Effect.provide(Reactivity.layer)),
  );

it("installs a copy of a canvas this machine did not have, with its count and its editing machine", () =>
  run((model, db) =>
    Effect.gen(function* () {
      expect(yield* model.installCopy(copy(7))).toEqual({ installed: true, seq: 7 });
      const opened = yield* model.open(canvas);
      expect(opened.seq).toBe(7);
      expect(opened.nodes.map((held) => `${held.kind} ${held.id}`).sort()).toEqual(["agent peer", "peer lead", "region remote"]);
      expect(opened.wires.map((held) => held.id).sort()).toEqual(["lead-to-peer", "peer-to-lead"]);
      expect(db.prepare("SELECT canvas_id, seq, editor_installation_id FROM canvases").all()).toEqual([
        { canvas_id: "canvas-factory", seq: 7, editor_installation_id: EDITOR },
      ]);
      expect(db.prepare("SELECT id, label, host FROM peers").all()).toEqual([{ id: "lead", label: "lead", host: "macbook" }]);
    }),
  ));

it("replaces the copy with a newer one whole, and leaves it alone for the same or an older one", () =>
  run((model, db) =>
    Effect.gen(function* () {
      yield* model.installCopy(copy(7));
      // At count 9 the peer is gone, with the wires that reached it, and a second seat is here.
      expect(
        yield* model.installCopy(copy(9, { nodes: [region, own("peer"), own("peer-two")], wires: [] })),
      ).toEqual({ installed: true, seq: 9 });
      const opened = yield* model.open(canvas);
      expect(opened.nodes.map((held) => held.id).sort()).toEqual(["peer", "peer-two", "remote"]);
      expect(opened.wires).toEqual([]);
      expect(db.prepare("SELECT count(*) AS n FROM peers").get()).toEqual({ n: 0 });

      expect(yield* model.installCopy(copy(9))).toEqual({ installed: false, seq: 9 });
      expect(yield* model.installCopy(copy(8))).toEqual({ installed: false, seq: 9 });
      expect((yield* model.open(canvas)).nodes.map((held) => held.id).sort()).toEqual(["peer", "peer-two", "remote"]);
    }),
  ));

it("tells every follower of the canvas to read it again", () =>
  run((model) =>
    Effect.gen(function* () {
      const told: CanvasesChanged[] = [];
      const off = model.subscribeCanvasesChanges((event) => told.push(event));
      yield* model.installCopy(copy(7));
      yield* model.installCopy(copy(7));
      yield* model.installCopy(copy(8));
      off();
      expect(told).toEqual([
        { _tag: "Replaced", canvas },
        { _tag: "Replaced", canvas },
      ]);
    }),
  ));

it("lets nothing on a copy be changed here", () =>
  run((model) =>
    Effect.gen(function* () {
      yield* model.installCopy(copy(7));
      const refused = yield* Effect.flip(
        model.command(Schema.decodeUnknownSync(Command)({ _tag: "Remove", canvas, nodes: ["peer"], wires: [] }), "operator"),
      );
      expect(String((refused as { rule?: string }).rule ?? refused)).toContain("edited on another machine");
      expect((yield* model.open(canvas)).seq).toBe(7);
    }),
  ));

it("replaces this machine's own canvas of that name when it never changed, id and editing machine included", () =>
  run((model, db) =>
    Effect.gen(function* () {
      // Every machine that ever opened a window has an empty canvas under the default name.
      yield* model.command(Schema.decodeUnknownSync(Command)({ _tag: "CreateCanvas", canvas }), "operator");
      const own = db.prepare("SELECT canvas_id, seq FROM canvases").get()!;
      expect(own.seq).toBe(0);
      expect(own.canvas_id).not.toBe("canvas-factory");

      expect(yield* model.installCopy(copy(7))).toEqual({ installed: true, seq: 7 });
      expect(db.prepare("SELECT canvas_id, seq, editor_installation_id FROM canvases").all()).toEqual([
        { canvas_id: "canvas-factory", seq: 7, editor_installation_id: EDITOR },
      ]);
      expect((yield* model.open(canvas)).nodes.map((held) => held.id).sort()).toEqual(["lead", "peer", "remote"]);
      // It is a copy now: nothing on it changes here.
      const refused = yield* Effect.flip(
        model.command(Schema.decodeUnknownSync(Command)({ _tag: "Remove", canvas, nodes: ["peer"], wires: [] }), "operator"),
      );
      expect(String((refused as { rule?: string }).rule ?? refused)).toContain("edited on another machine");
    }),
  ));

it("keeps this machine's own canvas of that name once it changed, and says so", () =>
  run((model, db) =>
    Effect.gen(function* () {
      yield* model.command(Schema.decodeUnknownSync(Command)({ _tag: "CreateCanvas", canvas }), "operator");
      yield* model.command(
        Schema.decodeUnknownSync(Command)({ _tag: "Add", canvas, nodes: [{ kind: "note", id: "mine", x: 0, y: 0, width: 100, height: 60, z: 0, text: "kept" }], wires: [] }),
        "operator",
      );
      const before = db.prepare("SELECT canvas_id, seq, editor_installation_id FROM canvases").all();
      const told: CanvasesChanged[] = [];
      const off = model.subscribeCanvasesChanges((event) => told.push(event));

      expect(yield* model.installCopy(copy(7))).toEqual({ installed: false, refused: "a-canvas-of-that-name" });
      off();
      expect(db.prepare("SELECT canvas_id, seq, editor_installation_id FROM canvases").all()).toEqual(before);
      expect((yield* model.open(canvas)).nodes.map((held) => held.id)).toEqual(["mine"]);
      expect(told).toEqual([]);
    }),
  ));

it("keeps the copy it holds when another machine sends a different canvas of that name, and says so", () =>
  run((model) =>
    Effect.gen(function* () {
      yield* model.installCopy(copy(7));
      expect(
        yield* model.installCopy(copy(9, { canvasId: "another-canvas-factory", editor: "another-installation" })),
      ).toEqual({ installed: false, refused: "a-canvas-of-that-name" });
      expect((yield* model.open(canvas)).seq).toBe(7);
    }),
  ));

it("refuses a copy this machine would edit, and a copy that names another editing machine for the canvas it holds", () =>
  run((model) =>
    Effect.gen(function* () {
      const own = yield* Effect.flip(model.installCopy(copy(3, { editor: SELF })));
      expect(JSON.stringify(own)).toContain("holds no copy of a canvas it edits");

      yield* model.installCopy(copy(7));
      const other = yield* Effect.flip(model.installCopy(copy(8, { editor: "another-installation" })));
      expect(JSON.stringify(other)).toContain("does not change which machine edits");
      expect((yield* model.open(canvas)).seq).toBe(7);
    }),
  ));
