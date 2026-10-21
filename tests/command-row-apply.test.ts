/**
 * Who may write a ruling, on the apply path of real databases: a ruling, and
 * the operator's command, is the editing machine's own row. From any other
 * writer it is refused and nothing is written, whichever machine passes it on.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepository, WorkRepositoryLive, workRecordContentSha256 } from "../src/main/junto/work/repository";
import { ActorSeatId } from "../src/shared/actor-seat";
import { InstallationId } from "../src/shared/installation-id";
import type { CanvasPlacement, RowsFrame } from "../src/shared/work-exchange";
import { OpId } from "../src/shared/work-ids";
import { WORK_PROTOCOL } from "../src/shared/work-protocol";
import { TASKS_STATE_SCHEMA_SQL } from "../src/main/junto/work/task-state-schema";
import { artifactBodyRef } from "../src/main/junto/work/artifact-repository";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const OTHER = id("other-mini");
const at = "2026-10-21T12:00:00.000Z";
const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"2".repeat(64)}`);
const opId = Schema.decodeUnknownSync(OpId)("01M5ESR3G8AN1BA0AVVQC2X4WY");

const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => machine === EDITOR || machine === MINI || machine === OTHER,
  seatOf: (nodeId) => (nodeId === "peer" ? { seatId, machine: MINI } : undefined),
};

type Machine = {
  readonly root: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<WorkRepository | SqlClient.SqlClient, unknown>;
  readonly repository: Context.Service.Shape<typeof WorkRepository>;
};

const boot = async (self: InstallationId): Promise<Machine> => {
  const root = join(tmpdir(), `junto-command-row-${self}-${randomUUID()}`);
  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
  const repository = await runtime.runPromise(WorkRepository);
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${self}, ${at})`;
          yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${self}, ${at})`;
          yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes: [seat("peer", { y: 0 })] }]]) });
        }),
      );
    }),
  );
  return { root, runtime, repository };
};

/** A row by `writer` at `seq`, with a hash that matches its content. */
const row = <Body extends { readonly operation: string }>(writer: InstallationId, seq: string, item: object, body: Body) => {
  const semantic = {
    protocol: WORK_PROTOCOL,
    id: { route: { eventHome: writer, entityHome: writer }, seq },
    recordType: "fact",
    basis: { kind: "canvas", canvasName: "factory", seq: 1 },
    item,
    operation: body.operation,
    predecessor: null,
    body,
  };
  return { ...semantic, originAt: at, contentSha256: workRecordContentSha256(semantic as never) };
};

const ruling = (writer: InstallationId, seq: string) =>
  row(
    writer,
    seq,
    { kind: "ruling", itemId: opId, sink: { canvasName: "factory", nodeId: "board-1" } },
    {
      operation: "ruling.refused",
      writer: MINI,
      opId,
      actor: { kind: "seat", seatId, nodeId: "peer" },
      reason: "invalid_transition",
      root: opId,
    },
  );

const operatorCommand = (writer: InstallationId, seq: string) =>
  row(
    writer,
    seq,
    { kind: "command", itemId: opId, sink: { canvasName: "factory", nodeId: "board-1" } },
    {
      operation: "command.queued",
      command: {
        opId,
        canvasName: "factory",
        actor: { kind: "operator" },
        target: { kind: "task", nodeId: "board-1" },
        basis: null,
        after: [],
        op: { kind: "start" },
      },
    },
  );

const frame = (writer: InstallationId, facts: ReadonlyArray<unknown>, through: string): RowsFrame =>
  ({ kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer, facts, through }) as unknown as RowsFrame;

const apply = (on: Machine, peer: InstallationId, sent: RowsFrame) =>
  on.runtime.runPromiseExit(on.repository.applyExchangeRows({ peer, frame: sent, placement, receivedAt: at }));

/** Refused by the writer rule itself, not by any later check. */
const refusedAsNotTheEditor = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isFailure(exit) && Cause.pretty(exit.cause).includes("only the machine that edits a canvas writes this row");

const facts = (on: Machine) =>
  on.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return (yield* sql.unsafe<{ n: number }>("SELECT count(*) AS n FROM work_facts"))[0]!.n;
    }),
  );

let editor: Machine;
let mini: Machine;

