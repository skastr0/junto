import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { isThisMachine } from "@shared/machine-name";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import type { TerminalLaunch } from "@shared/terminal";
import { coreRunner } from "../../core-runner";
import { ModelService } from "../model/service";
import { SeatSessionRepository } from "../seat-sessions/repository";
import { coldSessionEnded, coldSessionStartsFresh } from "../seat-sessions/operator-offboard";
import type { SeatStartCause } from "./seat-start-cause";
import { MachineRepository } from "../machines/repository";
import { ensureProvisionedSessionId, type SeatThreadResult } from "./amp-seat-thread";

type SeatSessionStart = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly bindingId: string;
  readonly harness: string;
  readonly cwd?: string;
  readonly documentLaunch?: TerminalLaunch;
  /**
   * The operator asked for a fresh session: the open one ends here, so the
   * start pins, captures or provisions a new one and the next wake resumes
   * that, not the session left behind.
   */
  readonly fresh?: boolean;
  /** Why the seat is starting, for the start decision. Default: the operator opened it. */
  readonly cause?: SeatStartCause;
};

/** A copy of the canvas is never edited to choose the local occupant's session. */
const sessionBeforeStart = Effect.fn("SeatSession.beforeStart")(function* (input: SeatSessionStart) {
  const candidate = isHarnessId(input.harness) && templateFor(input.harness).capabilityBadges.sessionId === "pin"
    ? randomUUID() : undefined;
  const seat = { canvasName: input.canvasName, seatId: input.nodeId };
  // A cold session starts fresh, on the same path as the operator's own fresh
  // start. Asked before the transaction: it reads the canvas and the session.
  const cold = input.fresh !== true &&
    (yield* Effect.promise(() => coldSessionStartsFresh(seat, input.cause ?? "operator")));
  const sql = yield* SqlClient.SqlClient;
  const model = yield* ModelService;
  const sessions = yield* SeatSessionRepository;
  const machines = yield* MachineRepository;
  const chosen = yield* sql.withTransaction(Effect.gen(function* () {
    const current = (yield* model.canvas(input.canvasName)).nodes.get(input.nodeId as never);
    const machineName = yield* machines.machineName;
    if (current?.kind !== "agent" || current.bindingId !== input.bindingId || current.harness !== input.harness)
      return yield* Effect.fail(new Error("seat changed before its session was recorded"));
    if (!isThisMachine(current.host, machineName))
      return yield* Effect.fail(new Error("this seat runs on another machine"));
    const ended = input.fresh === true || cold
      ? yield* sessions.end(current.id, "replaced", undefined, current.bindingId)
      : undefined;
    if (isHarnessId(input.harness) && templateFor(input.harness).capabilityBadges.sessionId === "pin") {
      const pinned = yield* sessions.pin({ seatId: current.id, bindingId: current.bindingId, harness: current.harness,
        sessionId: candidate!, ...(input.cwd ? { cwd: input.cwd } : {}) });
      return { selected: pinned, ended };
    }
    const existing = yield* sessions.current(current.id, current.bindingId);
    return { selected: { sessionId: existing?.harness === current.harness ? existing.sessionId : "", minted: false }, ended };
  }));
  if (cold && chosen.ended !== undefined) coldSessionEnded(seat, input.bindingId, chosen.ended);
  return chosen.selected;
});

/** Operator starts and automatic wakes share the same durable named session. */
export const ensureSeatSessionId = async (input: SeatSessionStart): Promise<SeatThreadResult> => {
  try {
    const selected = await coreRunner.runPromise(sessionBeforeStart(input));
    if (isHarnessId(input.harness) && templateFor(input.harness).capabilityBadges.sessionId === "pin")
      return { ok: true, ...selected };
    return await ensureProvisionedSessionId({ ...input, storedSessionId: selected.sessionId });
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
};
