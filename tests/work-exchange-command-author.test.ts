/**
 * R2 condition 1 (docs/plans/0.10/02-universal-resources.md): the machine that
 * edits a canvas takes a `command.queued` row for seat S only from the machine
 * S was on at the canvas count the row states, judged on the same placement
 * history as mail (docs/machines.md, rule 4). The operator never queues: its
 * commands are written on the editing machine, so one from a peer is refused.
 * An automation's is judged where it was, by node and id
 * (tests/work-exchange-automation-placement.test.ts); here it runs nowhere. Each case runs the real receive path over a real database.
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
import { AUTOMATION_SEAT_ID } from "../src/shared/mail-author";
import {
  editorTakesFromNoPeer,
  rowAuthorOf,
  writtenByItsAuthor,
  type CanvasPlacement,
  type ExchangeFact,
  type RowsFrame,
} from "../src/shared/work-exchange";
import { OpId } from "../src/shared/work-ids";
import { WORK_PROTOCOL } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const OTHER = id("other-mini");
const at = "2026-10-21T12:00:00.000Z";
const seatIdOf = (digit: string) => Schema.decodeUnknownSync(ActorSeatId)(`seat_${digit.repeat(64)}`);

/**
 * Where each seat is, count by count, as the editing machine sent it to the
 * mini. `stays` is on the mini throughout. `moves` is on the mini until count
 * 3, then on the far machine. `goes` is on the mini until count 3, then
 * removed. `far` is on the far machine throughout.
 */
const SEATS = { stays: seatIdOf("1"), moves: seatIdOf("2"), goes: seatIdOf("3"), far: seatIdOf("4") } as const;
type SeatNode = keyof typeof SEATS;
const before: Record<SeatNode, InstallationId> = { stays: MINI, moves: MINI, goes: MINI, far: OTHER };
const after: Partial<Record<SeatNode, InstallationId>> = { stays: MINI, moves: OTHER, far: OTHER };

/** The canvas as it is now; history, not this, judges a row. */
const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => machine === EDITOR || machine === MINI || machine === OTHER,
  seatOf: (nodeId) => {
    const machine = after[nodeId as SeatNode];
    return machine === undefined ? undefined : { seatId: SEATS[nodeId as SeatNode], machine };
  },
};

type Actor =
  | { readonly kind: "seat"; readonly seatId: ActorSeatId; readonly nodeId: string }
  | { readonly kind: "operator" }
  | { readonly kind: "automation"; readonly nodeId: string; readonly automationId: string };

let next = 0;
/** One command row the mini says it wrote, at a fresh sequence, under the canvas count it states. */
const commandRow = (actor: Actor, count: number): ExchangeFact => {
  next += 1;
  const seq = String(next);
  const opId = Schema.decodeUnknownSync(OpId)(`01M5ESR3G8AN1BA0AVVQC2X${String(next).padStart(3, "0")}`);
  const semantic = {
    protocol: WORK_PROTOCOL,
    id: { route: { eventHome: MINI, entityHome: MINI }, seq },
    recordType: "fact",
    basis: { kind: "canvas", canvasName: "factory", seq: count },
    item: { kind: "command", itemId: opId, sink: { canvasName: "factory", nodeId: "board" } },
    operation: "command.queued",
    predecessor: null,
    body: {
      operation: "command.queued",
      command: {
        opId,
        canvasName: "factory",
        actor,
        target: { kind: "task", nodeId: "board" },
        basis: { editor: EDITOR, seq: "1" },
        after: [],
        op: { kind: "start" },
      },
    },
  };
  return { ...semantic, originAt: at, contentSha256: workRecordContentSha256(semantic as never) } as unknown as ExchangeFact;
};

const frameOf = (fact: ExchangeFact): RowsFrame =>
  ({ kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer: MINI, facts: [fact], through: fact.id.seq }) as RowsFrame;

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<WorkRepository | SqlClient.SqlClient, unknown>;

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
const refusals: string[] = [];

