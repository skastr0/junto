/**
 * Writing a seat's session id onto its node.
 *
 * Two harness families need this and they learn the id at opposite ends of the
 * spawn: a provisioned harness (Amp) is told its thread before the PTY opens,
 * while a capture harness (Muse) only reveals its id after the process is
 * already running. Both end in the same place — `ether.terminal.sessionId` on
 * the canvas — because that is the one field a cold wake reads to resume the
 * exact session rather than starting a new one.
 *
 * Transactional by construction: a full-document write from this path could
 * lose a concurrent edit, and an id that goes missing is a seat that silently
 * forks its session on the next wake.
 */

import { Effect } from "effect";
import type { CanvasDoc } from "@shared/canvas";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import { AppRuntime } from "../../runtime";
import { CanvasesService } from "../canvases";
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
const persistSeatSessionId = (
  input: SeatSessionIdInput,
): Effect.Effect<void, unknown, CanvasesService | StationRepository> =>
  Effect.gen(function* () {
    const capture = input.capture;
    if (capture === undefined) {
      return yield* mutation(input.canvasName, input.nodeId, input.sessionId, input.onlyIfAbsent === true);
    }
    const stations = yield* StationRepository;
    const configuration = yield* stations.configuration;
    if (configuration?.configuration.role !== "command-center") {
      return yield* Effect.fail(new Error("captured session persistence requires Command Center authoring"));
    }
    // The installation's configured HostId is immutable. The literal `local`
    // is not an alias when this Command Center has another configured host.
    const localHost = configuration.configuration.hostId;
    const canvases = yield* CanvasesService;
    yield* canvases.mutatePortfolio((view) => {
      const refuse = (message: string) => ({
        ok: false as const,
        error: { type: "InternalError" as const, message },
      });
      if (!capture.isCurrent()) return refuse("session capture generation changed");
      const doc = view.documents.get(input.canvasName);
      const target = doc?.nodes.find((node) => node.id === input.nodeId);
      const surface = target === undefined ? undefined : actorDeliverySurfaceOf(target);
      if (
        surface === undefined ||
        surface.bindingId !== capture.bindingId ||
        surface.harness !== capture.harness ||
        surface.hostId !== localHost
      ) return refuse("session capture target changed or belongs to another installation");
      for (const current of view.documents.values()) {
        for (const node of current.nodes) {
          const other = actorDeliverySurfaceOf(node);
          if (other === undefined || other.harness !== capture.harness || other.hostId !== localHost) continue;
          const existing = node.ether?.terminal?.sessionId?.trim();
          if (existing === input.sessionId && other.bindingId !== capture.bindingId) {
            return refuse("captured harness session already belongs to another seat");
          }
          if (other.bindingId === capture.bindingId && existing && existing !== input.sessionId) {
            return refuse("capture cannot replace the seat's named session");
          }
        }
      }
      const documents = new Map(view.documents);
      for (const [name, current] of view.documents) {
        let changed = false;
        const nodes = current.nodes.map((node) => {
          const other = actorDeliverySurfaceOf(node);
          if (
            other === undefined || other.bindingId !== capture.bindingId ||
            other.harness !== capture.harness || other.hostId !== localHost ||
            node.ether?.terminal?.sessionId === input.sessionId
          ) return node;
          changed = true;
          return {
            ...node,
            ether: { ...node.ether, terminal: { ...node.ether!.terminal!, sessionId: input.sessionId } },
          };
        });
        if (changed) documents.set(name, { ...current, nodes });
      }
      return { ok: true as const, mutation: { documents, result: undefined } };
    });
  });

const mutation = (
  canvasName: string,
  nodeId: string,
  sessionId: string,
  onlyIfAbsent: boolean,
): Effect.Effect<void, unknown, CanvasesService> =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    yield* canvases.mutate(canvasName, (doc: CanvasDoc) => ({
      ...doc,
      nodes: doc.nodes.map((node) => {
        if (node.id !== nodeId || !node.ether?.terminal) return node;
        // Check-and-set inside the transaction. A seat that is resuming
        // already carries its id, and overwriting it with a sibling session
        // discovered in the store is how a seat quietly loses its history.
        if (onlyIfAbsent && (node.ether.terminal.sessionId ?? "").trim()) {
          return node;
        }
        return {
          ...node,
          ether: {
            ...node.ether,
            terminal: { ...node.ether.terminal, sessionId },
          },
        };
      }),
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
