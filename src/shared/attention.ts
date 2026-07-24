import type { A2ATask, CanvasDoc, CanvasNode } from "./canvas";
import { claimedByOf, isTerminalTaskState } from "./a2a";
import { isBlockableNode, type ExecutionGraph } from "./execution-graph";
import { resolveSpec, roleOf } from "./physics/kinds";

/**
 * Fire / ice attention language — glance layer over the factory board.
 *
 * - fire: needs human / input-required / auth-required / blocked actor with cause
 * - ice: calm capacity (actor free, no open attention on edged work)
 * - idle: present but nothing to do
 * - empty: no occupancy / no items (sink empty)
 *
 * Pure document + graph. Never invents stoppage (phase stays in execution-graph).
 */

export type AttentionSignal = "fire" | "ice" | "idle" | "empty";

const needsHuman = (item: A2ATask): boolean =>
  item.state === "input-required" || item.state === "auth-required";

const inFlight = (item: A2ATask): boolean =>
  item.state === "working" || item.state === "submitted" || needsHuman(item);

const roleOfNode = (node: CanvasNode) =>
  roleOf(
    resolveSpec({
      isGroup: node.type === "group",
      kind: node.ether?.entity?.kind,
    }),
  );

/** Sink-card glance counts (tasks / requests). */
export const sinkGlance = (
  items: ReadonlyArray<A2ATask>,
): { readonly inFlight: number; readonly needsInput: number; readonly total: number } => {
  let inFlightCount = 0;
  let needsInput = 0;
  for (const item of items) {
    if (inFlight(item)) inFlightCount += 1;
    if (needsHuman(item)) needsInput += 1;
  }
  return { inFlight: inFlightCount, needsInput, total: items.length };
};

/**
 * Per-node attention signal for chrome (`data-attention`).
 * Actors: fire when phase-blocked, ice when free with no human queue, idle otherwise.
 * Task sinks: fire when any item needs human; ice when empty or all terminal; idle when queue open but calm.
 */
export const attentionOf = (
  node: CanvasNode,
  graph: ExecutionGraph | undefined,
): AttentionSignal => {
  const role = roleOfNode(node);
  const kind = node.ether?.entity?.kind;

  if (kind === "task") {
    const items = node.ether?.tasks?.items ?? [];
    if (items.length === 0) return "empty";
    if (items.some(needsHuman)) return "fire";
    if (items.every((t) => isTerminalTaskState(t.state))) return "ice";
    return "idle";
  }

  if (kind === "requests") {
    const items = node.ether?.requests?.items ?? [];
    if (items.length === 0) return "empty";
    if (items.some(needsHuman)) return "fire";
    return "ice";
  }

  if (kind === "artifacts") {
    const items = node.ether?.artifacts?.items ?? [];
    return items.length === 0 ? "empty" : "idle";
  }

  if (role === "actor" || isBlockableNode(node)) {
    if (graph?.blocked.has(node.id)) return "fire";
    return "ice";
  }

  if (node.ether?.flags?.includes("attention")) return "fire";
  if (node.ether?.flags?.includes("blocker")) return "fire";
  if (node.ether?.flags?.includes("parked")) return "idle";

  return "idle";
};

export const workRoleOf = (node: CanvasNode | undefined): string | undefined => {
  const raw = node?.ether?.workRole;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
};

/** Worker claim identity for a seat — never "operator". */
export const workerClaimId = (node: CanvasNode): string => {
  const role = workRoleOf(node);
  if (role) return role;
  const name = node.ether?.entity?.name?.trim();
  if (name) return name;
  return node.id;
};

export const isReservedClaimActor = (actor: string): boolean => {
  const t = actor.trim().toLowerCase();
  return t.length === 0 || t === "operator" || t === "user" || t === "human";
};

export { claimedByOf, needsHuman, inFlight };
