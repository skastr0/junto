/**
 * The one record of a ruling, on a real database: its `resource_rulings` row
 * and its `ruling.*` fact commit with the domain's facts in the caller's
 * transaction, or none of them does, and only the editing machine records.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepositoryLive, type RecordRulingInput } from "../src/main/junto/work/repository";
import { RulingRecorder, RulingRecorderLive } from "../src/main/junto/work/ruling-recorder";
import { ActorSeatId } from "../src/shared/actor-seat";
import { InstallationId } from "../src/shared/installation-id";
import { OpId } from "../src/shared/work-ids";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat, taskBoard } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const SELF = id("macbook");
const MINI = id("mini");
const at = "2026-10-21T12:00:00.000Z";
const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"2".repeat(64)}`);
const op = Schema.decodeUnknownSync(OpId);

const input = (opId: OpId, kind: "applied" | "refused"): RecordRulingInput => ({
  canvasName: "factory",
  writer: MINI,
  command: { opId, actor: { kind: "seat", seatId, nodeId: "s1" as never }, target: { kind: "task", nodeId: "board-1" as never } },
  kind: "task",
  record: kind === "applied" ? { kind: "applied", taskId: "t1" } : { kind: "refused", error: { type: "InputError", message: "no", details: { reason: "stale" } }, root: opId },
  ruling: kind === "applied"
    ? { kind: "applied", opId, facts: [{ fact: "task.created" }] }
    : { kind: "refused", opId, root: opId, error: { type: "InputError", message: "no", details: { reason: "stale" } } },
  at,
});

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<RulingRecorder | SqlClient.SqlClient, unknown>;

const run = <A, E>(effect: Effect.Effect<A, E, RulingRecorder | SqlClient.SqlClient>) => runtime.runPromiseExit(effect);

const counts = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const n = (query: string) => Effect.map(sql.unsafe<{ n: number }>(query), (rows) => rows[0]!.n);
      return {
        rulings: yield* n("SELECT count(*) AS n FROM resource_rulings"),
        rows: yield* n("SELECT count(*) AS n FROM work_facts WHERE json_extract(result_json, '$.operation') LIKE 'ruling.%'"),
        domain: yield* n("SELECT count(*) AS n FROM domain_facts"),
      };
    }),
  );

const setEditor = (editor: InstallationId) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE canvases SET editor_installation_id = ${editor} WHERE canvas_name = 'factory'`),
  );

/** A domain's submit: its facts, then the ruling, in one transaction. */
const submit = (ruling: RecordRulingInput, after: Effect.Effect<void, string> = Effect.void) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const recorder = yield* RulingRecorder;
        yield* sql`INSERT INTO domain_facts (op_id) VALUES (${ruling.command.opId})`;
        yield* recorder.record(ruling);
        yield* after;
      }),
    ));

beforeAll(async () => {
  root = join(tmpdir(), `junto-ruling-recorder-${randomUUID()}`);
  runtime = ManagedRuntime.make(
    Layer.provideMerge(Layer.provideMerge(RulingRecorderLive, WorkRepositoryLive), makeStateEngineLive(join(root, "junto.db"))),
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${SELF}, ${at})`;
          yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${SELF}, ${at})`;
          yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes: [seat("s1", { y: 0 }), taskBoard("board-1")] }]]) });
          yield* sql`CREATE TABLE domain_facts (op_id TEXT NOT NULL)`;
        }),
      );
    }),
  );
  await setEditor(SELF);
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("recording a ruling", () => {
  it("commits the ruling, its row and the domain's facts together", async () => {
    const before = await counts();
    expect(Exit.isSuccess(await run(submit(input(op("01M5EX0000000000000000000A"), "applied"))))).toBe(true);
    expect(Exit.isSuccess(await run(submit(input(op("01M5EX0000000000000000000B"), "refused"))))).toBe(true);
    expect(await counts()).toEqual({ rulings: before.rulings + 2, rows: before.rows + 2, domain: before.domain + 2 });
  });

  it("writes none of them when the transaction fails after the ruling", async () => {
    const before = await counts();
    const exit = await run(submit(input(op("01M5EX0000000000000000000C"), "applied"), Effect.fail("boom")));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await counts()).toEqual(before);
  });

  it("refuses on a machine that does not edit the canvas, and writes nothing", async () => {
    await setEditor(MINI);
    try {
      const before = await counts();
      const exit = await run(submit(input(op("01M5EX0000000000000000000D"), "applied")));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(await counts()).toEqual(before);
    } finally {
      await setEditor(SELF);
    }
  });
});
