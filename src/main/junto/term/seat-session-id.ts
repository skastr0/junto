import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { isThisMachine } from "@shared/machine-name";
import { coreRunner } from "../../core-runner";
import { ModelService } from "../model/service";
import { SeatSessionRepository } from "../seat-sessions/repository";
import { MachineRepository } from "../machines/repository";

export type SeatSessionIdInput = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly sessionId: string;
  readonly bindingId?: string;
  readonly harness?: string;
  readonly cwd?: string;
  readonly onlyIfAbsent?: boolean;
  readonly capture?: {
    readonly bindingId: string;
    readonly harness: string;
    readonly isCurrent: () => boolean;
  };
};

/** Revalidate the occupant inside the same transaction that records its pin. */
export const recordSeatSessionId = Effect.fn("SeatSession.recordId")(function* (input: SeatSessionIdInput) {
  const model = yield* ModelService;
  const sessions = yield* SeatSessionRepository;
  const machines = yield* MachineRepository;
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(Effect.gen(function* () {
    const target = (yield* model.canvas(input.canvasName)).nodes.get(input.nodeId as never);
    const bindingId = input.capture?.bindingId ?? input.bindingId;
    const harness = input.capture?.harness ?? input.harness;
    if (input.capture && !input.capture.isCurrent())
      return yield* Effect.fail(new Error("session capture generation changed"));
    const machineName = yield* machines.machineName;
    if (target?.kind !== "agent" || !isThisMachine(target.host, machineName))
      return yield* Effect.fail(new Error("session target belongs to another installation or is not an agent seat"));
    if (bindingId === undefined || target.bindingId !== bindingId || (harness !== undefined && target.harness !== harness))
      return yield* Effect.fail(new Error("session target binding or harness changed"));
    const existing = yield* sessions.current(target.id, bindingId);
    if (existing?.sessionId === input.sessionId) return "already-stored" as const;
    if (existing !== undefined && input.capture !== undefined)
      return yield* Effect.fail(new Error("capture cannot replace the seat's named session"));
    if (existing !== undefined && input.onlyIfAbsent)
      return yield* Effect.fail(new Error("the seat already has another named session"));
    const observation = { seatId: target.id, bindingId, harness: target.harness, sessionId: input.sessionId,
      ...(input.cwd ?? target.launch?.cwd ? { cwd: input.cwd ?? target.launch?.cwd } : {}) };
    if (yield* sessions.ownedByOtherSeat(observation))
      return yield* Effect.fail(new Error("harness session already belongs to another seat"));
    yield* sessions.record(observation);
    return "written" as const;
  }));
});

/** PTY and provisioning callbacks enter the machine's existing core. */
export const writeSeatSessionId = async (input: SeatSessionIdInput): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> => {
  try {
    await coreRunner.runPromise(recordSeatSessionId(input));
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
};
