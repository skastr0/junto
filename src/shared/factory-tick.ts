import { Result, HashSet } from "effect";
import type { CanvasDoc, CanvasNode } from "./canvas";
import type { Task } from "./work-model";
import type { ActorSeatId } from "./actor-seat";
import { claimedByOf } from "./task";
import { dependencyScopeIndex } from "./task-dep-scope";
import { taskIsClaimReady } from "./task-deps";
import { resolveCompiledActorRef, type ActorRefResolver } from "./attention";
import {
  admitPure,
  asNodeId,
  canvasDocToCapabilityView,
  offersOf,
  pairIsClaimable,
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
 * the factory may select. Two separate facts have to hold, and they are
 * not the same question:
 *
 * - **claimable** — the relationship puts the seat in the labor pool. Only
 *   `works` compiles it. A seat that merely `contributes` holds `tasks.claim`
 *   and may take work of its own accord; the factory never hands it any.
 * - **admitted** — the seat may actually run `tasks.claim` on this sink now:
 *   the sink offers the port, the placement route allows it, the edge is live.
 *
 * Before verbs, the port alone answered both, which made every wired seat a
 * conscript. It no longer does.
 *
 * The selector reserves a seat in-memory only for the rest of this returned
 * batch. The caller remains responsible for exactly one durable claim attempt
 * per selection. Task identities are (sink, taskId); dependsOn edges may
 * resolve to other task sinks in the same region, so claim-ready walks the
 * region-scoped index. Every result still carries both its SinkRef and
 * exact TaskRef.
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
    /** Per-task actor admission, e.g. a recent operator-release grace. */
    readonly claimEligible?: (
      task: Task,
      actor: ActorRef,
      sink: CanvasNode,
    ) => boolean;
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
  const claimEligible = opts?.claimEligible ?? (() => true);
  const capabilityView = canvasDocToCapabilityView(doc);

  const sinks = doc.nodes
    .filter(isClaimableTaskSink)
    .sort((left, right) => left.id.localeCompare(right.id));

  for (const node of sinks) {
    if (isPausedSeat(node.id)) continue;
    const items = node.ether?.tasks?.items ?? [];
    const counts = new Map<string, number>();
    for (const task of items) {
      counts.set(task.id, (counts.get(task.id) ?? 0) + 1);
    }
    const byId = dependencyScopeIndex(doc, node.id);
    const open = items
      .filter(
        (task) =>
          counts.get(task.id) === 1 &&
          task.state === "submitted" &&
          !claimedByOf(task) &&
          taskIsClaimReady(task, byId),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    if (open.length === 0) continue;

    const freeActors = doc.nodes
      .filter(isActor)
      .filter(actorEligible)
      .filter((actor) => pairIsClaimable(capabilityView, actor.id, node.id))
      .filter((actor) =>
        Result.isSuccess(
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
      .filter(
        ({ node, actor }) =>
          !isPausedSeat(node.id) && !busy.has(actor.seatId),
      )
      .sort((a, b) => a.node.id.localeCompare(b.node.id));

    for (const task of open) {
      const selected = freeActors.find(
        ({ actor: candidate }) =>
          !busy.has(candidate.seatId) &&
          claimEligible(task, candidate, node),
      );
      if (!selected) continue;
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

/** Sink-local task ids: coverage is only identical within the same sink. */
const claimKey = (selection: FactoryClaimSelection): string =>
  `${selection.sink.nodeId}\0${selection.task.itemId}`;

/**
 * Actor node ids whose process must be started for open work to move.
 *
 * A managed actor is lazy — it is a node until something wants it. Selection
 * is pure over the projection, so it answers the counterfactual directly:
 * running it once admitting only actors that are already live (`isAwake`),
 * and once admitting every actor, isolates exactly the open tasks no live
 * seat can absorb. Only the actors those tasks fall to are worth waking.
 *
 * Returns node ids rather than seat ids because the caller starts a process
 * from the canvas node's managed surface.
 */
export const actorsNeedingWake = (
  doc: CanvasDoc,
  canvasName: string,
  resolveActorRef: ActorRefResolver,
  opts: {
    /** True when the actor needs no start — already live, or not ours. */
    readonly isAwake: (actor: CanvasNode) => boolean;
    readonly seatPaused?: (nodeId: string) => boolean;
    readonly claimEligible?: (
      task: Task,
      actor: ActorRef,
      sink: CanvasNode,
    ) => boolean;
  },
): ReadonlySet<string> => {
  const seatPaused = opts.seatPaused;
  const claimEligible = opts.claimEligible;
  const covered = new Set(
    selectFactoryClaims(doc, canvasName, resolveActorRef, {
      ...(seatPaused ? { seatPaused } : {}),
      ...(claimEligible ? { claimEligible } : {}),
      actorEligible: opts.isAwake,
    }).map(claimKey),
  );
  return new Set(
    selectFactoryClaims(doc, canvasName, resolveActorRef, {
      ...(seatPaused ? { seatPaused } : {}),
      ...(claimEligible ? { claimEligible } : {}),
    })
      .filter((selection) => !covered.has(claimKey(selection)))
      .map((selection) => selection.actor.nodeId),
  );
};
