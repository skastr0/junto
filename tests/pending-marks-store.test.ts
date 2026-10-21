/**
 * The marks `task list|show` and `artifact list|show` carry, on a real state
 * database (review of f9f1ec794): a write queued on a machine that does not
 * edit the canvas marks its item until its ruling is folded here, and the
 * machine that edits the canvas, which rules at once and queues nothing,
 * marks nothing.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { OpRepository, OpRepositoryLive } from "../src/main/junto/work/op-repository";
import { pendingMarksOf } from "../src/main/junto/work/op-control";
import { WorkRepository, WorkRepositoryLive, workRecordContentSha256 } from "../src/main/junto/work/repository";
import { makeResourceSubmitLayer, ResourceSubmit } from "../src/main/junto/work/resource-submit";
import { liveTaskPorts } from "../src/main/junto/work/task-control";
import { TaskRepository } from "../src/main/junto/work/task-repository";
import { ActorSeatId } from "../src/shared/actor-seat";
import { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/physics/schema";
import { mintItemId, type ResourceActor, type ResourceCommand } from "../src/shared/resource-command";
import type { TaskCommand } from "../src/shared/task-model";
import type { CanvasPlacement, RowsFrame } from "../src/shared/work-exchange";
import { OpId, type ItemId } from "../src/shared/work-ids";
import { WORK_PROTOCOL } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { canvasOf, seat, taskBoard } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const at = "2026-10-21T12:00:00.000Z";
const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"2".repeat(64)}`);
const op = Schema.decodeUnknownSync(OpId);
const peer: ResourceActor = { kind: "seat", seatId, nodeId: asNodeId("peer") };
const canvas = canvasOf([seat("peer", { y: 0 }), taskBoard("board-1", { y: 200 })]);
const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => machine === EDITOR || machine === MINI,
  seatOf: (nodeId) => (nodeId === "peer" ? { seatId, machine: MINI } : undefined),
};

const command = (opId: OpId, itemId: ItemId): ResourceCommand<TaskCommand> => ({
  opId,
  canvasName: "factory",
  actor: peer,
  target: { kind: "task", nodeId: asNodeId("board-1"), itemId },
  basis: null,
  after: [],
  op: { kind: "start" },
});

/** The editing machine's refusal of `opId`, as it arrives on the exchange. */
const refusalRow = (opId: OpId) => {
  const body = { operation: "ruling.refused", writer: MINI, opId, actor: peer, reason: "invalid_transition", root: opId };
  const semantic = {
    protocol: WORK_PROTOCOL,
    id: { route: { eventHome: EDITOR, entityHome: EDITOR }, seq: "1" },
    recordType: "fact",
    basis: { kind: "canvas", canvasName: "factory", seq: 1 },
    item: { kind: "ruling", itemId: opId, sink: { canvasName: "factory", nodeId: "board-1" } },
    operation: body.operation,
    predecessor: null,
    body,
  };
  return { ...semantic, originAt: at, contentSha256: workRecordContentSha256(semantic as never) };
};

type Machine = ManagedRuntime.ManagedRuntime<WorkRepository | OpRepository | ResourceSubmit | SqlClient.SqlClient, unknown>;
const roots: Array<string> = [];
const machines: Array<Machine> = [];

/** A machine `self` holding the canvas `factory`, which `EDITOR` edits. */
const machine = async (self: InstallationId): Promise<Machine> => {
  const root = join(tmpdir(), `junto-pending-marks-${randomUUID()}`);
  roots.push(root);
  const stores = Layer.provideMerge(Layer.mergeAll(WorkRepositoryLive, OpRepositoryLive), makeStateEngineLive(join(root, "junto.db")));
  const runtime: Machine = ManagedRuntime.make(Layer.provideMerge(makeResourceSubmitLayer(() => false), stores));
  machines.push(runtime);
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const known of [MINI, EDITOR]) {
            yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${known}, ${at})`;
          }
          yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${self}, ${at})`;
          yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes: [seat("peer", { y: 0 }), taskBoard("board-1", { y: 200 })] }]]) });
          yield* sql`UPDATE canvases SET editor_installation_id = ${EDITOR} WHERE canvas_name = 'factory'`;
        }),
      );
    }),
  );
  return runtime;
};

afterEach(async () => {
  for (const runtime of machines.splice(0)) await runtime.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const marksOn = (runtime: Machine) => runtime.runPromise(pendingMarksOf("task")("factory", canvas));

describe("pending marks on a real store", () => {
  it("mark a queued write's item on a machine that does not edit the canvas, until its ruling is folded here", async () => {
    const mini = await machine(MINI);
    const item = mintItemId();
    const opId = op("01M5ESR3G8AN1BA0AVVQC2X4W1");
    await mini.runPromise(Effect.flatMap(ResourceSubmit, (submit) => submit.queue(command(opId, item) as never, EDITOR)));
    expect((await marksOn(mini))?.get(item)).toEqual({ pending: true });
    await mini.runPromise(Effect.flatMap(WorkRepository, (work) =>
      work.applyExchangeRows({
        peer: EDITOR,
        frame: { kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer: EDITOR, facts: [refusalRow(opId)], through: "1" } as unknown as RowsFrame,
        placement,
        receivedAt: at,
      })));
    const after = await marksOn(mini);
    expect(after).toBeDefined();
    expect(after?.has(item)).toBe(false);
  });

  it("mark nothing on the machine that edits the canvas: its writes are ruled at once, never queued", async () => {
    const editor = await machine(EDITOR);
    const item = mintItemId();
    const written = command(op("01M5ESR3G8AN1BA0AVVQC2X4W2"), item);
    const ruled: Array<string> = [];
    const submit = await editor.runPromise(ResourceSubmit);
    const outcome = await Effect.runPromise(
      liveTaskPorts.submit(written, { inReach: () => true }, {} as never).pipe(
        Effect.provideService(ResourceSubmit, submit),
        Effect.provideService(TaskRepository, {
          submit: (_writer: InstallationId, sent: ResourceCommand<TaskCommand>) =>
            Effect.sync(() => (ruled.push(sent.opId), { kind: "refused", opId: sent.opId, error: { type: "InvalidTransition", message: "no" }, root: sent.opId })),
        } as never),
        Effect.provideService(MachineRepository, { installationId: Effect.succeed(EDITOR) } as never),
        Effect.provideService(WorkRepository, await editor.runPromise(WorkRepository)),
        Effect.provideService(OpRepository, await editor.runPromise(OpRepository)),
      ),
    );
    expect(outcome.kind).toBe("refused");
    expect(ruled).toEqual([written.opId]);
    expect((await marksOn(editor))?.size).toBe(0);
  });
});
