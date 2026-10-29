/**
 * Moving artifacts to another Artifacts node, the window's pure parts
 * (docs/plans/0.11/10-artifact-move.md, M2): where the picker offers to move
 * to, the one line that says whose reach changes, which rows a Move to takes,
 * and how a move reads in history.
 */
import type { Canvas } from "@shared/model/canvas";
import { frameContains } from "@shared/model/canvas";
import type { Node } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import { inReachOfRegion, positionsOf } from "@shared/region-reach";

/** One place the picker offers: an Artifacts node, by its name and the regions it sits in. */
export type MoveTarget = {
  readonly id: NodeId;
  readonly title: string;
  /** The innermost regions holding it, by name; "No region" at the root. */
  readonly place: string;
  /** Why it is suggested (11 Q5), when it is. */
  readonly suggested?: string;
};

/** A node offered first, and why (11 Q5). */
export type MoveSuggestion = { readonly nodeId: NodeId; readonly why: string };

export const NO_REGION = "No region";

const byName = (a: { readonly title: string }, b: { readonly title: string }): number =>
  a.title.localeCompare(b.title, undefined, { sensitivity: "base" });

/** Where a node sits, in words: its innermost regions by name, or `NO_REGION`. */
export const placeOf = (canvas: Canvas, nodeId: NodeId): string => {
  const at = positionsOf(canvas, nodeId);
  if (at === undefined || at._tag === "Root") return NO_REGION;
  return at.innermost
    .map((id) => canvas.nodes.get(id))
    .filter((node): node is Node => node !== undefined)
    .map(titleOf)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .join(", ");
};

/** Every Artifacts node on the canvas but `from`, by name. */
export const moveTargets = (canvas: Canvas, from: NodeId): ReadonlyArray<MoveTarget> =>
  [...canvas.nodes.values()]
    .filter((node) => node.kind === "artifacts" && node.id !== from)
    .map((node) => ({ id: node.id as NodeId, title: titleOf(node), place: placeOf(canvas, node.id as NodeId) }))
    .sort(byName);

/**
 * The targets with the suggested ones first, in the order suggested, each
 * saying why; a suggestion that is not a target is dropped.
 */
export const suggestedFirst = (targets: ReadonlyArray<MoveTarget>, suggestions: ReadonlyArray<MoveSuggestion>): ReadonlyArray<MoveTarget> => {
  const first = suggestions.flatMap(({ nodeId, why }) => {
    const target = targets.find((one) => one.id === nodeId);
    return target === undefined ? [] : [{ ...target, suggested: why }];
  });
  return [...first, ...targets.filter((target) => !first.some((one) => one.id === target.id))];
};

/** The targets whose name or region holds what is typed, case blind. */
export const matchTargets = (targets: ReadonlyArray<MoveTarget>, typed: string): ReadonlyArray<MoveTarget> => {
  const query = typed.trim().toLowerCase();
  return query === ""
    ? targets
    : targets.filter((target) => target.title.toLowerCase().includes(query) || target.place.toLowerCase().includes(query));
};

/** Regions whose seats stop reaching the artifact, and regions whose seats start to, outermost only. */
export type ReachChange = { readonly lost: ReadonlyArray<string>; readonly gained: ReadonlyArray<string> };

/**
 * Whose reach a move from `from` to `to` changes. A region reaches a node by
 * region reach (src/shared/region-reach.ts): its own, those above and below
 * it, and the root. Of the regions that lose or gain it, only the outermost
 * are named: a region inside another that changes the same way goes with it.
 */
export const reachChange = (canvas: Canvas, from: NodeId, to: NodeId): ReachChange => {
  const regions = [...canvas.nodes.values()].filter((node) => node.kind === "region");
  const lost: Node[] = [];
  const gained: Node[] = [];
  for (const region of regions) {
    const reached = inReachOfRegion(canvas, region.id, (kind) => kind === "artifacts");
    const before = reached.some((node) => node.id === from);
    const after = reached.some((node) => node.id === to);
    if (before && !after) lost.push(region);
    if (after && !before) gained.push(region);
  }
  const outermost = (found: ReadonlyArray<Node>): ReadonlyArray<string> =>
    found
      .filter((inner) => !found.some((outer) => outer.id !== inner.id && frameContains(outer, inner) && !frameContains(inner, outer)))
      .map(titleOf)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return { lost: outermost(lost), gained: outermost(gained) };
};

/** "A", "A and B", "A, B and C". */
const listed = (names: ReadonlyArray<string>): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * The picker's confirm line for a move that changes reach, or null when no
 * seat's reach changes. `count` is how many artifacts move.
 */
export const reachLine = (change: ReachChange, count: number): string | null => {
  const it = count === 1 ? "this" : "these";
  if (change.lost.length > 0 && change.gained.length > 0) {
    return `Seats in ${listed(change.lost)} will no longer reach ${it}; seats in ${listed(change.gained)} will.`;
  }
  if (change.lost.length > 0) return `Seats in ${listed(change.lost)} will no longer reach ${it}.`;
  if (change.gained.length > 0) return `Seats in ${listed(change.gained)} will reach ${it} too.`;
  return null;
};

/**
 * The rows a Move to takes, in list order. From a row: the whole selection
 * when the row is in a selection of several, else that row alone. From the
 * header (`row` null): the selection.
 */
export const moveSetOf = (
  order: ReadonlyArray<string>,
  selection: ReadonlySet<string>,
  row: string | null,
): ReadonlyArray<string> => {
  if (row !== null && !(selection.has(row) && selection.size > 1)) return [row];
  return order.filter((id) => selection.has(id));
};

/** The rows from `anchor` to `to` in list order, both included; `to` alone when the anchor is not listed. */
export const rangeOf = (order: ReadonlyArray<string>, anchor: string | null, to: string): ReadonlyArray<string> => {
  const a = anchor === null ? -1 : order.indexOf(anchor);
  const b = order.indexOf(to);
  if (b === -1) return [];
  if (a === -1) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
};

/** What a finished move says in the node, once the rows have gone from it. */
export const movedLine = (titles: ReadonlyArray<string>, queued: number, to: string): string => {
  const moved = titles.length;
  const what = moved === 1 ? titles[0] : `${String(moved)} artifacts`;
  if (queued === 0) return `Moved ${what} to ${to}.`;
  if (queued === moved) return `Queued: ${what} ${moved === 1 ? "moves" : "move"} to ${to} when the editing machine rules it.`;
  return `Moved ${what} to ${to}. ${String(queued)} of them wait for the editing machine.`;
};

/** A move in history, as its row reads: "Moved from Specs to Release". */
export const moveEntryTitle = (nodeOf: (id: NodeId) => Node | undefined, from: NodeId, to: NodeId): string => {
  const name = (id: NodeId): string => {
    const node = nodeOf(id);
    return node === undefined ? "a node no longer on the canvas" : titleOf(node);
  };
  return `Moved from ${name(from)} to ${name(to)}`;
};
