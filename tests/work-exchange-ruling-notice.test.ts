/**
 * Plan 0.10 02, item (5): the notices an applied ruling owes are written by
 * each recipient seat's own machine, into that seat's mailbox, from the task's
 * node, in the transaction that commits or folds the ruling. The editing
 * machine E tells its own seats as it records the ruling; every other machine
 * tells its own as it folds the ruling, which reaches every machine. The actor
 * seat A lives on M1, the recipient R on M2, the reviewer F on M3.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepository, WorkRepositoryLive, workRecordContentSha256 } from "../src/main/junto/work/repository";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { RulingAppliedResult } from "../src/shared/command-row";
import { InstallationId } from "../src/shared/installation-id";
import { NOTICE_SEAT_ID, noticeActorRef } from "../src/shared/mail-author";
import { rulingNoticesHere } from "../src/shared/ruling-notices";
import { subjectNoticeId } from "../src/shared/subject-notice";
import { threadSubjectOf } from "../src/shared/thread-subject";
import { writtenByItsAuthor, type CanvasPlacement, type ExchangeFact, type RowsFrame } from "../src/shared/work-exchange";
import { ItemId, OpId } from "../src/shared/work-ids";
import { WORK_PROTOCOL } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat, taskBoard } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const E = id("macbook");
const M1 = id("m1");
const M2 = id("m2");
const M3 = id("m3");
const MACHINES = [E, M1, M2, M3];
const at = "2026-10-21T12:00:00.000Z";
const seatIdOf = (digit: string) => Schema.decodeUnknownSync(ActorSeatId)(`seat_${digit.repeat(64)}`);
const OP = Schema.decodeUnknownSync(OpId)("01M5FGR3G8AN1BA0AVVQC2X4W0");
const TASK = Schema.decodeUnknownSync(ItemId)("01M5FGR3G8AN1BA0AVVQC2XTSK");
const A = { kind: "seat" as const, seatId: seatIdOf("1"), nodeId: "lead" };

const NAMES: Record<string, string> = { lead: "Lead", peer: "Peer", far: "Far", "board-1": "Release" };

/** A on M1, R ("peer") on M2, F ("far") on M3, unless `homes` says otherwise; "board-1" holds no seat. */
const placementWith = (homes: Record<string, InstallationId> = {}): CanvasPlacement => {
  const at = { lead: M1, peer: M2, far: M3, ...homes } as Record<string, InstallationId>;
  const seats: Record<string, ActorSeatId> = { lead: seatIdOf("1"), peer: seatIdOf("2"), far: seatIdOf("3"), "board-1": seatIdOf("4") };
  return {
    canvasId: "canvas-factory",
    editor: E,
    holds: (machine) => MACHINES.includes(machine),
    seatOf: (nodeId) => (at[nodeId] === undefined ? undefined : { seatId: seats[nodeId]!, machine: at[nodeId]! }),
    nameOf: (nodeId) => NAMES[nodeId],
  };
};
const placement = placementWith();

const task = {
  state: "assigned",
  node: "board-1",
  assignee: "peer",
  epoch: 1,
  stampPolicy: { required: 1 },
  reviewers: [{ kind: "seat", seat: "far" }],
  stamps: [],
  id: TASK,
  number: 3,
  title: "fix tabs",
  dependsOn: [],
};

/** A assigns R and asks F for a stamp; telling A of its own act, and the operator, are never mail. */
const ruling = (over: Partial<RulingAppliedResult> = {}): RulingAppliedResult =>
  ({
    operation: "ruling.applied",
    writer: M1,
    opId: OP,
    actor: A,
    kind: "task",
    facts: [{
      kind: "task",
      task,
      effects: [
        { kind: "assignment-notice", seat: "peer" },
        { kind: "stamp-request", reviewer: { kind: "seat", seat: "far" } },
        { kind: "stamp-request", reviewer: { kind: "operator" } },
        { kind: "assignment-notice", seat: "lead" },
      ],
    }],
    ...over,
  }) as RulingAppliedResult;

const owed = (self: InstallationId, over: Partial<RulingAppliedResult> = {}, on = placement) =>
  rulingNoticesHere({ self, canvasName: "factory", ruling: ruling(over), placement: on });

/** The row a notice becomes when `self` commits it, as a peer judges it. */
const asRow = (self: InstallationId, write: ReturnType<typeof owed>[number]) =>
  ({
    id: { route: { eventHome: self, entityHome: self }, seq: "1" },
    item: { kind: "message", itemId: write.message.messageId, sink: { canvasName: "factory", nodeId: write.sink.nodeId } },
    body: { operation: "message.append", message: write.message, sentBy: write.sentBy, destination: { kind: "mailbox" } },
  }) as unknown as ExchangeFact;

