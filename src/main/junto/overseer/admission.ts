import { Effect, Queue, Result } from "effect";
import { isManagedAgentNode } from "@shared/actor-surface";
import type { CanvasReadResult } from "@shared/ipc";
import type { OverseerCaller } from "@shared/overseer-control";
import { resolveNodeHostId } from "@shared/station";
import type { InstallationId } from "@shared/station-api";
import type { ActorRef } from "@shared/work-reference";
import type { WorkErrorBody } from "@shared/work-control";
import { CanvasesService } from "../canvases";
import { deriveActorSeatId } from "../station/actor-seat-compiler";
import { StationRepository } from "../station/repository";

/** Installation evidence comes from local process admission or a paired peer. */
export const resolveOverseerActor = (
  caller: OverseerCaller,
  read: CanvasReadResult,
  sourceInstallationId: InstallationId,
): Result.Result<ActorRef, WorkErrorBody> => {
  const node = read.doc.nodes.find((candidate) => candidate.id === caller.nodeId);
  if (read.name !== caller.canvasName || node === undefined ||
    !isManagedAgentNode(node) || node.ether.overseer !== true) {
    return Result.fail({
      type: "ScopeError",
      message: "the caller no longer has human-granted overseer authority",
      details: { retryable: false, caller: caller.nodeId },
    });
  }
  const refs = read.actorRefs.filter((actor) =>
    actor.canvasName === caller.canvasName && actor.nodeId === caller.nodeId);
  const expectedSeat = deriveActorSeatId(sourceInstallationId, node.ether.terminal.bindingId);
  if (refs.length !== 1 || refs[0]!.seatId !== expectedSeat) {
    return Result.fail({
      type: "ScopeError",
      message: "overseer caller does not belong to the authenticated installation",
      details: { retryable: false, caller: caller.nodeId },
    });
  }
  return Result.succeed(refs[0]!);
};

/** Re-evaluated for every invocation and after authorial change notifications. */
export const admitOverseer = Effect.fn("overseer.admit")(function* (
  caller: OverseerCaller,
  sourceInstallationId?: InstallationId,
) {
  const canvases = yield* CanvasesService;
  const stations = yield* StationRepository;
  const configuration = yield* stations.configuration.pipe(
    Effect.mapError((error): WorkErrorBody => ({ type: "RuntimeDown", message: error.message })),
  );
  if (configuration === undefined) {
    return yield* Effect.fail<WorkErrorBody>({
      type: "RuntimeDown", message: "configure this installation before using overseer commands",
    });
  }
  const localInstallationId = yield* stations.installationId.pipe(
    Effect.mapError((error): WorkErrorBody => ({ type: "RuntimeDown", message: error.message })),
  );
  if (sourceInstallationId !== undefined && configuration.configuration.role !== "command-center") {
    return yield* Effect.fail<WorkErrorBody>({
      type: "ScopeError", message: "only Command Center accepts Remote overseer commands",
    });
  }
  const installationId = sourceInstallationId ?? localInstallationId;
  const read = yield* canvases.read(caller.canvasName, "work.control").pipe(
    Effect.mapError((error): WorkErrorBody => ({ type: "StaleNodeRef", message: error.message })),
  );
  const actor = yield* Effect.fromResult(resolveOverseerActor(caller, read, installationId));
  const node = read.doc.nodes.find((candidate) => candidate.id === caller.nodeId)!;
  return {
    actor,
    installationId,
    localInstallationId,
    configuration: configuration.configuration,
    hostId: resolveNodeHostId(node),
    bindingId: node.ether!.terminal!.bindingId,
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
): Effect.Effect<never, WorkErrorBody, CanvasesService | StationRepository> =>
  Effect.scoped(Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const changes = yield* Queue.dropping<void>(1);
    let revoked = false;
    yield* Effect.acquireRelease(
      Effect.sync(() => canvases.subscribeChanges((name, detail) => {
        if (name === caller.canvasName && detail !== undefined) {
          const next = detail.next?.nodes.find((node) => node.id === caller.nodeId);
          const previous = detail.previous?.nodes.find((node) => node.id === caller.nodeId);
          // Latch revocation: a fast off/on sequence must not revive an
          // in-flight command. Work invalidations carry no authorial diff;
          // they trigger a live recheck rather than revoking the grant.
          if (next === undefined || !isManagedAgentNode(next) ||
            next.ether.overseer !== true || previous === undefined ||
            previous.ether?.entity?.name !== next.ether.entity.name ||
            previous.ether?.terminal?.bindingId !== next.ether.terminal.bindingId ||
            resolveNodeHostId(previous) !== resolveNodeHostId(next)) revoked = true;
        }
        Queue.offerUnsafe(changes, undefined);
      })),
      (unsubscribe) => Effect.sync(unsubscribe).pipe(Effect.andThen(Queue.shutdown(changes))),
    );
    while (true) {
      const current = yield* admitOverseer(caller, sourceInstallationId);
      if (revoked || current.actor.seatId !== expectedActor.seatId) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "ScopeError", message: "overseer authority was revoked or replaced during the command",
        });
      }
      yield* Queue.take(changes);
    }
  }));