beforeAll(async () => {
  editor = await boot(EDITOR);
  mini = await boot(MINI);
});

afterAll(async () => {
  for (const machine of [editor, mini]) {
    await machine.runtime.dispose();
    await rm(machine.root, { recursive: true, force: true });
  }
});

describe("who may write a ruling", () => {
  it("refuses a ruling a seat's machine wrote, sent to the editing machine", async () => {
    const before = await facts(editor);
    expect(refusedAsNotTheEditor(await apply(editor, MINI, frame(MINI, [ruling(MINI, "1")], "1")))).toBe(true);
    expect(await facts(editor)).toBe(before);
  });

  it("refuses an operator's command from any machine but the editing one", async () => {
    const before = await facts(editor);
    expect(refusedAsNotTheEditor(await apply(editor, MINI, frame(MINI, [operatorCommand(MINI, "2")], "2")))).toBe(true);
    expect(await facts(editor)).toBe(before);
  });

  it("refuses a ruling another machine wrote, even passed on by the editing machine", async () => {
    const before = await facts(mini);
    expect(refusedAsNotTheEditor(await apply(mini, EDITOR, frame(OTHER, [ruling(OTHER, "1")], "1")))).toBe(true);
    expect(await facts(mini)).toBe(before);
  });

  it("takes a ruling the editing machine wrote", async () => {
    const before = await facts(mini);
    const taken = await apply(mini, EDITOR, frame(EDITOR, [ruling(EDITOR, "1")], "1"));
    expect(Exit.isSuccess(taken) && taken.value.taken).toBe(1);
    expect(await facts(mini)).toBe(before + 1);
  });
});

describe("the seat's machine queues a command and reads what became of it", () => {
  const queuedOp = Schema.decodeUnknownSync(OpId)("01M5EWQ00000000000000000Q1");
  const command = {
    opId: queuedOp,
    canvasName: "factory",
    actor: { kind: "seat", seatId, nodeId: "peer" },
    target: { kind: "task", nodeId: "board-1" },
    basis: null,
    after: [],
    op: { kind: "start" },
  } as const;
  const queue = () =>
    mini.runtime.runPromiseExit(
      mini.repository.queueCommand({
        command: command as never,
        basis: { kind: "canvas", canvasName: "factory", seq: 1 } as never,
        originAt: at,
        receivedAt: at,
      }),
    );
  const state = () => mini.runtime.runPromise(mini.repository.commandState("factory", MINI, queuedOp));
  const load = () => mini.runtime.runPromise(mini.repository.commandQueueLoad("factory"));

  it("knows nothing of a command it never wrote", async () => {
    expect(await state()).toEqual({ kind: "unknown" });
  });

  it("writes the command as its own row, counted in the queue until it is ruled", async () => {
    const before = await load();
    const written = await queue();
    expect(Exit.isSuccess(written) && written.value.record.body.operation).toBe("command.queued");
    expect(await state()).toEqual({ kind: "queued" });
    const after = await load();
    expect(after.rows).toBe(before.rows + 1);
    expect(after.bytes).toBeGreaterThan(before.bytes);
  });

  it("reads the editing machine's refusal, in fixed words, and leaves the queue", async () => {
    const before = await load();
    const refusal = row(
      EDITOR,
      "2",
      { kind: "ruling", itemId: queuedOp, sink: { canvasName: "factory", nodeId: "board-1" } },
      { operation: "ruling.refused", writer: MINI, opId: queuedOp, actor: command.actor, reason: "invalid_transition", root: queuedOp },
    );
    const taken = await apply(mini, EDITOR, frame(EDITOR, [refusal], "2"));
    expect(Exit.isSuccess(taken)).toBe(true);
    const now = await state();
    expect(now.kind).toBe("refused");
    expect(now.kind === "refused" && now.error).toMatchObject({
      type: "InvalidTransition",
      details: { reason: "invalid_transition", opId: queuedOp },
    });
    expect((await load()).rows).toBe(before.rows - 1);
  });
});