describe("who writes the notices a ruling owes", () => {
  it("each recipient's own machine, once, into its own seat's mailbox, from the task's node", () => {
    expect(owed(E)).toEqual([]);
    expect(owed(M1)).toEqual([]);
    const [toPeer, ...moreOnM2] = owed(M2);
    const [toFar, ...moreOnM3] = owed(M3);
    expect([moreOnM2, moreOnM3]).toEqual([[], []]);
    expect(toPeer!.sink).toEqual({ canvasName: "factory", nodeId: "peer" });
    expect(toPeer!.sentBy).toEqual(noticeActorRef("factory", "board-1"));
    expect(toPeer!.message.parts).toEqual([{ kind: "text", text: "Lead assigned you #3 fix tabs" }]);
    expect(toPeer!.message.metadata).toMatchObject({ fromSeat: NOTICE_SEAT_ID, senderNodeId: "board-1", subjectNotice: "assignment", threadId: TASK });
    expect(toFar!.message.parts).toEqual([{ kind: "text", text: "Lead asks for your stamp on #3 fix tabs" }]);
    // Derived from the machine that writes it: no id is ever written by two machines.
    expect(toPeer!.message.messageId).toBe(subjectNoticeId({ installationId: M2, sourceId: OP, kind: "assignment", recipient: "peer" as never }));
  });

  it("only rows the writer's own admission and every peer's take: written where the author writes, across placements", () => {
    const placements = [
      placement,
      placementWith({ peer: E }),
      placementWith({ far: M2, lead: M2 }),
      placementWith({ peer: M1, far: M1 }),
    ];
    const actors = [A, { kind: "operator" as const }, { kind: "automation" as const, nodeId: "automation-1", automationId: TASK }];
    let written = 0;
    for (const on of placements) {
      for (const actor of actors) {
        for (const self of MACHINES) {
          for (const write of owed(self, { actor } as never, on)) {
            written += 1;
            expect(on.seatOf(write.sink.nodeId)?.machine).toBe(self);
            expect(writtenByItsAuthor(asRow(self, write), on)).toBe(true);
          }
        }
      }
    }
    expect(written).toBeGreaterThan(0);
  });

  it("names the operator and an automation as the actor, still from the task's node", () => {
    const [byOperator] = owed(M2, { actor: { kind: "operator" } });
    expect(byOperator!.message.parts).toEqual([{ kind: "text", text: "the operator assigned you #3 fix tabs" }]);
    expect(byOperator!.sentBy).toEqual(noticeActorRef("factory", "board-1"));
    const [byAutomation] = owed(M2, { actor: { kind: "automation", nodeId: "board-1", automationId: TASK } } as never);
    expect(byAutomation!.message.metadata).toMatchObject({ fromSeat: NOTICE_SEAT_ID, senderNodeId: "board-1" });
  });

  it("none when the task's node holds a seat, a domain owes no mail, or the facts do not decode", () => {
    const seated = placementWith({ "board-1": M2 });
    expect(MACHINES.flatMap((self) => owed(self, {}, seated))).toEqual([]);
    expect(owed(M2, { kind: "artifact" })).toEqual([]);
    expect(owed(M2, { facts: [{ kind: "task" }] } as never)).toEqual([]);
  });
});

// ── on real databases ─────────────────────────────────────────────────────

type Machine = ManagedRuntime.ManagedRuntime<WorkRepository | SqlClient.SqlClient, unknown>;
const roots: string[] = [];
let m2: Machine;
let editor: Machine;
let m3: Machine;

const machine = async (self: InstallationId): Promise<Machine> => {
  const root = join(tmpdir(), `junto-ruling-notice-${randomUUID()}`);
  roots.push(root);
  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${self}, ${at})`;
      yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${self}, ${at})`;
      const nodes = [seat("lead", { y: 0 }), seat("peer", { y: 200 }), seat("far", { y: 400 }), taskBoard("board-1", { y: 600 })];
      yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes }]]) });
    }));
  }));
  return runtime;
};

/** A row `writer` wrote, with a hash that matches its content. */
const row = (writer: InstallationId, seq: string, item: Record<string, unknown>, body: Record<string, unknown>) => {
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

const rulingRow = (seq: string) => row(E, seq, { kind: "ruling", itemId: OP, sink: { canvasName: "factory", nodeId: "board-1" } }, ruling());

const take = (on: Machine, writer: InstallationId, facts: ReadonlyArray<unknown>, through: string, held = placement) =>
  on.runPromise(Effect.gen(function* () {
    const frame = { kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer, facts, through } as unknown as RowsFrame;
    return yield* (yield* WorkRepository).applyExchangeRows({ peer: E, frame, placement: held, receivedAt: at });
  }));

const mailbox = (on: Machine, nodeId: string) => on.runPromise(Effect.gen(function* () {
  return yield* (yield* WorkRepository).mailbox("factory", nodeId);
}));

const noticesIn = async (on: Machine, nodeId: string) =>
  (await mailbox(on, nodeId)).filter((message) => message.metadata?.threadId === TASK);

const writersOf = (on: Machine, messageId: string) => on.runPromise(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ event_home: string }>`
    SELECT event_home FROM work_events WHERE item_kind = 'message' AND item_id = ${messageId}`).map((held) => held.event_home);
}));

