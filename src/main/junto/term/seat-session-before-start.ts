import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { isThisMachine } from "@shared/machine-name";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import type { TerminalLaunch } from "@shared/terminal";
import { coreRunner } from "../../core-runner";
import { ModelService } from "../model/service";
import { SeatSessionRepository } from "../seat-sessions/repository";
import { MachineRepository } from "../machines/repository";
import { ensureProvisionedSessionId, type SeatThreadResult } from "./amp-seat-thread";

type SeatSessionStart = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly bindingId: string;
  readonly harness: string;
  readonly cwd?: string;
  readonly documentLaunch?: TerminalLaunch;
};

/** A copy of the canvas is never edited to choose the local occupant's session. */
const sessionBeforeStart = Effect.fn("SeatSession.beforeStart")(function* (input: SeatSessionStart) {
  const candidate = isHarnessId(input.harness) && templateFor(input.harness).capabilityBadges.sessionId === "pin"
    ? randomUUID() : undefined;
  const sql = yield* SqlClient.SqlClient;
  const model = yield* ModelService;
  const sessions = yield* SeatSessionRepository;
  const machines = yield* MachineRepository;
  return yield* sql.withTransaction(Effect.gen(function* () {
    const current = (yield* model.canvas(input.canvasName)).nodes.get(input.nodeId as never);
    const machineName = yield* machines.machineName;
    if (current?.kind !== "agent" || current.bindingId !== input.bindingId || current.harness !== input.harness)
      return yield* Effect.fail(new Error("seat changed before its session was recorded"));
    if (!isThisMachine(current.host, machineName))
      return yield* Effect.fail(new Error("this seat runs on another machine"));
    if (isHarnessId(input.harness) && templateFor(input.harness).capabilityBadges.sessionId === "pin") {
      return yield* sessions.pin({ seatId: current.id, bindingId: current.bindingId, harness: current.harness,
        sessionId: candidate!, ...(input.cwd ? { cwd: input.cwd } : {}) });
    }
    const existing = yield* sessions.current(current.id, current.bindingId);
    return { sessionId: existing?.harness === current.harness ? existing.sessionId : "", minted: false };
  }));
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
