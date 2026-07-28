import { Either, HashSet } from "effect";
import type { CanvasDoc, CanvasNode } from "./canvas";
import type { ActorSeatId } from "./actor-seat";
import { claimedByOf } from "./task";
import {
  resolveCompiledActorRef,
  workRoleOf,
  type ActorRefResolver,
} from "./attention";
import {
  admitPure,
  asNodeId,
  canvasDocToCapabilityView,
  offersOf,
  resolveSpec,
  roleOf,
} from "./physics";
import type { ActorRef, SinkRef, TaskRef } from "./work-protocol";

/**
 * Pure factory selection over the current SQLite-backed work projection.
 *
 * This module owns no mutation authority. It returns exact durable work
 * identities for the kernel to submit once through WorkService.
 */

const isActor = (node: CanvasNode): boolean =>
  roleOf(
    resolveSpec({
      isGroup: node.type === "group",
      kind: node.ether?.entity?.kind,
    }),
  ) === "actor";

export const isClaimableTaskSink = (node: CanvasNode): boolean => {
  const spec = resolveSpec({
    isGroup: node.type === "group",
    kind: node.ether?.entity?.kind,
  });
  return roleOf(spec) === "sink" && HashSet.has(offersOf(spec), "tasks.claim");
};

/** Actors already holding a non-terminal claim on any task node. */
const busyActorSeatIds = (doc: CanvasDoc): ReadonlySet<ActorSeatId> => {
  const busy = new Set<ActorSeatId>();
  for (const node of doc.nodes) {
    if (!isClaimableTaskSink(node)) continue;
    for (const task of node.ether?.tasks?.items ?? []) {
      if (task.state !== "working" && task.state !== "input-required" && task.state !== "auth-required") {
        continue;
      }
      const who = claimedByOf(task);
      if (who) busy.add(who);
    }
  }
  return busy;
};

export type FactoryClaimSelection = {
  readonly sink: SinkRef;
  readonly task: TaskRef;
  readonly actor: ActorRef;
};

/**
 * Select one deterministic claim batch over the current projection.
 *
 * For each tasks sink, for each submitted unclaimed item, find a free actor
 * whose edge grants `tasks.claim` and whose workRole matches the sink's
 * workRole (or either side is unassigned).
 *
 * The selector reserves a seat in-memory only for the rest of this returned
 * batch. The caller remains responsible for exactly one durable claim attempt
 * per selection. Task IDs are sink-local, so every result carries both its
 * SinkRef and exact TaskRef.
 *
 * A paused seat (opts.seatPaused) neither drains as a sink nor claims as a
 * worker — the pause plane's law reaches the simulation here.
 */
export const selectFactoryClaims = (
  doc: CanvasDoc,
  canvasName: string,
  resolveActorRef: ActorRefResolver,
  opts?: {
    readonly seatPaused?: (nodeId: string) => boolean;
    readonly actorEligible?: (actor: CanvasNode) => boolean;
    /** Occupancy already observed outside this document. */
    readonly busyActorSeatIds?: ReadonlySet<ActorSeatId>;
  },
): ReadonlyArray<FactoryClaimSelection> => {
  const selections: FactoryClaimSelection[] = [];
  const busy = new Set<ActorSeatId>([
    ...busyActorSeatIds(doc),
    ...(opts?.busyActorSeatIds ?? []),
  ]);
  const isPausedSeat = opts?.seatPaused ?? (() => false);
  const actorEligible = opts?.actorEligible ?? (() => true);
  const capabilityView = canvasDocToCapabilityView(doc);

  const sinks = doc.nodes
    .filter(isClaimableTaskSink)
    .sort((left, right) => left.id.localeCompare(right.id));

  for (const node of sinks) {
    if (isPausedSeat(node.id)) continue;
    const sinkRole = workRoleOf(node);
    const items = node.ether?.tasks?.items ?? [];
    const counts = new Map<string, number>();
    for (const task of items) {
      counts.set(task.id, (counts.get(task.id) ?? 0) + 1);
    }
    const open = items
      .filter(
        (task) =>
          counts.get(task.id) === 1 &&
          task.state === "submitted" &&
          !claimedByOf(task),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    if (open.length === 0) continue;

    const freeActors = doc.nodes
      .filter(isActor)
      .filter(actorEligible)
      .filter((actor) =>
        Either.isRight(
          admitPure(
            capabilityView,
            asNodeId(actor.id),
            asNodeId(node.id),
            "tasks.claim",
          ),
        )
      )
      .flatMap((node) => {
        const actor = resolveCompiledActorRef(
          resolveActorRef,
          canvasName,
          node,
        );
        return actor === undefined ? [] : [{ node, actor }];
      })
      .filter(({ node, actor }) => {
        if (isPausedSeat(node.id)) return false;
        if (busy.has(actor.seatId)) return false;
        const actorRole = workRoleOf(node);
        // Match when either side unassigned, or roles equal.
        if (!sinkRole || !actorRole) return true;
        return sinkRole === actorRole;
      })
      .sort((a, b) => a.node.id.localeCompare(b.node.id));

    for (const task of open) {
      const selected = freeActors.find(
        ({ actor: candidate }) => !busy.has(candidate.seatId),
      );
      if (!selected) break;
      const sink = { canvasName, nodeId: node.id } satisfies SinkRef;
      const taskRef = {
        kind: "task",
        itemId: task.id,
        sink,
      } satisfies TaskRef;
      busy.add(selected.actor.seatId);
      selections.push({ sink, task: taskRef, actor: selected.actor });
    }
  }

  return selections;
};
