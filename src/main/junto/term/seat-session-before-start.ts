import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Command } from "@shared/model";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import type { TerminalLaunch } from "@shared/terminal";
import { AppRuntime } from "../../runtime";
import { ModelService } from "../model/service";
import { ensureProvisionedSessionId, type SeatThreadResult } from "./amp-seat-thread";

type SeatSessionStart = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly bindingId: string;
  readonly harness: string;
  readonly storedSessionId?: string;
  readonly cwd?: string;
  readonly documentLaunch?: TerminalLaunch;
};

/** Record a pin before starting its process, on the binding that requested it. */
const pinBeforeStart = Effect.fn("SeatSession.pinBeforeStart")(function* (input: SeatSessionStart) {
  // This may wait for the database lease. The transaction must validate the
  // binding again: an intervening re-seat cannot inherit this session.
  const minted = input.storedSessionId?.trim() ? undefined : randomUUID();
  const sql = yield* SqlClient.SqlClient;
  const model = yield* ModelService;
  return yield* sql.withTransaction(Effect.gen(function* () {
    const current = (yield* model.canvas(input.canvasName)).nodes.get(input.nodeId as never);
    if (current?.kind !== "agent" || current.bindingId !== input.bindingId || current.harness !== input.harness)
      return yield* Effect.fail(new Error("seat changed before its session was recorded"));
    const existing = current.sessionId?.trim();
    if (existing) return { ok: true as const, sessionId: existing, minted: false };
    const sessionId = minted ?? randomUUID();
    yield* model.command(Schema.decodeUnknownSync(Command)({
      _tag: "RecordSession", canvas: input.canvasName, id: current.id, sessionId,
    }), "runtime");
    return { ok: true as const, sessionId, minted: true };
  }));
});

/** Operator starts and automatic wakes share the same durable session choice. */
export const ensureSeatSessionId = async (input: SeatSessionStart): Promise<SeatThreadResult> => {
  const { bindingId: _binding, ...provisioning } = input;
  if (!isHarnessId(input.harness) || templateFor(input.harness).capabilityBadges.sessionId !== "pin")
    return ensureProvisionedSessionId(provisioning);
  try {
    return await AppRuntime.runPromise(pinBeforeStart(input));
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
};
