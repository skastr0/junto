/**
 * What a seat typed as a target, resolved against the nodes and items it
 * reaches. A target is a node id, a name, a `junto://` ref (03), or a task's
 * number, `#42` or `42`, read by `parseTaskNumber`. Pure: the caller supplies the candidates (today the seat's
 * wired nodes, later region reach) and whether an id names a node at all.
 *
 * A ref resolves by its node id and item; the canvas comes from context, so a
 * ref written before a canvas rename still resolves. Only a resource node
 * (`RESOURCE_KINDS`) holds items, so `&item` on any other node is refused, as
 * the mention contract refuses it. An id or a ref to a node that exists
 * resolves even when it is not a candidate: the op's own admission judges it,
 * and keeps the refusal it always gave.
 */
import type { NodeKind } from "./model/kinds";
import { parseNodeRef } from "./node-ref";
import { asNodeId, type NodeId } from "./physics/schema";
import { isResourceKind } from "./region-reach";
import type { TargetCandidate } from "./work-control";
import { parseTaskNumber } from "./task-model";
import type { ItemId, TaskNumber } from "./work-ids";

export type TypedTarget =
  | { readonly kind: "ref"; readonly nodeId: NodeId; readonly itemId?: ItemId }
  | { readonly kind: "number"; readonly number: TaskNumber }
  | { readonly kind: "word"; readonly text: string };

/** A target resolved to a node, and to an item in it when the target named one. */
export type ResolvedTarget = { readonly nodeId: NodeId; readonly itemId?: ItemId };

export type TargetResolution =
  | { readonly ok: true; readonly target: ResolvedTarget }
  /** Every candidate is listed: nothing matched. */
  | { readonly ok: false; readonly reason: "none"; readonly typed: TypedTarget; readonly candidates: ReadonlyArray<TargetCandidate> }
  /** Only the candidates that matched are listed. */
  | { readonly ok: false; readonly reason: "ambiguous"; readonly typed: TypedTarget; readonly candidates: ReadonlyArray<TargetCandidate> }
  | { readonly ok: false; readonly reason: "malformed"; readonly message: string };

/** Classify what was typed. A `junto://` text that does not parse is malformed, never a name. */
export const typedTargetOf = (
  typed: string,
): { readonly ok: true; readonly typed: TypedTarget } | { readonly ok: false; readonly message: string } => {
  const text = typed.trim();
  if (text.startsWith("junto://")) {
    const parsed = parseNodeRef(text);
    if (!parsed.ok) return { ok: false, message: `the target ref is not a Junto node ref: ${parsed.error.message}` };
    const { nodeId, itemId } = parsed.value;
    return { ok: true, typed: { kind: "ref", nodeId: asNodeId(nodeId), ...(itemId === undefined ? {} : { itemId }) } };
  }
  const number = parseTaskNumber(text);
  if (number !== undefined) return { ok: true, typed: { kind: "number", number } };
  return { ok: true, typed: { kind: "word", text } };
};

const fold = (text: string): string => text.trim().toLowerCase();

const pick = (
  typed: TypedTarget,
  all: ReadonlyArray<TargetCandidate>,
  matches: ReadonlyArray<TargetCandidate>,
): TargetResolution => {
  if (matches.length === 1) {
    const [match] = matches;
    return { ok: true, target: { nodeId: match!.nodeId, ...(match!.itemId === undefined ? {} : { itemId: match!.itemId }) } };
  }
  return matches.length === 0
    ? { ok: false, reason: "none", typed, candidates: all }
    : { ok: false, reason: "ambiguous", typed, candidates: matches };
};

export const resolveTarget = (input: {
  readonly typed: string;
  readonly candidates: ReadonlyArray<TargetCandidate>;
  /** The kind of the node this id names on the caller's canvas, or undefined when none. */
  readonly kindOf: (nodeId: string) => NodeKind | undefined;
}): TargetResolution => {
  const classified = typedTargetOf(input.typed);
  if (!classified.ok) return { ok: false, reason: "malformed", message: classified.message };
  const typed = classified.typed;
  switch (typed.kind) {
    case "ref": {
      const kind = input.kindOf(typed.nodeId);
      if (kind === undefined) return { ok: false, reason: "none", typed, candidates: input.candidates };
      if (typed.itemId !== undefined && !isResourceKind(kind)) {
        return { ok: false, reason: "malformed", message: `a ${kind} node holds no items; send the ref without &item` };
      }
      return { ok: true, target: { nodeId: typed.nodeId, ...(typed.itemId === undefined ? {} : { itemId: typed.itemId }) } };
    }
    case "number":
      return pick(typed, input.candidates, input.candidates.filter((candidate) => candidate.number === typed.number));
    case "word": {
      if (input.kindOf(typed.text) !== undefined) return { ok: true, target: { nodeId: asNodeId(typed.text) } };
      const wanted = fold(typed.text);
      if (wanted === "") return { ok: false, reason: "none", typed, candidates: input.candidates };
      const nodes = input.candidates.filter((candidate) => candidate.itemId === undefined);
      return pick(typed, input.candidates, nodes.filter((candidate) => fold(candidate.name) === wanted));
    }
  }
};
