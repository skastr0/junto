import type { AttentionSignal } from "@shared/attention";
import type { NodeKind } from "@shared/model";
import { resolveSpec, roleOf, seatMayBeBlocked } from "@shared/physics";

// What a node's kind means to the parts of the window that are not about any
// one kind: the verb and role tables, the stylesheet, and the card's glance.

/**
 * The kind word the verb and role tables know a node by. A note, a file, a
 * link and a region are not in them: they only sit there.
 */
export const physicsKind = (kind: NodeKind): string | undefined =>
  kind === "note" || kind === "file" || kind === "link" || kind === "region" ? undefined : kind;

const specInput = (kind: NodeKind) => ({ isGroup: kind === "region", kind: physicsKind(kind) });

/** Actor, sink, scheduler or geography. */
export const roleOfKind = (kind: NodeKind) => roleOf(resolveSpec(specInput(kind)));

/** Whether the execution graph can hold a node of this kind blocked. */
export const kindMayBeBlocked = (kind: NodeKind): boolean => seatMayBeBlocked(specInput(kind));

/**
 * The word a card carries as `data-node-kind`. The stylesheet and the specs
 * were written when a note was a text node and a region a group, and still
 * say so.
 */
export const kindWord = (kind: NodeKind): string => (kind === "note" ? "text" : kind === "region" ? "group" : kind);

/** Kinds whose card glance is read from the work they hold. */
export const holdsWork = (kind: NodeKind | undefined): boolean =>
  kind === "task" || kind === "requests" || kind === "artifacts";

/** What a card needs to know of the work a node holds: how much, and how it stands. */
export type SinkCounts = {
  readonly count: number;
  /** Some item waits on a person. */
  readonly needsHuman: boolean;
  /** Every item is finished. */
  readonly allTerminal: boolean;
};

/**
 * A card's glance (`data-attention`). A task board: empty with nothing on it,
 * fire when an item needs a human, ice when every item is finished, idle
 * otherwise. Requests: empty, fire, else ice. Artifacts: empty or idle.
 * Anything that can be blocked: fire when it is, ice when not. The rest idle.
 */
export const nodeAttention = (
  kind: NodeKind,
  glance: SinkCounts,
  blocked: boolean,
): AttentionSignal => {
  if (kind === "task") {
    if (glance.count === 0) return "empty";
    if (glance.needsHuman) return "fire";
    return glance.allTerminal ? "ice" : "idle";
  }
  if (kind === "requests") {
    if (glance.count === 0) return "empty";
    return glance.needsHuman ? "fire" : "ice";
  }
  if (kind === "artifacts") return glance.count === 0 ? "empty" : "idle";
  if (roleOfKind(kind) === "actor" || kindMayBeBlocked(kind)) return blocked ? "fire" : "ice";
  return "idle";
};
