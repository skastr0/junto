/**
 * `op show` and `op list` on a real state database: a seat reads its own
 * writes from the three places that hold them (rulings made here, rulings
 * received, queued commands), and never another seat's or the operator's.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { OpRepository, OpRepositoryLive } from "../src/main/junto/work/op-repository";
import { handleOpOp } from "../src/main/junto/work/op-control";
import { WorkRepository, WorkRepositoryLive, workRecordContentSha256 } from "../src/main/junto/work/repository";
import { writeRuling } from "../src/main/junto/work/resource-rulings";
import { ActorSeatId } from "../src/shared/actor-seat";
import { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/physics/schema";
import type { ResourceActor } from "../src/shared/resource-command";
import type { CanvasPlacement, RowsFrame } from "../src/shared/work-exchange";
import { OpId } from "../src/shared/work-ids";
import { WORK_PROTOCOL } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const at = "2026-10-21T12:00:00.000Z";
const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"2".repeat(64)}`);
const op = Schema.decodeUnknownSync(OpId);
/** Oldest first, so a list reads them back in reverse. */
const QUEUED = op("01M5ESR3G8AN1BA0AVVQC2X4W1");
const REFUSED = op("01M5ESR3G8AN1BA0AVVQC2X4W2");
const APPLIED = op("01M5ESR3G8AN1BA0AVVQC2X4W3");
const OTHER_SEAT = op("01M5ESR3G8AN1BA0AVVQC2X4W4");
const OPERATOR = op("01M5ESR3G8AN1BA0AVVQC2X4W5");

const peer: ResourceActor = { kind: "seat", seatId, nodeId: asNodeId("peer") };
const scope = { canvasName: "factory", seat: asNodeId("peer") };

const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => machine === EDITOR || machine === MINI,
  seatOf: (nodeId) => (nodeId === "peer" ? { seatId, machine: MINI } : undefined),
};

const command = (opId: OpId) => ({
  opId,
  canvasName: "factory",
  actor: peer,
  target: { kind: "task" as const, nodeId: asNodeId("board-1") },
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

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<WorkRepository | OpRepository | SqlClient.SqlClient, unknown>;

beforeAll(async () => {
  root = join(tmpdir(), `junto-op-repository-${randomUUID()}`);
  runtime = ManagedRuntime.make(
    Layer.provideMerge(Layer.mergeAll(WorkRepositoryLive, OpRepositoryLive), makeStateEngineLive(join(root, "junto.db"))),
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const work = yield* WorkRepository;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const machine of [MINI, EDITOR]) {
            yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${machine}, ${at})`;
          }
          yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${MINI}, ${at})`;
          yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes: [seat("peer", { y: 0 })] }]]) });
        }),
      );
      for (const opId of [QUEUED, REFUSED]) {
        yield* work.queueCommand({ command: command(opId), basis: { kind: "canvas", canvasName: "factory", seq: 1 } as never });
      }
      yield* work.applyExchangeRows({
        peer: EDITOR,
        frame: { kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer: EDITOR, facts: [refusalRow(REFUSED)], through: "1" } as unknown as RowsFrame,
        placement,
        receivedAt: at,
      });
      const ruled = (opId: OpId, actor: ResourceActor) =>
        writeRuling(sql, { canvas: "factory", writer: MINI, command: { opId, actor }, record: { kind: "applied", taskId: opId } });
      yield* ruled(APPLIED, peer);
      yield* ruled(OTHER_SEAT, { kind: "seat", seatId, nodeId: asNodeId("other") });
      yield* ruled(OPERATOR, { kind: "operator" });
    }),
  );
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const show = (opId: OpId) => runtime.runPromise(Effect.flatMap(OpRepository, (ops) => ops.show(scope, opId)));
const list = (filter: { readonly state?: "queued" | "refused"; readonly before?: OpId; readonly limit: number }) =>
  runtime.runPromise(Effect.flatMap(OpRepository, (ops) => ops.list(scope, filter)));

describe("op show", () => {
  it("reads a queued command, a ruling received, and a ruling made here", async () => {
    expect(await show(QUEUED)).toEqual({ state: "queued", opId: QUEUED });
    expect(await show(REFUSED)).toMatchObject({
      state: "refused",
      opId: REFUSED,
      root: REFUSED,
      error: { type: "InvalidTransition", details: { reason: "invalid_transition", opId: REFUSED } },
    });
    expect(await show(APPLIED)).toEqual({ state: "applied", opId: APPLIED, made: { taskId: APPLIED } });
  });

  it("never reads another seat's write or the operator's", async () => {
    expect(await show(OTHER_SEAT)).toBeUndefined();
    expect(await show(OPERATOR)).toBeUndefined();
    expect(await show(op("01M5ESR3G8AN1BA0AVVQC2X4W9"))).toBeUndefined();
  });

  it("answers an unknown opId as UnknownTarget through the work op", async () => {
    const exit = await runtime.runPromiseExit(handleOpOp("op.show", { opId: OTHER_SEAT }, { canvasName: "factory", nodeId: asNodeId("peer") }));
    expect(exit).toMatchObject({ _tag: "Failure" });
    expect(JSON.stringify(exit)).toContain("UnknownTarget");
  });
});

describe("op list", () => {
  it("lists the seat's writes newest first, each once", async () => {
    expect((await list({ limit: 50 })).ops.map((view) => [view.state, view.opId])).toEqual([
      ["applied", APPLIED],
      ["refused", REFUSED],
      ["queued", QUEUED],
    ]);
  });

  it("keeps the queued or the refused ones, and pages with more", async () => {
    expect((await list({ state: "queued", limit: 50 })).ops.map((view) => view.opId)).toEqual([QUEUED]);
    expect((await list({ state: "refused", limit: 50 })).ops.map((view) => view.opId)).toEqual([REFUSED]);
    expect(await list({ limit: 1 })).toMatchObject({ ops: [{ opId: APPLIED }], more: true });
    expect(await list({ limit: 3 })).toMatchObject({ more: false });
  });

  it("reads the next page with before, across all three places", async () => {
    const first = await list({ limit: 1 });
    const second = await list({ limit: 1, before: first.ops[0]!.opId });
    const third = await list({ limit: 1, before: second.ops[0]!.opId });
    expect([first, second, third].map((page) => [page.ops.map((view) => view.opId), page.more])).toEqual([
      [[APPLIED], true],
      [[REFUSED], true],
      [[QUEUED], false],
    ]);
    expect(await list({ limit: 50, before: QUEUED })).toEqual({ ops: [], more: false });
  });
});
