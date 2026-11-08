import { Effect, Queue, Result } from "effect";
import { asNodeId, type Canvas, type Seat } from "@shared/model";
import type { OverseerCaller } from "@shared/overseer-control";
import type { InstallationId } from "@shared/installation-id";
import type { ActorRef } from "@shared/work-reference";
import type { WorkErrorBody } from "@shared/work-control";
import { ModelActorRefs } from "../model/actor-refs";
import { ModelService } from "../model/service";
import { deriveActorSeatId } from "../actor-seat-id";
import { MachineRepository } from "../machines/repository";

/** One canvas as the model holds it, with the actor references compiled for it. */
export type OverseerSeatRead = {
  readonly name: string;
  readonly canvas: Pick<Canvas, "nodes">;
  readonly actorRefs: ReadonlyArray<ActorRef>;
};

/** The caller's seat when it is a seat the operator made an overseer. */
const overseerSeatOf = (
  caller: OverseerCaller,
  read: OverseerSeatRead,
): Seat | undefined => {
  if (read.name !== caller.canvasName) return undefined;
  const node = read.canvas.nodes.get(asNodeId(caller.nodeId));
  return node?.kind === "agent" && node.overseer ? node : undefined;
};

/** Installation evidence comes from local process admission or a paired peer. */
export const resolveOverseerActor = (
  caller: OverseerCaller,
  read: OverseerSeatRead,
  sourceInstallationId: InstallationId,
): Result.Result<ActorRef, WorkErrorBody> => {
  const seat = overseerSeatOf(caller, read);
  if (seat === undefined) {
    return Result.fail({
      type: "ScopeError",
      message: "the caller no longer has human-granted overseer authority",
      details: { retryable: false, caller: caller.nodeId },
    });
  }
  const refs = read.actorRefs.filter((actor) =>
    actor.canvasName === caller.canvasName && actor.nodeId === caller.nodeId);
  const expectedSeat = deriveActorSeatId(sourceInstallationId, seat.bindingId);
  if (refs.length !== 1 || refs[0]!.seatId !== expectedSeat) {
    return Result.fail({
      type: "ScopeError",
      message: "overseer caller does not belong to the authenticated installation",
      details: { retryable: false, caller: caller.nodeId },
    });
  }
  return Result.succeed(refs[0]!);
};

/** Re-evaluated for every invocation and after every change to the caller's canvas. */
export const admitOverseer = Effect.fn("overseer.admit")(function* (
  caller: OverseerCaller,
  sourceInstallationId?: InstallationId,
) {
  const model = yield* ModelService;
  const actors = yield* ModelActorRefs;
  const machines = yield* MachineRepository;
  const configuration = yield* machines.configuration.pipe(
    Effect.mapError((error): WorkErrorBody => ({ type: "RuntimeDown", message: error.message })),
  );
  const localInstallationId = yield* machines.installationId.pipe(
    Effect.mapError((error): WorkErrorBody => ({ type: "RuntimeDown", message: error.message })),
  );
  if (sourceInstallationId !== undefined && sourceInstallationId !== localInstallationId) {
    return yield* Effect.fail<WorkErrorBody>({
      type: "ScopeError", message: "Overseer commands require an occupant on this machine.",
    });
  }
  const installationId = sourceInstallationId ?? localInstallationId;
  const stale = (error: { readonly message: string }): WorkErrorBody =>
    ({ type: "StaleNodeRef", message: error.message });
  const read: OverseerSeatRead = {
    name: caller.canvasName,
    canvas: yield* model.canvas(caller.canvasName).pipe(Effect.mapError(stale)),
    actorRefs: yield* actors.read(caller.canvasName).pipe(Effect.mapError(stale)),
  };
  const actor = yield* Effect.fromResult(resolveOverseerActor(caller, read, installationId));
  const seat = overseerSeatOf(caller, read)!;
  return {
    actor,
    installationId,
    localInstallationId,
    configuration: configuration.configuration,
    hostId: seat.host,
    bindingId: seat.bindingId,
    agentKey: seat.agentKey,
  };
});

/**
 * Revocation interrupts service awaits; every domain commit still checks live
 * authority. A notification queue is bounded because only current truth matters.
 */
export const watchOverseerRevocation = (
  caller: OverseerCaller,
  expectedActor: ActorRef,
  sourceInstallationId?: InstallationId,
): Effect.Effect<never, WorkErrorBody, ModelService | ModelActorRefs | MachineRepository> =>
  Effect.scoped(Effect.gen(function* () {
    const model = yield* ModelService;
    const changes = yield* Queue.dropping<void>(1);
    let revoked = false;
    // The seat as the command was admitted on; a change that leaves another
    // agent, session or host in it revokes, the same as taking the grant away.
    let admitted: { readonly agentKey: string; readonly bindingId: string; readonly hostId: string } | undefined;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const unsubscribeNodes = model.subscribeChanges((event) => {
          if (event.canvas === caller.canvasName) {
            const next = event.nodes.find((node) => node.id === caller.nodeId);
            // Latch revocation: a fast off/on sequence must not revive an
            // in-flight command.
            if (event.removedNodes.some((id) => id === caller.nodeId)) revoked = true;
            else if (next !== undefined && (
              next.kind !== "agent" || !next.overseer ||
              (admitted !== undefined && (
                next.agentKey !== admitted.agentKey ||
                next.bindingId !== admitted.bindingId ||
                next.host !== admitted.hostId))
            )) revoked = true;
          }
          Queue.offerUnsafe(changes, undefined);
        });
        const unsubscribeCanvases = model.subscribeCanvasesChanges((event) => {
          if (event._tag === "Removed" && event.canvas === caller.canvasName) revoked = true;
          Queue.offerUnsafe(changes, undefined);
        });
        return () => { unsubscribeNodes(); unsubscribeCanvases(); };
      }),
      (unsubscribe) => Effect.sync(unsubscribe).pipe(Effect.andThen(Queue.shutdown(changes))),
    );
    while (true) {
      const current = yield* admitOverseer(caller, sourceInstallationId);
      admitted ??= current;
      if (revoked || current.actor.seatId !== expectedActor.seatId) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "ScopeError", message: "overseer authority was revoked or replaced during the command",
        });
      }
      yield* Queue.take(changes);
    }
  }));