beforeAll(async () => {
  [m2, editor, m3] = await Promise.all([machine(M2), machine(E), machine(M3)]);
});

afterAll(async () => {
  await Promise.all([m2, editor, m3].map((runtime) => runtime?.dispose()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("the recipient's machine folds the ruling", () => {
  it("writes R's one notice on M2 as it folds, under its own installation, and tells delivery", async () => {
    const applied = await take(m2, E, [rulingRow("1")], "1");
    const told = await noticesIn(m2, "peer");
    expect(told).toHaveLength(1);
    expect(told[0]!.metadata).toMatchObject({ fromSeat: NOTICE_SEAT_ID, senderNodeId: "board-1", subjectNotice: "assignment" });
    expect(threadSubjectOf(told[0]!)).toEqual({ kind: "task", nodeId: "board-1", taskId: TASK });
    expect(await writersOf(m2, told[0]!.messageId)).toEqual([M2]);
    expect(applied.mail.map((mail) => [mail.nodeId, mail.message.messageId])).toEqual([["peer", told[0]!.messageId]]);
    // F lives on M3 and A is the actor: M2 writes neither.
    expect(await noticesIn(m2, "far")).toEqual([]);
    expect(await noticesIn(m2, "lead")).toEqual([]);
  });

  it("writes nothing more when the ruling is folded again", async () => {
    await take(m2, E, [rulingRow("1")], "1");
    expect(await noticesIn(m2, "peer")).toHaveLength(1);
  });
});

describe("the editing machine records the ruling", () => {
  const record = (on: CanvasPlacement | undefined) =>
    editor.runPromise(Effect.gen(function* () {
      const { facts } = ruling();
      return yield* (yield* WorkRepository).recordRuling({
        canvasName: "factory",
        writer: M1,
        command: { opId: OP, actor: A, target: { kind: "task", nodeId: "board-1", itemId: TASK } } as never,
        kind: "task",
        record: { kind: "applied", taskId: TASK },
        ruling: { kind: "applied", opId: OP, facts: facts as never },
        at,
        ...(on === undefined ? {} : { placement: on }),
      });
    }));

  it("tells a recipient on E in the same commit, and none on another machine", async () => {
    const recorded = await record(placementWith({ peer: E }));
    expect(recorded.notices.map((notice) => notice.sink.nodeId)).toEqual(["peer"]);
    const told = await noticesIn(editor, "peer");
    expect(told).toHaveLength(1);
    expect(await writersOf(editor, told[0]!.messageId)).toEqual([E]);
    expect(await noticesIn(editor, "far")).toEqual([]);
  });
});

describe("the editing machine's relay stays", () => {
  it("takes a seat's old mail on a newly linked M3 after that seat moved from M1 to M2", async () => {
    // A wrote this on M1; A lives on M2 now. Only E holds the history to relay it.
    const sent = row(M1, "1", { kind: "message", itemId: "mail-1", sink: { canvasName: "factory", nodeId: "far" } }, {
      operation: "message.append",
      message: { messageId: "mail-1", role: "user", parts: [{ kind: "text", text: "before the move" }] },
      sentBy: { ...A, canvasName: "factory" },
      destination: { kind: "mailbox" },
    });
    const moved = placementWith({ lead: M2 });
    const taken = await take(m3, M1, [sent], "1", moved);
    expect(taken.taken).toBe(1);
    expect((await mailbox(m3, "far")).map((message) => message.messageId)).toContain("mail-1");
  });
});

describe("a recipient that moves between two folds of one ruling", () => {
  it("takes the old machine's notice, relayed after the move, under its own id, and keeps the link", async () => {
    // R lived on M2, which folded the ruling and wrote R's notice; R now lives on M3, which folds it too.
    const moved = placementWith({ peer: M3 });
    const there = await machine(M3);
    try {
      await take(there, E, [rulingRow("1")], "1", moved);
      const [mine] = await noticesIn(there, "peer");
      expect(await writersOf(there, mine!.messageId)).toEqual([M3]);
      // R's notice as M2 wrote it before the move, relayed by E: another id, since M2 wrote it.
      const [old] = owed(M2);
      expect(old!.message.messageId).not.toBe(mine!.messageId);
      const relayed = row(M2, "1", { kind: "message", itemId: old!.message.messageId, sink: { canvasName: "factory", nodeId: "peer" } }, {
        operation: "message.append",
        message: old!.message,
        sentBy: old!.sentBy,
        destination: { kind: "mailbox" },
      });
      const taken = await take(there, M2, [relayed], "1", moved);
      expect(taken.taken).toBe(1);
      expect((await noticesIn(there, "peer")).map((notice) => notice.messageId).sort()).toEqual([mine!.messageId, old!.message.messageId].sort());
    } finally {
      await there.dispose();
    }
  });
});
