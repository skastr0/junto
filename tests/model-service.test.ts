import { DatabaseSync } from "node:sqlite";
import { Effect, Fiber, Schema, Stream } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { Changed, Command, type SheetChanged } from "../src/shared/model";
import { nodeFromRow } from "../src/main/junto/model/rows";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelService } from "../src/main/junto/model/service";
import { MODEL_STATE_SCHEMA_SQL } from "../src/main/junto/model/state-schema";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { installSqlCommitCallbacks } from "../src/main/junto/state/sql-commit";

const at = "2026-10-07T00:00:00Z";
const node = (id: string, kind = "note", fields: object = {}) => ({
  id,
  kind,
  x: 0,
  y: 0,
  width: 200,
  height: 90,
  z: 0,
  ...(kind === "note" ? { text: id } : {}),
  ...fields,
});
const seat = node("seat", "agent", {
  agentKey: "local:seat",
  label: "Seat",
  host: "local",
  overseer: false,
  bindingId: "binding",
  harness: "codex",
  onRemove: "detach",
});
const decode = Schema.decodeUnknownSync(Command);
const run = (
  test: (
    model: ModelService["Service"],
    sql: SqlClient.SqlClient,
    db: DatabaseSync,
  ) => Effect.Effect<void, unknown>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(":memory:")),
          (db) => Effect.sync(() => db.close()),
        );
        db.exec(MODEL_STATE_SCHEMA_SQL);
        db.exec(`CREATE TABLE station_installation(singleton INTEGER PRIMARY KEY,installation_id TEXT);
          CREATE TABLE station_configuration(singleton INTEGER PRIMARY KEY,role TEXT,host_id TEXT);
          CREATE TABLE station_fleet_targets(host_id TEXT,retired_at TEXT);
          INSERT INTO station_installation VALUES(1,'local-installation');
          INSERT INTO station_configuration VALUES(1,'command-center','local');`);
        db.prepare(
          "INSERT INTO canvases(canvas_name,canvas_id,created_at,updated_at) VALUES ('factory','c',?,?)",
        ).run(at, at);
        const sql = yield* makeSqliteClient(db);
        installSqlCommitCallbacks(sql);
        yield* Effect.gen(function* () {
          const model = yield* ModelService;
          yield* test(model, sql, db);
        }).pipe(
          Effect.provide(ModelService.layer),
          Effect.provide(ModelDependents.empty),
          Effect.provideService(SqlClient.SqlClient, sql),
        );
      }),
    ).pipe(Effect.provide(Reactivity.layer)),
  );

it("changes only addressed rows and publishes one event after commit, including its sender", () =>
  run((model, _sql, db) =>
    Effect.gen(function* () {
      const seen: Changed[] = [];
      const subscriber = yield* model.changes.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            expect(db.isTransaction).toBe(false);
            seen.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      expect(
        yield* model.command(
          decode({
            _tag: "Add",
            canvas: "factory",
            nodes: [node("a"), node("b")],
            wires: [],
          }),
          "operator",
        ),
      ).toEqual({ seq: 1 });
      yield* Effect.yieldNow;
      const unchanged = db.prepare("SELECT * FROM notes WHERE id='b'").get();
      const reply = yield* model.command(
        decode({
          _tag: "Edit",
          canvas: "factory",
          id: "a",
          change: { kind: "note", text: "changed" },
        }),
        "operator",
      );
      yield* Effect.yieldNow;
      expect(reply.seq).toBe(2);
      expect(seen.map((event) => event.seq)).toEqual([1, 2]);
      expect(seen[1]!.nodes.map((node) => node.id)).toEqual(["a"]);
      expect(db.prepare("SELECT * FROM notes WHERE id='b'").get()).toEqual(
        unchanged,
      );
      const opened = yield* model.open("factory");
      expect(opened.seq).toBe(2);
      expect(opened.nodes.find((node) => node.id === "a")).toMatchObject({
        kind: "note",
        text: "changed",
      });
      expect("messages" in opened).toBe(false);
      yield* Fiber.interrupt(subscriber);
    }),
  ));

