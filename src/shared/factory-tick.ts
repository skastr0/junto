import { ulid } from "ulid";
import type { Task, CanvasDoc, CanvasNode } from "./canvas";
import { claimedByOf, makeUserMessage, taskBrief } from "./task";
import { workMessageAppend, workTaskClaim, type WorkIds } from "./work";
import { isReservedClaimActor, workRoleOf, workerClaimId } from "./attention";
import { resolveSpec, roleOf } from "./physics/kinds";

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
const busyWorkerIds = (doc: CanvasDoc): ReadonlySet<string> => {
  const busy = new Set<string>();
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
 * (or either side unassigned). Claim with workerClaimId(actor).
 * A paused seat (opts.seatPaused) neither drains as a sink nor claims as a
 * worker — the pause plane's law reaches the simulation here.
 */
export const factoryClaimTick = (
  doc: CanvasDoc,
  canvasName: string,
  ids: WorkIds = defaultIds(),
  opts?: { readonly seatPaused?: (nodeId: string) => boolean },
): { readonly doc: CanvasDoc; readonly claimed: ReadonlyArray<{ taskId: string; actor: string }> } => {
  let next = doc;
  const claimed: Array<{ taskId: string; actor: string }> = [];
  const busy = new Set(busyWorkerIds(doc));
  const isPausedSeat = opts?.seatPaused ?? (() => false);

  const byId = new Map(next.nodes.map((n) => [n.id, n] as const));

  // Undirected adjacency from edges.
  const neighbors = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const sa = neighbors.get(a) ?? new Set<string>();
    sa.add(b);
    neighbors.set(a, sa);
    const sb = neighbors.get(b) ?? new Set<string>();
    sb.add(a);
    neighbors.set(b, sb);
  };
  for (const edge of next.edges) link(edge.fromNode, edge.toNode);

  for (const node of next.nodes) {
    if (!isTaskSink(node)) continue;
    if (isPausedSeat(node.id)) continue;
    const sinkRole = workRoleOf(node);
    const items = node.ether?.tasks?.items ?? [];
    const open = items.filter((t) => t.state === "submitted" && !claimedByOf(t));
    if (open.length === 0) continue;

    const peerIds = [...(neighbors.get(node.id) ?? [])];
    const freeActors = peerIds
      .map((id) => byId.get(id))
      .filter((n): n is CanvasNode => n !== undefined && isActor(n))
      .filter((actor) => {
        const id = workerClaimId(actor);
        if (isPausedSeat(actor.id)) return false;
        if (isReservedClaimActor(id) || busy.has(id)) return false;
        const actorRole = workRoleOf(actor);
        // Match when either side unassigned, or roles equal.
        if (!sinkRole || !actorRole) return true;
        return sinkRole === actorRole;
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    for (const task of open) {
      const actor = freeActors.find((a) => !busy.has(workerClaimId(a)));
      if (!actor) break;
      const actorId = workerClaimId(actor);
      try {
        const result = workTaskClaim(next, canvasName, node.id, task.id, actorId, ids);
        next = result.doc;
        busy.add(actorId);
        claimed.push({ taskId: task.id, actor: actorId });
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
            actor.id,
            null,
            assignment,
          );
          next = nudged.doc;
        } catch {
          // Actor may not admit messages (illegal_kind) — claim still stands.
        }
        // Refresh byId for subsequent claims on same doc generation.
        for (const n of next.nodes) byId.set(n.id, n);
      } catch {
        // claim_contention / illegal — skip
      }
    }
  }

  return { doc: next, claimed };
};

export type { Task };
