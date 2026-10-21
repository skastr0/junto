/**
 * R2 step 4 on a real database: when the seat's machine takes the editing
 * machine's `ruling.refused` for one of its own commands, the actor seat gets
 * one notice in its own mailbox, from the refused node, naming the commands
 * refused with it. A dependent's own refusal, another machine's command and a
 * non-seat actor give none, nor a command aimed at a seat's node, whose notice
 * the editing machine would refuse; taking the same rows again writes nothing.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepository, WorkRepositoryLive, workRecordContentSha256 } from "../src/main/junto/work/repository";
import { ActorSeatId } from "../src/shared/actor-seat";
import { InstallationId } from "../src/shared/installation-id";
import { NOTICE_SEAT_ID } from "../src/shared/mail-author";
import { subjectNoticeId } from "../src/shared/subject-notice";
import { threadSubjectOf } from "../src/shared/thread-subject";
import type { CanvasPlacement, RowsFrame } from "../src/shared/work-exchange";
import { ItemId, OpId } from "../src/shared/work-ids";
import { WORK_PROTOCOL } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat, taskBoard } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const OTHER = id("other-mini");
const at = "2026-10-21T12:00:00.000Z";
const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"2".repeat(64)}`);
const op = (tail: string) => Schema.decodeUnknownSync(OpId)(`01M5ESR3G8AN1BA0AVVQC2X${tail}`);
const ROOT = op("4W0");
const CHILD = op("4W1");
const GRANDCHILD = op("4W2");
const ALONE = op("4W3");
const AT_SEAT = op("4W4");
const AT_SELF = op("4W5");
const TASK = Schema.decodeUnknownSync(ItemId)("01M5ESR3G8AN1BA0AVVQC2XTSK");
const actor = { kind: "seat" as const, seatId, nodeId: "peer" };

const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => machine === EDITOR || machine === MINI || machine === OTHER,
  // By ruling time "lead" and "solo", task nodes when their commands were queued, hold seats.
  seatOf: (nodeId) => (["peer", "lead", "solo"].includes(nodeId) ? { seatId, machine: MINI } : undefined),
};

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<WorkRepository | SqlClient.SqlClient, unknown>;

const queue = (opId: OpId, after: ReadonlyArray<OpId>, nodeId = "board-1", by = actor) =>
  Effect.gen(function* () {
    const repository = yield* WorkRepository;
    yield* repository.queueCommand({
      command: {
        opId,
        canvasName: "factory",
        actor: by,
        target: { kind: "task", nodeId, itemId: TASK },
        basis: null,
        after,
        op: { kind: "assign" },
      } as never,
      basis: { kind: "canvas", canvasName: "factory", seq: 1 },
      originAt: at,
      receivedAt: at,
    });
  });

/** The editing machine's refusal of `opId`, at `seq`, with a hash that matches its content. */
const refusal = (seq: string, opId: OpId, overrides: Record<string, unknown> = {}) => {
  const body = { operation: "ruling.refused", writer: MINI, opId, actor, reason: "already_held", expected: "epoch:7", root: opId, ...overrides };
  const semantic = {
    protocol: WORK_PROTOCOL,
    id: { route: { eventHome: EDITOR, entityHome: EDITOR }, seq },
    recordType: "fact",
    basis: { kind: "canvas", canvasName: "factory", seq: 1 },
    item: { kind: "ruling", itemId: opId, sink: { canvasName: "factory", nodeId: "board-1" } },
    operation: "ruling.refused",
    predecessor: null,
    body,
  };
  return { ...semantic, originAt: at, contentSha256: workRecordContentSha256(semantic as never) };
};

const frame = (facts: ReadonlyArray<unknown>, through: string): RowsFrame =>
  ({ kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer: EDITOR, facts, through }) as unknown as RowsFrame;

const take = (sent: RowsFrame) =>
  runtime.runPromise(Effect.gen(function* () {
    return yield* (yield* WorkRepository).applyExchangeRows({ peer: EDITOR, frame: sent, placement, receivedAt: at });
  }));

