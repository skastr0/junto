/**
 * A resource's notice (02, "Refusal and rollback"): the refusal of a seat's
 * command, told into that seat's own mailbox from the refused resource's node,
 * written by the seat's own machine. The machine that edits the canvas takes
 * one only from the machine the mailbox seat was on at the canvas count the
 * row states (docs/machines.md, rule 4). Each case runs the real receive path
 * over a real database.
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
import { InstallationId } from "../src/shared/installation-id";
import { noticeActorRef } from "../src/shared/mail-author";
import type { CanvasPlacement, ExchangeFact, RowsFrame } from "../src/shared/work-exchange";
import { WORK_PROTOCOL } from "../src/shared/work-protocol";
import type { ActorRef } from "../src/shared/work-reference";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const OTHER = id("other-mini");
const at = "2026-10-21T12:00:00.000Z";
const seatIdOf = (digit: string) => Schema.decodeUnknownSync(ActorSeatId)(`seat_${digit.repeat(64)}`);

/**
 * `stays` is on the mini throughout; `moves` is on the mini until count 3,
 * then on the far machine; `goes` is on the mini until count 3, then removed;
 * `far` is always there.
 */
const SEATS = { stays: seatIdOf("1"), moves: seatIdOf("2"), goes: seatIdOf("3"), far: seatIdOf("4") } as const;
type SeatNode = keyof typeof SEATS;
const before: Partial<Record<SeatNode, InstallationId>> = { stays: MINI, moves: MINI, goes: MINI, far: OTHER };
const after: Partial<Record<SeatNode, InstallationId>> = { stays: MINI, moves: OTHER, far: OTHER };

const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => machine === EDITOR || machine === MINI || machine === OTHER,
  seatOf: (nodeId) => {
    const machine = after[nodeId as SeatNode];
    return machine === undefined ? undefined : { seatId: SEATS[nodeId as SeatNode], machine };
  },
};

let next = 0;
/** One mail row the mini says it wrote into `mailbox`, at a fresh sequence, under the canvas count it states. */
const mailRow = (sentBy: ActorRef, mailbox: string, count: number): ExchangeFact => {
  next += 1;
  const seq = String(next);
  const messageId = `01M5EWQ0000000000000000${String(next).padStart(3, "0")}`;
  const semantic = {
    protocol: WORK_PROTOCOL,
    id: { route: { eventHome: MINI, entityHome: MINI }, seq },
    recordType: "fact",
    basis: { kind: "canvas", canvasName: "factory", seq: count },
    item: { kind: "message", itemId: messageId, sink: { canvasName: "factory", nodeId: mailbox } },
    operation: "message.append",
    predecessor: null,
    body: {
      operation: "message.append",
      message: { messageId, role: "agent", parts: [{ kind: "text", text: "refused" }] },
      sentBy,
      destination: { kind: "mailbox" },
    },
  };
  return { ...semantic, originAt: at, contentSha256: workRecordContentSha256(semantic as never) } as unknown as ExchangeFact;
};

const frameOf = (fact: ExchangeFact): RowsFrame =>
  ({ kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer: MINI, facts: [fact], through: fact.id.seq }) as RowsFrame;

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<WorkRepository | SqlClient.SqlClient, unknown>;
const refusals: string[] = [];

/** Did the editing machine take the row from the mini? A refusal writes nothing. */
const takes = async (fact: ExchangeFact): Promise<boolean> => {
  const outcome = await runtime.runPromise(
    Effect.gen(function* () {
      const repository = yield* WorkRepository;
      return yield* repository.applyExchangeRows({ peer: MINI, frame: frameOf(fact), placement, receivedAt: at });
    }).pipe(Effect.result),
  );
  if (outcome._tag === "Failure") refusals.push(String((outcome.failure as { message?: unknown }).message ?? outcome.failure));
  return outcome._tag === "Success";
};

beforeAll(async () => {
  root = join(tmpdir(), `junto-notice-author-${randomUUID()}`);
  runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${EDITOR}, ${at})`;
          yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${EDITOR}, ${at})`;
          yield* seedCanvasRows({
            seq: 1,
            canvases: new Map([["factory", { nodes: Object.keys(SEATS).map((nodeId, index) => seat(nodeId, { y: index * 120 })) }]]),
          });
        }),
      );
      const repository = yield* WorkRepository;
      const seatsAt = (where: Partial<Record<SeatNode, InstallationId>>) =>
        (Object.keys(where) as SeatNode[]).map((nodeId) => ({ nodeId, seatId: SEATS[nodeId], machine: where[nodeId]! }));
      for (const seq of [1, 2]) {
        yield* repository.recordCanvasCopySent({ canvasName: "factory", target: MINI, seq, seats: seatsAt(before), sentAt: at });
      }
      yield* repository.recordCanvasCopySent({ canvasName: "factory", target: MINI, seq: 3, seats: seatsAt(after), sentAt: at });
    }),
  );
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("a resource's notice from the mini, on the machine that edits the canvas", () => {
  const board = noticeActorRef("factory", "board");
  const table: ReadonlyArray<readonly [string, () => ExchangeFact, boolean]> = [
    // In the order the mini writes them: a writer's stated count never goes backwards.
    ["into a seat that moved away after the count the row states", () => mailRow(board, "moves", 2), true],
    ["from a node that held a seat at the count the row states, though none now", () => mailRow(noticeActorRef("factory", "goes"), "stays", 2), false],
    ["from a node whose seat was removed before the count the row states", () => mailRow(noticeActorRef("factory", "goes"), "stays", 3), true],
    ["into its own seat's mailbox, where that seat is", () => mailRow(board, "stays", 3), true],
    ["into a seat that moved away before the count the row states", () => mailRow(board, "moves", 3), false],
    ["into a seat on another machine", () => mailRow(board, "far", 3), false],
    ["from a node that holds a seat", () => mailRow(noticeActorRef("factory", "far"), "stays", 3), false],
    ["into the notice's own node", () => mailRow(noticeActorRef("factory", "stays"), "stays", 3), false],
    ["under a count never sent to the mini", () => mailRow(board, "stays", 4), false],
  ];

  it.each(table)("%s", async (_case, row, taken) => {
    refusals.length = 0;
    expect(await takes(row()), refusals.join("; ")).toBe(taken);
  });
});
