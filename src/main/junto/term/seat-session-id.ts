/**
 * Writing a seat's session id onto its node.
 *
 * Two harness families need this and they learn the id at opposite ends of the
 * spawn: a provisioned harness (Amp) is told its thread before the PTY opens,
 * while a capture harness (Muse) only reveals its id after the process is
 * already running. Both end in the same place — the seat session column — because that is the one field a cold wake reads to resume the
 * exact session rather than starting a new one.
 *
 * Transactional by construction: a full-document write from this path could
 * lose a concurrent edit, and an id that goes missing is a seat that silently
 * forks its session on the next wake.
 */

import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Command } from "@shared/model";
import { AppRuntime } from "../../runtime";
import { ModelService } from "../model/service";
import { StationRepository } from "../station/repository";

type SeatSessionIdInput = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly sessionId: string;
  readonly onlyIfAbsent?: boolean;
  readonly capture?: {
    readonly bindingId: string;
    readonly harness: string;
    /** Revalidated inside the authorial transaction, after any queued await. */
    readonly isCurrent: () => boolean;
  };
};

/**
 * Captured ids belong to one harness on one installation, across canvases.
 * This existing writer is Command Center authoring: Remote was already
 * refused by CanvasesService and needs a separate home-owned capture route.
 */
const persistSeatSessionId = (input: SeatSessionIdInput) => Effect.gen(function* () {
  const model = yield* ModelService;
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(Effect.gen(function* () {
    const current = yield* model.canvas(input.canvasName);
    const target = current.nodes.get(input.nodeId as never);
    if (target?.kind !== "agent") return yield* Effect.fail(new Error("session target is not an agent seat"));
    const capture = input.capture;
    const record = (canvas: string, id: string) => model.command(Schema.decodeUnknownSync(Command)({
      _tag: "RecordSession", canvas, id, sessionId: input.sessionId,
    }), "runtime");
    if (capture === undefined) {
      if (input.onlyIfAbsent && target.sessionId?.trim()) return;
      yield* record(input.canvasName, target.id);
      return;
    }
    const stations = yield* StationRepository;
    const configuration = yield* stations.configuration;
    if (configuration?.configuration.role !== "command-center")
      return yield* Effect.fail(new Error("captured session persistence requires Command Center authoring"));
    const localHost = configuration.configuration.hostId;
    if (!capture.isCurrent()) return yield* Effect.fail(new Error("session capture generation changed"));
    if (target.bindingId !== capture.bindingId || target.harness !== capture.harness || target.host !== localHost)
      return yield* Effect.fail(new Error("session capture target changed or belongs to another installation"));
    const aliases: { canvas: string; id: string }[] = [];
    for (const name of yield* model.listCanvases()) {
      for (const node of (yield* model.canvas(name)).nodes.values()) {
        if (node.kind !== "agent" || node.harness !== capture.harness || node.host !== localHost) continue;
        const existing = node.sessionId?.trim();
        if (existing === input.sessionId && node.bindingId !== capture.bindingId)
          return yield* Effect.fail(new Error("captured harness session already belongs to another seat"));
        if (node.bindingId === capture.bindingId) {
          if (existing && existing !== input.sessionId)
            return yield* Effect.fail(new Error("capture cannot replace the seat's named session"));
          aliases.push({ canvas: name, id: node.id });
        }
      }
    }
    for (const alias of aliases) yield* record(alias.canvas, alias.id);
  }));
});

/**
 * Persist the id, or report why it did not land. Never throws: a caller in a
 * PTY event path must not be taken down by a canvas write.
 */
export const writeSeatSessionId = async (input: SeatSessionIdInput): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> => {
  try {
    await AppRuntime.runPromise(
      persistSeatSessionId(input),
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error !== null && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message
        : String(error),
    };
  }
};
