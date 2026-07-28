import { ulid } from "ulid";
import { Either } from "effect";
import type { Task, CanvasDoc, CanvasNode } from "./canvas";
import type { ActorSeatId } from "./actor-seat";
import { claimedByOf, makeUserMessage, taskBrief } from "./task";
import { workMessageAppend, workTaskClaim, type WorkIds } from "./work";
import {
  resolveCompiledActorRef,
  workRoleOf,
  type ActorRefResolver,
} from "./attention";
import {
  admitPure,
  asNodeId,
  canvasDocToCapabilityView,
  resolveSpec,
  roleOf,
} from "./physics";
import type { ActorRef } from "./work-protocol";

/**
 * Document-level claim simulation: role-matched free edged actors pull
 * submitted tasks. Real harness execution is a later plugin; this makes
 * the queue breathe without it.
 *
 * Pure: (doc) → doc. Call from a deliberate tick / UI "run tick" action.
 */

const isActor = (node: CanvasNode): boolean =>
  roleOf(
    resolveSpec({
      isGroup: node.type === "group",
      kind: node.ether?.entity?.kind,
    }),
  ) === "actor";

const isTaskSink = (node: CanvasNode): boolean => node.ether?.entity?.kind === "task";

/** Actors already holding a non-terminal claim on any task node. */
const busyActorSeatIds = (doc: CanvasDoc): ReadonlySet<ActorSeatId> => {
  const busy = new Set<ActorSeatId>();
  for (const node of doc.nodes) {
    if (!isTaskSink(node)) continue;
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

const defaultIds = (): WorkIds => ({
  id: () => ulid(),
  messageId: () => ulid(),
});

/**
 * One claim tick over the document.
 * For each tasks sink, for each submitted unclaimed item, find a free actor
 * edged to that sink (undirected) whose workRole matches the sink's workRole
 * (or either side unassigned). Claim with its compiled ActorRef.
 * A paused seat (opts.seatPaused) neither drains as a sink nor claims as a
 * worker — the pause plane's law reaches the simulation here.
 */
export const factoryClaimTick = (
  doc: CanvasDoc,
  canvasName: string,
  resolveActorRef: ActorRefResolver,
  ids: WorkIds = defaultIds(),
  opts?: {
    readonly seatPaused?: (nodeId: string) => boolean;
    readonly actorEligible?: (actor: CanvasNode) => boolean;
    /** Occupancy already observed outside this document. */
    readonly busyActorSeatIds?: ReadonlySet<ActorSeatId>;
  },
): {
  readonly doc: CanvasDoc;
  readonly claimed: ReadonlyArray<{
    readonly taskId: string;
    readonly actor: ActorRef;
  }>;
} => {
  let next = doc;
  const claimed: Array<{ taskId: string; actor: ActorRef }> = [];
  const busy = new Set<ActorSeatId>([
    ...busyActorSeatIds(doc),
    ...(opts?.busyActorSeatIds ?? []),
  ]);
  const isPausedSeat = opts?.seatPaused ?? (() => false);
  const actorEligible = opts?.actorEligible ?? (() => true);
  const capabilityView = canvasDocToCapabilityView(doc);

  for (const node of next.nodes) {
    if (!isTaskSink(node)) continue;
    if (isPausedSeat(node.id)) continue;
    const sinkRole = workRoleOf(node);
    const items = node.ether?.tasks?.items ?? [];
    const open = items.filter((t) => t.state === "submitted" && !claimedByOf(t));
    if (open.length === 0) continue;

    const freeActors = next.nodes
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
      const actor = freeActors.find(
        ({ actor: candidate }) => !busy.has(candidate.seatId),
      );
      if (!actor) break;
      try {
        const result = workTaskClaim(
          next,
          canvasName,
          node.id,
          task.id,
          actor.actor,
          ids,
        );
        next = result.doc;
        busy.add(actor.actor.seatId);
        claimed.push({ taskId: task.id, actor: actor.actor });
        // Nudge the managed seat: assignment lands on ether.messages so the
        // idle-gated drive transport can type it into the live TUI.
        // Task history alone is never auto-delivered (work plane law).
        try {
          const brief = taskBrief(result.task);
          const assignment = makeUserMessage({
            messageId: ids.messageId(),
            text: [
              `[factory claim] task ${task.id}: ${brief}`,
              "",
              "You claimed this task from the factory pull queue.",
              "1. Run `vellum onboard` (and again after compaction).",
              "2. Do the work. Update with `vellum tasks update` when done.",
              "3. If blocked on a human, `vellum escalate` (or request create).",
            ].join("\n"),
            contextId: canvasName,
            taskId: task.id,
          });
          const nudged = workMessageAppend(
            next,
            canvasName,
            actor.node.id,
            null,
            assignment,
          );
          next = nudged.doc;
        } catch {
          // Actor may not admit messages (illegal_kind) — claim still stands.
        }
      } catch {
        // claim_contention / illegal — skip
      }
    }
  }

  return { doc: next, claimed };
};

export type { Task };