const mailbox = (nodeId = "peer") => runtime.runPromise(Effect.gen(function* () {
  return yield* (yield* WorkRepository).mailbox("factory", nodeId);
}));

const noticeId = (opId: OpId) => subjectNoticeId({ installationId: MINI, sourceId: opId, kind: "refusal", recipient: "peer" as never });

beforeAll(async () => {
  root = join(tmpdir(), `junto-refusal-notice-${randomUUID()}`);
  runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${MINI}, ${at})`;
          yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${MINI}, ${at})`;
          const nodes = [seat("peer", { y: 0 }), taskBoard("board-1", { y: 200 }), taskBoard("lead", { y: 400 }), taskBoard("solo", { y: 600 })];
          yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes }]]) });
        }),
      );
      yield* queue(ROOT, []);
      yield* queue(CHILD, [ROOT]);
      yield* queue(GRANDCHILD, [CHILD]);
      yield* queue(ALONE, []);
      yield* queue(AT_SEAT, [], "lead");
      yield* queue(AT_SELF, [], "solo", { ...actor, nodeId: "solo" });
    }),
  );
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("a refusal of this machine's own command", () => {
  it("writes one notice into the actor seat's mailbox, from the refused node, naming what was refused with it", async () => {
    const applied = await take(frame([refusal("1", ROOT), refusal("2", CHILD, { reason: "depends_on_refused", root: ROOT })], "2"));

    const notices = (await mailbox()).filter((message) => message.messageId === noticeId(ROOT));
    expect(notices).toHaveLength(1);
    const [notice] = notices;
    expect(notice!.metadata).toMatchObject({ fromSeat: NOTICE_SEAT_ID, senderNodeId: "board-1", subjectNotice: "refusal", mailKind: "notice" });
    const text = notice!.parts.map((part) => ("text" in part ? part.text : "")).join("");
    expect(text).toContain("task assign was refused: Another command was ruled first (ClaimConflict)");
    expect(text).toContain("lost to: epoch:7");
    expect(text).toContain(`refused with it: ${CHILD}, ${GRANDCHILD}`);
    expect(threadSubjectOf(notice!)).toEqual({ kind: "task", nodeId: "board-1", taskId: TASK });
    // Told to delivery after the commit, like mail that arrived.
    expect(applied.mail.map((sent) => sent.message.messageId)).toEqual([noticeId(ROOT)]);
  });

  it("gives a dependent no notice of its own", async () => {
    expect((await mailbox()).some((message) => message.messageId === noticeId(CHILD))).toBe(false);
  });

  it("writes nothing more when the same rows arrive again", async () => {
    const before = (await mailbox()).length;
    await take(frame([refusal("1", ROOT), refusal("2", CHILD, { reason: "depends_on_refused", root: ROOT })], "2"));
    expect((await mailbox()).length).toBe(before);
  });

  it("writes none for another machine's command, or for an actor that is no seat", async () => {
    const before = (await mailbox()).length;
    await take(frame([
      refusal("3", ALONE, { writer: OTHER }),
      refusal("4", ALONE, { actor: { kind: "operator" } }),
    ], "4"));
    expect((await mailbox()).length).toBe(before);
  });

  it("writes none for a command whose target is a seat's node by ruling time, or the actor's own, and keeps taking rows", async () => {
    // Its notice would be a row the editing machine refuses, closing the link: main never writes one.
    const before = (await mailbox()).length;
    const taken = await take(frame([
      refusal("5", AT_SEAT),
      refusal("6", AT_SELF, { actor: { ...actor, nodeId: "solo" } }),
    ], "6"));
    expect(taken.taken).toBe(2);
    expect((await mailbox()).length).toBe(before);
    expect(await mailbox("solo")).toEqual([]);
  });

  it("is never queued aimed at a seat's node: queueCommand refuses it and writes nothing", async () => {
    const aimed = await runtime.runPromiseExit(queue(op("4W6"), [], "peer"));
    expect(Exit.isFailure(aimed) && Cause.pretty(aimed.cause).includes("CommandTargetUnknown")).toBe(true);
  });
});