beforeAll(async () => {
  root = join(tmpdir(), `junto-command-author-${randomUUID()}`);
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
      // Count 3: `moves` moved to the far machine and `goes` was removed. Count 4 was never sent to the mini.
      yield* repository.recordCanvasCopySent({ canvasName: "factory", target: MINI, seq: 3, seats: seatsAt(after), sentAt: at });
    }),
  );
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const seatActor = (nodeId: SeatNode, seatId: ActorSeatId = SEATS[nodeId]): Actor => ({ kind: "seat", seatId, nodeId });

describe("a command row from the mini, on the machine that edits the canvas", () => {
  const table: ReadonlyArray<readonly [string, () => ExchangeFact, boolean]> = [
    // In the order the mini writes them: a writer's stated count never goes backwards.
    ["its seat moved after the count the row states: judged at that count", () => commandRow(seatActor("moves"), 2), true],
    ["its seat was removed after the count the row states", () => commandRow(seatActor("goes"), 2), true],
    ["written where its seat is", () => commandRow(seatActor("stays"), 3), true],
    ["its seat moved before the count the row states", () => commandRow(seatActor("moves"), 3), false],
    ["its seat was removed before the count the row states", () => commandRow(seatActor("goes"), 3), false],
    ["its seat is on another machine", () => commandRow(seatActor("far"), 3), false],
    ["it names another identity than the seat at that node", () => commandRow(seatActor("stays", SEATS.far), 3), false],
    ["it is the operator's", () => commandRow({ kind: "operator" }, 3), false],
    ["it is an automation's that runs on no machine here", () => commandRow({ kind: "automation", nodeId: "nightly", automationId: "01M5ESR3G8AN1BA0AVVQC2X4WY" }, 3), false],
    ["it states a count never sent to the mini", () => commandRow(seatActor("stays"), 4), false],
  ];

  it.each(table)("%s", async (_case, row, taken) => {
    refusals.length = 0;
    expect(await takes(row()), refusals.join("; ")).toBe(taken);
  });
});

describe("who a command row says wrote it", () => {
  it("is the seat, the operator or the automation its actor names", () => {
    expect(rowAuthorOf(commandRow(seatActor("stays"), 3))).toEqual({ kind: "seat", seatId: SEATS.stays, nodeId: "stays" });
    expect(rowAuthorOf(commandRow({ kind: "operator" }, 3))).toEqual({ kind: "operator" });
    expect(rowAuthorOf(commandRow({ kind: "automation", nodeId: "nightly", automationId: "01M5ESR3G8AN1BA0AVVQC2X4WY" }, 3)))
      .toEqual({ kind: "automation", nodeId: "nightly", automationId: "01M5ESR3G8AN1BA0AVVQC2X4WY" });
  });

  it("is malformed when a seat actor carries the operator's or an automation's identity", () => {
    expect(rowAuthorOf(commandRow(seatActor("stays", AUTOMATION_SEAT_ID), 3))).toEqual({ kind: "malformed" });
  });

  it("is refused from every peer for the operator, and judged by placement for a seat and an automation", () => {
    expect(editorTakesFromNoPeer(commandRow({ kind: "operator" }, 3))).toBe(true);
    expect(editorTakesFromNoPeer(commandRow({ kind: "automation", nodeId: "nightly", automationId: "01M5ESR3G8AN1BA0AVVQC2X4WY" }, 3))).toBe(false);
    expect(editorTakesFromNoPeer(commandRow(seatActor("stays"), 3))).toBe(false);
  });

  it("was written by its author only on the machine its seat is on now, for a machine holding a copy", () => {
    expect(writtenByItsAuthor(commandRow(seatActor("stays"), 3), placement)).toBe(true);
    expect(writtenByItsAuthor(commandRow(seatActor("far"), 3), placement)).toBe(false);
    expect(writtenByItsAuthor(commandRow({ kind: "operator" }, 3), placement)).toBe(false);
  });
});
