import { Result } from "effect";
import type { ActorSeatId } from "./actor-seat";
import { resolveActorRefAt, type ActorRefResolver } from "./attention";
import type { Canvas, Placed } from "./model/canvas";
import { nodesOf } from "./model/canvas";
import type { Seat, TaskBoard } from "./model/kinds";
import { admitPure, pairIsClaimable } from "./physics";
import { canvasToCapabilityView } from "./physics/view";
import { claimedByOf } from "./task";
import { dependencyScopeIndex } from "./task-dep-scope";
import { taskIsClaimReady } from "./task-deps";
import type { Task } from "./work-model";
import type { ActorRef, SinkRef, TaskRef } from "./work-protocol";
import type { WorkRead } from "./work-read";

/**
 * Pure factory selection over the current SQLite-backed work projection.
 *
 * This module owns no mutation authority. It returns exact durable work
 * identities for the kernel to submit once through WorkService.
 */

const holdsClaim = (task: Task): boolean =>
  task.state === "working" ||
  task.state === "input-required" ||
  task.state === "auth-required";

/** Actors already holding a non-terminal claim on any task board. */
const busyActorSeatIds = (
  canvas: Placed,
  work: WorkRead,
): ReadonlySet<ActorSeatId> => {
  const busy = new Set<ActorSeatId>();
  for (const board of nodesOf(canvas, "task")) {
    for (const task of work.itemsOf(board.id)) {
      if (!holdsClaim(task)) continue;
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
 * Select one deterministic claim batch over the canvas and the work it holds.
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
 */
export const selectFactoryClaims = (
  canvas: Pick<Canvas, "nodes" | "wires">,
  work: WorkRead,
  canvasName: string,
  resolveActorRef: ActorRefResolver,
  opts?: {
    readonly actorEligible?: (actor: Seat) => boolean;
    /** Per-task actor admission, e.g. a recent operator-release grace. */
    readonly claimEligible?: (
      task: Task,
      actor: ActorRef,
      sink: TaskBoard,
    ) => boolean;
    /** Occupancy already observed outside this canvas. */
    readonly busyActorSeatIds?: ReadonlySet<ActorSeatId>;
  },
): ReadonlyArray<FactoryClaimSelection> => {
  const selections: FactoryClaimSelection[] = [];
  const busy = new Set<ActorSeatId>([
    ...busyActorSeatIds(canvas, work),
    ...(opts?.busyActorSeatIds ?? []),
  ]);
  const actorEligible = opts?.actorEligible ?? (() => true);
  const claimEligible = opts?.claimEligible ?? (() => true);
  const capabilityView = canvasToCapabilityView(canvas);

  const byNodeId = <N extends { readonly id: string }>(left: N, right: N) =>
    left.id.localeCompare(right.id);
  const sinks = [...nodesOf(canvas, "task")].sort(byNodeId);
  const seats = [...nodesOf(canvas, "agent")].sort(byNodeId);

  for (const node of sinks) {
    const items = work.itemsOf(node.id);
    const counts = new Map<string, number>();
    for (const task of items) {
      counts.set(task.id, (counts.get(task.id) ?? 0) + 1);
    }
    const byId = dependencyScopeIndex(canvas, work, node.id);
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

    const freeActors = seats
      .filter(actorEligible)
      .filter((actor) => pairIsClaimable(capabilityView, actor.id, node.id))
      .filter((actor) =>
        Result.isSuccess(
          admitPure(capabilityView, actor.id, node.id, "tasks.claim"),
        ),
      )
      .flatMap((seat) => {
        const actor = resolveActorRefAt(resolveActorRef, canvasName, seat.id);
        return actor === undefined ? [] : [{ node: seat, actor }];
      })
      .filter(({ actor }) => !busy.has(actor.seatId));

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
 * from the seat's node.
 */
export const actorsNeedingWake = (
  canvas: Pick<Canvas, "nodes" | "wires">,
  work: WorkRead,
  canvasName: string,
  resolveActorRef: ActorRefResolver,
  opts: {
    /** True when the actor needs no start — already live, or not ours. */
    readonly isAwake: (actor: Seat) => boolean;
    readonly claimEligible?: (
      task: Task,
      actor: ActorRef,
      sink: TaskBoard,
    ) => boolean;
  },
): ReadonlySet<string> => {
  const claimEligible = opts.claimEligible;
  const covered = new Set(
    selectFactoryClaims(canvas, work, canvasName, resolveActorRef, {
      ...(claimEligible ? { claimEligible } : {}),
      actorEligible: opts.isAwake,
    }).map(claimKey),
  );
  return new Set(
    selectFactoryClaims(canvas, work, canvasName, resolveActorRef, {
      ...(claimEligible ? { claimEligible } : {}),
    })
      .filter((selection) => !covered.has(claimKey(selection)))
      .map((selection) => selection.actor.nodeId),
  );
};