it("emits nothing and keeps seq and rows intact after a failed command or outer rollback", () =>
  run((model, sql) =>
    Effect.gen(function* () {
      const seen: Changed[] = [];
      const subscriber = yield* model.changes.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            seen.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const failed = yield* model
        .command(
          decode({
            _tag: "Add",
            canvas: "factory",
            nodes: [node("a"), node("a")],
            wires: [],
          }),
          "operator",
        )
        .pipe(Effect.result);
      expect(failed._tag).toBe("Failure");
      expect((yield* model.open("factory")).nodes).toEqual([]);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* model.command(
              decode({
                _tag: "Add",
                canvas: "factory",
                nodes: [node("b")],
                wires: [],
              }),
              "operator",
            );
            expect(seen).toEqual([]);
            return yield* Effect.fail("outer rollback");
          }),
        )
        .pipe(Effect.result);
      yield* Effect.yieldNow;
      expect(seen).toEqual([]);
      expect(yield* model.open("factory")).toMatchObject({
        seq: 0,
        nodes: [],
        wires: [],
      });
      yield* Fiber.interrupt(subscriber);
    }),
  ));

it("validates wire grammar, forbids cycles, and removes incident wires atomically", () =>
  run((model) =>
    Effect.gen(function* () {
      yield* model.command(
        decode({
          _tag: "Add",
          canvas: "factory",
          nodes: [seat, node("t1", "task"), node("t2", "task")],
          wires: [
            { id: "w", from: "seat", to: "t1", verb: "contributes" },
            { id: "flow", from: "t1", to: "t2", verb: "feeds" },
          ],
        }),
        "operator",
      );
      expect(
        (yield* model
          .command(
            decode({
              _tag: "Add",
              canvas: "factory",
              nodes: [],
              wires: [{ id: "cycle", from: "t2", to: "t1", verb: "feeds" }],
            }),
            "operator",
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* model
          .command(
            decode({
              _tag: "Rewire",
              canvas: "factory",
              id: "w",
              change: { verb: "navigates" },
            }),
            "operator",
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* model.command(
        decode({ _tag: "Remove", canvas: "factory", nodes: ["t1"], wires: [] }),
        "operator",
      );
      expect((yield* model.open("factory")).wires).toEqual([]);
    }),
  ));

it("keeps a sheet grid off Opened and placement events and admits seat authority by source", () =>
  run((model) =>
    Effect.gen(function* () {
      const sheets: SheetChanged[] = [];
      const subscriber = yield* model.sheetChanges.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            sheets.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* model.command(
        decode({
          _tag: "Add",
          canvas: "factory",
          nodes: [seat, node("sheet", "sheet")],
          wires: [],
        }),
        "operator",
      );
      const grid = {
        columns: [{ id: "c", name: "Value" }],
        rows: [{ id: "r", cells: { c: "123" } }],
      };
      yield* model.command(
        decode({ _tag: "WriteSheet", canvas: "factory", id: "sheet", grid }),
        "operator",
      );
      yield* Effect.yieldNow;
      expect(sheets).toEqual([{ canvas: "factory", id: "sheet" }]);
      expect(yield* model.readSheet("factory", "sheet")).toEqual(grid);
      expect(
        (yield* model.open("factory")).nodes.find(
          (node) => node.kind === "sheet",
        ),
      ).not.toHaveProperty("rows");
      yield* model.command(
        decode({
          _tag: "Move",
          canvas: "factory",
          moves: [
            { id: "sheet", x: 10, y: 20, size: { width: 300, height: 100 } },
          ],
        }),
        "operator",
      );
      expect(yield* model.readSheet("factory", "sheet")).toEqual(grid);
      expect(
        (yield* model
          .command(
            decode({
              _tag: "GrantOverseer",
              canvas: "factory",
              id: "seat",
              overseer: true,
            }),
            "overseer",
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* model.command(
        decode({
          _tag: "GrantOverseer",
          canvas: "factory",
          id: "seat",
          overseer: true,
        }),
        "operator",
      );
      expect(
        (yield* model
          .command(
            decode({
              _tag: "RecordSession",
              canvas: "factory",
              id: "seat",
              sessionId: "known",
            }),
            "operator",
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* model.command(
        decode({
          _tag: "RecordSession",
          canvas: "factory",
          id: "seat",
          sessionId: "known",
        }),
        "runtime",
      );
      expect(
        (yield* model.open("factory")).nodes.find(
          (node) => node.kind === "agent",
        ),
      ).toMatchObject({ overseer: true, sessionId: "known" });
      yield* Fiber.interrupt(subscriber);
    }),
  ));

it("keeps transaction drafts private, discards failed savepoints, and reads held canvases without SQL", () =>
  run((model, sql, db) =>
    Effect.gen(function* () {
      yield* model.open("factory");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* model.command(
            decode({
              _tag: "Add",
              canvas: "factory",
              nodes: [node("a")],
              wires: [],
            }),
            "operator",
          );
          expect((yield* model.open("factory")).seq).toBe(1);
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* model.command(
                  decode({
                    _tag: "Add",
                    canvas: "factory",
                    nodes: [node("bad")],
                    wires: [],
                  }),
                  "operator",
                );
                return yield* Effect.fail("discard savepoint");
              }),
            )
            .pipe(Effect.result);
          expect(
            (yield* model.open("factory")).nodes.map((value) => value.id),
          ).toEqual(["a"]);
          yield* model.command(
            decode({
              _tag: "Edit",
              canvas: "factory",
              id: "a",
              change: { kind: "note", text: "kept" },
            }),
            "operator",
          );
        }),
      );
      expect((yield* model.open("factory")).seq).toBe(2);
      db.setAuthorizer((action) => (action === 20 ? 1 : 0)); // SQLITE_READ denied.
      try {
        expect((yield* model.canvas("factory")).nodes.size).toBe(1);
        expect((yield* model.open("factory")).nodes[0]).toMatchObject({
          text: "kept",
        });
      } finally {
        db.setAuthorizer(null);
      }
    }),
  ));

it("refuses protected-seat edits, runtime commands, duplicate bindings and duplicate relationships", () =>
  run((model) =>
    Effect.gen(function* () {
      const protectedSeat = { ...seat, overseer: true, sessionId: "restored" };
      yield* model.command(
        decode({
          _tag: "Add",
          canvas: "factory",
          nodes: [protectedSeat, node("task", "task")],
          wires: [{ id: "w", from: "seat", to: "task", verb: "contributes" }],
        }),
        "operator",
      );
      const failures: Array<[unknown, "operator" | "runtime" | "overseer"]> = [
        [{ _tag: "Move", moves: [{ id: "seat", x: 1, y: 1 }] }, "runtime"],
        [
          {
            _tag: "Edit",
            id: "seat",
            change: { kind: "agent", host: "other" },
          },
          "overseer",
        ],
        [{ _tag: "Remove", nodes: ["seat"], wires: [] }, "overseer"],
        [
          {
            _tag: "Add",
            nodes: [
              node("terminal", "terminal", {
                host: "local",
                bindingId: "binding",
                onRemove: "detach",
              }),
            ],
            wires: [],
          },
          "operator",
        ],
        [
          {
            _tag: "Add",
            nodes: [],
            wires: [
              {
                id: "duplicate",
                from: "seat",
                to: "task",
                verb: "contributes",
              },
            ],
          },
          "operator",
        ],
      ];
      for (const [input, source] of failures) {
        const result = yield* model
          .command(decode({ ...(input as object), canvas: "factory" }), source)
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
      expect((yield* model.open("factory")).seq).toBe(1);
      yield* model.command(
        decode({
          _tag: "RecordSession",
          canvas: "factory",
          id: "seat",
          sessionId: "next",
        }),
        "runtime",
      );
      expect((yield* model.open("factory")).seq).toBe(2);
    }),
  ));

it("skips unchanged edits and restacks only the selected nodes with sparse negative z", () =>
  run((model, _sql, db) =>
    Effect.gen(function* () {
      yield* model.command(
        decode({
          _tag: "Add",
          canvas: "factory",
          nodes: [node("a"), node("b"), node("c")],
          wires: [],
        }),
        "operator",
      );
      const untouched = db.prepare("SELECT * FROM notes WHERE id='b'").get();
      expect(
        yield* model.command(
          decode({
            _tag: "Edit",
            canvas: "factory",
            id: "a",
            change: { kind: "note", text: "a" },
          }),
          "operator",
        ),
      ).toEqual({ seq: 1 });
      yield* model.command(
        decode({
          _tag: "Restack",
          canvas: "factory",
          nodes: ["a"],
          to: "back",
        }),
        "operator",
      );
      expect(
        db.prepare("SELECT z_index FROM notes WHERE id='a'").get()!.z_index,
      ).toBe(-1);
      expect(db.prepare("SELECT * FROM notes WHERE id='b'").get()).toEqual(
        untouched,
      );
    }),
  ));


it("revokes only the addressed binding when overseer seats share an agent key", () =>
  run((model, _sql, db) => Effect.gen(function* () {
    const first = { ...seat, agentKey: "local:claude", harness: "claude", overseer: true };
    const second = { ...first, id: "paused-overseer", bindingId: "other-binding" };
    yield* model.command(decode({ _tag: "Add", canvas: "factory", nodes: [first, second], wires: [] }), "operator");
    const events: Changed[] = [];
    const stop = model.subscribeChanges((event) => events.push(event));
    yield* model.command(decode({ _tag: "GrantOverseer", canvas: "factory", id: "seat", overseer: false }), "operator");
    expect((yield* model.open("factory")).nodes.find(({ id }) => id === second.id)).toMatchObject({
      agentKey: "local:claude", bindingId: "other-binding", overseer: true,
    });
    expect(db.prepare("SELECT id,overseer FROM seats ORDER BY id").all()).toEqual([
      { id: "paused-overseer", overseer: 1 }, { id: "seat", overseer: 0 },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.nodes.map(({ id }) => id)).toEqual(["seat"]);
    expect(events[0]?.removedNodes).toEqual([]);
    stop();
  })),
);

it("grants every alias atomically and publishes one committed event per affected canvas", () =>
  run((model, sql, db) => Effect.gen(function* () {
    yield* model.command(decode({ _tag: "CreateCanvas", canvas: "alias" }), "operator");
    yield* model.command(decode({ _tag: "Add", canvas: "factory", nodes: [seat], wires: [] }), "operator");
    yield* model.command(decode({ _tag: "Add", canvas: "alias", nodes: [{ ...seat, id: "alias-seat" }], wires: [] }), "operator");
    const events: Changed[] = [];
    const stop = model.subscribeChanges((event) => {
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("SELECT overseer FROM seats").all()).toEqual([{ overseer: 1 }, { overseer: 1 }]);
      events.push(event);
    });
    const grant = decode({ _tag: "GrantOverseer", canvas: "factory", id: "seat", overseer: true });
    const aborted = yield* sql.withTransaction(Effect.gen(function* () {
      yield* model.command(grant, "operator");
      expect(events).toEqual([]);
      return yield* Effect.fail("rollback");
    })).pipe(Effect.result);
    expect(aborted._tag).toBe("Failure");
    expect(db.prepare("SELECT overseer FROM seats").all()).toEqual([{ overseer: 0 }, { overseer: 0 }]);
    expect(events).toEqual([]);
    yield* model.command(grant, "operator");
    expect(events.map(({ canvas, seq, nodes }) => [canvas, seq, nodes.length])).toEqual([["alias", 2, 1], ["factory", 2, 1]]);
    yield* model.command(grant, "operator");
    expect(events).toHaveLength(2);
    stop();
  })),
);


it("keeps empty region settings identical in events, held reads and persisted reads", () =>
  run((model, _sql, db) => Effect.gen(function* () {
    yield* model.command(decode({ _tag: "Add", canvas: "factory", nodes: [node("region", "region", { hold: false, defaults: { page: {} }, contract: {} })], wires: [] }), "operator");
    const stored = db.prepare("SELECT * FROM regions WHERE id='region'").get()!;
    const current = (yield* model.open("factory")).nodes[0];
    expect(current).not.toHaveProperty("defaults");
    expect(current).not.toHaveProperty("contract");
    expect(nodeFromRow("region", stored)).toEqual(current);
    const before = (yield* model.open("factory")).seq;
    yield* model.command(decode({ _tag: "Edit", canvas: "factory", id: "region", change: { kind: "region", defaults: {}, contract: {} } }), "operator");
    expect((yield* model.open("factory")).seq).toBe(before);
  })),
);


it("restores a node's exact z through Move", () => run((model) => Effect.gen(function* () {
  yield* model.command(decode({ _tag: "Add", canvas: "factory", nodes: [node("a", "note", { z: -20 })], wires: [] }), "operator");
  yield* model.command(decode({ _tag: "Restack", canvas: "factory", nodes: ["a"], to: "front" }), "operator");
  yield* model.command(decode({ _tag: "Move", canvas: "factory", moves: [{ id: "a", x: 0, y: 0, z: -20 }] }), "operator");
  expect((yield* model.open("factory")).nodes[0].z).toBe(-20);
})));

it("reseats a node without changing its wires and clears its old session and launch", () => run((model, _sql, db) => Effect.gen(function* () {
  yield* model.command(decode({ _tag: "Add", canvas: "factory", nodes: [seat, { ...seat, id: "peer", bindingId: "peer-binding" }], wires: [{ id: "mail", from: "seat", to: "peer", verb: "messages" }] }), "operator");
  yield* model.command(decode({ _tag: "RecordSession", canvas: "factory", id: "seat", sessionId: "old-session" }), "runtime");
  const wires = (yield* model.open("factory")).wires;
  const reseat = { _tag: "Reseat", canvas: "factory", id: "seat", agentKey: "local:new-agent", bindingId: "new-binding", harness: "claude", host: "local" };
  yield* model.command(decode(reseat), "operator");
  const changed = (yield* model.open("factory")).nodes.find(({ id }) => id === "seat");
  expect(changed).toMatchObject({ id: "seat", agentKey: "local:new-agent", bindingId: "new-binding", harness: "claude" });
  expect(changed).not.toHaveProperty("sessionId");
  expect(changed).not.toHaveProperty("launch");
  expect((yield* model.open("factory")).wires).toEqual(wires);
  expect(db.prepare("SELECT session_id FROM seats WHERE id='seat'").get()!.session_id).toBeNull();
  expect((yield* model.command(decode({ ...reseat, bindingId: "peer-binding" }), "operator").pipe(Effect.result))._tag).toBe("Failure");
  yield* model.command(decode({ _tag: "GrantOverseer", canvas: "factory", id: "seat", overseer: true }), "operator");
  expect((yield* model.command(decode({ ...reseat, bindingId: "third-binding" }), "overseer").pipe(Effect.result))._tag).toBe("Failure");
  yield* model.command(decode({ ...reseat, bindingId: "third-binding" }), "operator");
  expect((yield* model.open("factory")).nodes.find(({ id }) => id === "seat")).toMatchObject({ overseer: false });
})));

it("applies a batch once, emits only its final rows and rolls back every failed step", () => run((model, sql, db) => Effect.gen(function* () {
  const events: Changed[] = [];
  const sheets: SheetChanged[] = [];
  const stop = model.subscribeChanges((event) => events.push(event));
  const stopSheets = model.subscribeSheetChanges((event) => sheets.push(event));
  const add = { _tag: "Add", canvas: "factory", nodes: [node("a"), node("grid", "sheet")], wires: [] };
  const move = { _tag: "Move", canvas: "factory", moves: [{ id: "a", x: 100, y: 20, z: 99 }] };
  const edit = { _tag: "Edit", canvas: "factory", id: "a", change: { kind: "note", text: "after" } };
  const grid = { columns: [{ id: "c", name: "V" }], rows: [{ id: "r", cells: { c: "value" } }] };
  const write = { _tag: "WriteSheet", canvas: "factory", id: "grid", grid };
  const batch = decode({ _tag: "Batch", canvas: "factory", steps: [add, move, edit, write] });
  expect(yield* model.command(batch, "operator")).toEqual({ seq: 1 });
  expect(events).toHaveLength(1);
  expect(events[0].nodes).toHaveLength(2);
  expect(events[0].nodes.find(({ id }) => id === "a")).toMatchObject({ x: 100, text: "after", z: 99 });
  expect(sheets).toEqual([{ canvas: "factory", id: "grid" }]);
  expect(yield* model.readSheet("factory", "grid")).toEqual(grid);
  const before = db.prepare("SELECT * FROM notes").all();
  const bad = decode({ _tag: "Batch", canvas: "factory", steps: [{ ...edit, change: { kind: "note", text: "must roll back" } }, { ...edit, id: "missing" }] });
  expect((yield* model.command(bad, "operator").pipe(Effect.result))._tag).toBe("Failure");
  expect(db.prepare("SELECT * FROM notes").all()).toEqual(before);
  expect(events).toHaveLength(1);
  expect((yield* model.command(decode({ _tag: "Batch", canvas: "factory", steps: [{ ...edit, canvas: "elsewhere" }] }), "operator").pipe(Effect.result))._tag).toBe("Failure");
  expect((yield* sql.withTransaction(Effect.gen(function* () {
    yield* model.command(decode({ _tag: "Batch", canvas: "factory", steps: [{ ...edit, change: { kind: "note", text: "outer rollback" } }] }), "operator");
    expect(events).toHaveLength(1);
    return yield* Effect.fail("abort");
  })).pipe(Effect.result))._tag).toBe("Failure");
  expect(db.prepare("SELECT * FROM notes").all()).toEqual(before);
  expect(events).toHaveLength(1);
  stop(); stopSheets();
})));

it("refuses authority and canvas operations inside batches and keeps cancelling steps inert", () => run((model, _sql, db) => Effect.gen(function* () {
  for (const step of [
    { _tag: "GrantOverseer", canvas: "factory", id: "seat", overseer: true },
    { _tag: "RecordSession", canvas: "factory", id: "seat", sessionId: "s" },
    { _tag: "CreateCanvas", canvas: "factory" },
    { _tag: "Batch", canvas: "factory", steps: [] },
  ]) expect(() => decode({ _tag: "Batch", canvas: "factory", steps: [step] })).toThrow();
  const writes: string[] = [];
  db.setAuthorizer((action, arg1) => { if ([18, 9, 23].includes(action)) writes.push(String(arg1)); return 0; });
  try {
    const reply = yield* model.command(decode({ _tag: "Batch", canvas: "factory", steps: [
      { _tag: "Add", canvas: "factory", nodes: [node("temporary")], wires: [] },
      { _tag: "Remove", canvas: "factory", nodes: ["temporary"], wires: [] },
    ] }), "operator");
    expect(reply).toEqual({ seq: 0 });
    expect(writes).toEqual([]);
  } finally { db.setAuthorizer(null); }
})));


it("reseating revokes authority on every alias atomically and a refused batch retains the grant", () => run((model, sql, db) => Effect.gen(function* () {
  yield* model.command(decode({ _tag: "CreateCanvas", canvas: "alias" }), "operator");
  yield* model.command(decode({ _tag: "Add", canvas: "factory", nodes: [seat], wires: [] }), "operator");
  yield* model.command(decode({ _tag: "Add", canvas: "alias", nodes: [{ ...seat, id: "alias-seat" }], wires: [] }), "operator");
  yield* model.command(decode({ _tag: "GrantOverseer", canvas: "factory", id: "seat", overseer: true }), "operator");
  const events: Changed[] = [];
  const grantedAtEvent: unknown[] = [];
  const stop = model.subscribeChanges((event) => {
    events.push(event);
    grantedAtEvent.push(db.prepare("SELECT count(*) AS count FROM seats WHERE overseer=1").get()!.count);
  });
  const reseat = { _tag: "Reseat", canvas: "factory", id: "seat", agentKey: "local:replacement", bindingId: "replacement-binding", harness: "claude", host: "local" };
  const refused = yield* model.command(decode({ _tag: "Batch", canvas: "factory", steps: [reseat, { _tag: "Move", canvas: "factory", moves: [{ id: "missing", x: 0, y: 0 }] }] }), "operator").pipe(Effect.result);
  expect(refused._tag).toBe("Failure");
  expect(events).toHaveLength(0);
  expect(db.prepare("SELECT count(*) AS count FROM seats WHERE overseer=1").get()!.count).toBe(2);
  const rollback = yield* sql.withTransaction(model.command(decode(reseat), "operator").pipe(
    Effect.flatMap(() => Effect.fail("rollback")),
  )).pipe(Effect.result);
  expect(rollback._tag).toBe("Failure");
  expect(events).toHaveLength(0);
  expect((yield* model.open("alias")).nodes[0]).toMatchObject({ overseer: true });
  expect((yield* model.open("factory")).nodes[0]).toMatchObject({ overseer: true });
  yield* model.command(decode(reseat), "operator");
  expect(grantedAtEvent).toEqual([0, 0]);
  expect(events.map((event) => [event.canvas, event.nodes.length])).toEqual([["alias", 1], ["factory", 1]]);
  expect((yield* model.open("alias")).nodes[0]).toMatchObject({ bindingId: "binding", overseer: false });
  expect((yield* model.open("factory")).nodes[0]).toMatchObject({ bindingId: "replacement-binding", overseer: false });
  stop();
})));