describe("a machine that does not edit the canvas folds the editing machine's task rulings", () => {
  const foldOp = Schema.decodeUnknownSync(OpId)("01M5EX7000000000000000000F");
  const taskId = "01M5EX7000000000000000000T";
  const task = {
    state: "backlog",
    node: "board-1",
    epoch: 0,
    stampPolicy: { required: 0 },
    reviewers: [],
    stamps: [],
    id: taskId,
    number: 1,
    title: "ship it",
    dependsOn: [],
  };
  const applied = (seq: string, opId: string, facts: ReadonlyArray<unknown>) =>
    row(EDITOR, seq, { kind: "ruling", itemId: opId, sink: { canvasName: "factory", nodeId: "board-1" } }, {
      operation: "ruling.applied",
      writer: MINI,
      opId,
      actor: { kind: "seat", seatId, nodeId: "peer" },
      kind: "task",
      facts,
    });
  // The task tables are not in the state engine yet (c24d95a8e's converter is not wired); this replica holds them.
  beforeAll(() =>
    mini.runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.forEach(
          TASKS_STATE_SCHEMA_SQL.split(";").filter((statement) => statement.trim() !== ""),
          (statement) => sql.unsafe(statement),
          { discard: true },
        )),
    ));
  const heads = () =>
    mini.runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe<{ task_id: string; title: string; created_at: number }>(
          "SELECT task_id, title, created_at FROM task_heads WHERE canvas_name = 'factory'",
        )),
    );

  it("refuses facts it cannot decode and folds nothing", async () => {
    const before = await facts(mini);
    const bad = await apply(mini, EDITOR, frame(EDITOR, [applied("3", foldOp, [{ kind: "task", task: { ...task, state: "lost" }, effects: [] }])], "3"));
    expect(Exit.isFailure(bad)).toBe(true);
    expect(await heads()).toEqual([]);
    expect(await facts(mini)).toBe(before);
  });

  it("writes the task as the ruling made it, at the ruling's time", async () => {
    const before = await facts(mini);
    const facts1 = [{ kind: "task", task, effects: [{ kind: "number-minted", number: 1 }] }];
    const taken = await apply(mini, EDITOR, frame(EDITOR, [applied("3", foldOp, facts1)], "3"));
    expect(Exit.isSuccess(taken)).toBe(true);
    expect(await heads()).toEqual([{ task_id: taskId, title: "ship it", created_at: Date.parse(at) }]);
    expect(await facts(mini)).toBe(before + 1);
  });
});

describe("a machine that does not edit the canvas folds the editing machine's artifact rulings", () => {
  const foldOp = Schema.decodeUnknownSync(OpId)("01M5EX9000000000000000000F");
  const artifactId = "01M5EX9000000000000000000A";
  const created = (body?: object) => ({
    fact: "artifact.created",
    bodyRef: artifactBodyRef({ type: "document", markdown: "from afar" }),
    ...(body === undefined ? {} : { body }),
    artifact: {
      artifactId,
      nodeId: "board-1",
      type: "document",
      title: "Remote",
      version: 1,
      createdBy: { kind: "operator" },
      updatedAt: 1,
      archived: false,
      taskIds: [],
    },
  });
  const applied = (facts: ReadonlyArray<unknown>) =>
    row(EDITOR, "4", { kind: "ruling", itemId: foldOp, sink: { canvasName: "factory", nodeId: "board-1" } }, {
      operation: "ruling.applied",
      writer: MINI,
      opId: foldOp,
      actor: { kind: "operator" },
      kind: "artifact",
      facts,
    });
  const versions = () =>
    mini.runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe<{ pending: number }>(
          "SELECT inline_body_json IS NULL AS pending FROM artifact_versions WHERE canvas_name = 'factory' AND artifact_id = ?",
          [artifactId],
        )),
    );

  it("refuses facts it cannot decode and folds nothing", async () => {
    const bad = await apply(mini, EDITOR, frame(EDITOR, [applied([{ ...created(), fact: "artifact.lost" }])], "4"));
    expect(Exit.isFailure(bad)).toBe(true);
    expect(await versions()).toEqual([]);
  });

  it("folds a body that rode only by ref as pending", async () => {
    const taken = await apply(mini, EDITOR, frame(EDITOR, [applied([created()])], "4"));
    expect(Exit.isSuccess(taken)).toBe(true);
    expect(await versions()).toEqual([{ pending: 1 }]);
  });
});
