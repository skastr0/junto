import type { CanvasEdge, CanvasNode } from "@shared/canvas";

/**
 * Canvas-document migration: retire operator flags.
 *
 * Manual blocker / attention / parked flags left the grammar: a seat raises
 * its own hand with `junto blocked` / `junto escalate`, and stoppage is
 * derived. Stored documents authored before that still carry:
 *
 * - `ether.flags` on nodes. Dropped. A node flagged `blocker` also carries the
 *   crimson `color: "1"` the retired mirror law forced on every save; that
 *   residue is dropped with it, so the node falls back to its kind's paint.
 * - `ether.watch.flagOnUnsatisfied` on level watchers. Dropped.
 * - `flags` edges out of a relay or cron (the retired `set_flag` effect).
 *   DROPPED, never converted: no verb the pair still holds means "mark this
 *   node", and minting an adjacent verb would grant a capability at load time
 *   the live document never had (`scrubCanvasDocInput` doctrine).
 * - `announces` edges out of a pad or sheet. Their only news was an attention
 *   flag, so the pair no longer holds the verb. Dropped the same way.
 *
 * An agent's `announces` wire into a relay survives unchanged: its compiled
 * watch now reads the seat's raised hand instead of an attention flag.
 *
 * This file is the pure plan; `canvases.ts` proves the stored bytes, applies
 * it in one authority transaction, and gates it with an install-ops marker.
 */

export const RETIRED_FLAG_VERB = "flags";
/** Kinds whose `announces` wire only ever watched an attention flag. */
const FLAG_ONLY_ANNOUNCERS: ReadonlySet<string> = new Set(["pad", "sheet"]);
/** The crimson preset the retired mirror law stamped on a blocker. */
const MIRRORED_BLOCKER_COLOR = "1";

type RawDoc = {
  readonly nodes: ReadonlyArray<CanvasNode>;
  readonly edges: ReadonlyArray<CanvasEdge>;
};

export type FlagsRetirement = {
  readonly doc: RawDoc;
  /** Nodes that lost `ether.flags` (and any mirrored blocker color). */
  readonly strippedNodeIds: ReadonlyArray<string>;
  /** Watcher nodes that lost `flagOnUnsatisfied`. */
  readonly strippedWatchIds: ReadonlyArray<string>;
  /** Edges dropped: `flags` verbs, and pad/sheet `announces`. */
  readonly removedEdgeIds: ReadonlyArray<string>;
};

type RawRecord = { readonly [key: string]: unknown };

const recordOf = (value: unknown): RawRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : undefined;

const without = (record: RawRecord, key: string): RawRecord => {
  const { [key]: _drop, ...rest } = record;
  return rest;
};

const kindOf = (node: CanvasNode | undefined): string | undefined => {
  const kind = recordOf(recordOf(recordOf(node)?.ether)?.entity)?.kind;
  return typeof kind === "string" ? kind : undefined;
};

/** Retire flags from one node; `undefined` when it carries none. */
const retireNode = (
  node: CanvasNode,
): { readonly node: CanvasNode; readonly flags: boolean; readonly watch: boolean } | undefined => {
  const ether = recordOf((node as { readonly ether?: unknown }).ether);
  if (ether === undefined) return undefined;
  const flags = ether.flags;
  const watch = recordOf(ether.watch);
  const hasFlags = flags !== undefined;
  const hasWatchFlag = watch !== undefined && "flagOnUnsatisfied" in watch;
  if (!hasFlags && !hasWatchFlag) return undefined;

  let nextEther = hasFlags ? without(ether, "flags") : ether;
  if (hasWatchFlag) nextEther = { ...nextEther, watch: without(watch, "flagOnUnsatisfied") };
  let next: RawRecord = node as unknown as RawRecord;
  const blocker = Array.isArray(flags) && flags.includes("blocker");
  if (blocker && next.color === MIRRORED_BLOCKER_COLOR) next = without(next, "color");
  next = Object.keys(nextEther).length > 0 ? { ...next, ether: nextEther } : without(next, "ether");
  return { node: next as unknown as CanvasNode, flags: hasFlags, watch: hasWatchFlag };
};

/** Plan the retirement for one raw stored document. Pure; never throws. */
export const retireFlagsFromRawDoc = (raw: RawDoc): FlagsRetirement => {
  const strippedNodeIds: string[] = [];
  const strippedWatchIds: string[] = [];
  const removedEdgeIds: string[] = [];
  const byId = new Map(raw.nodes.map((node) => [node.id, node] as const));

  const nodes = raw.nodes.map((node) => {
    const retired = retireNode(node);
    if (retired === undefined) return node;
    if (retired.flags) strippedNodeIds.push(node.id);
    if (retired.watch) strippedWatchIds.push(node.id);
    return retired.node;
  });

  const edges = raw.edges.filter((edge) => {
    const verb = recordOf((edge as { readonly ether?: unknown }).ether)?.verb;
    const retired =
      verb === RETIRED_FLAG_VERB ||
      (verb === "announces" && FLAG_ONLY_ANNOUNCERS.has(kindOf(byId.get(edge.fromNode)) ?? ""));
    if (retired) removedEdgeIds.push(edge.id);
    return !retired;
  });

  const touched = strippedNodeIds.length + strippedWatchIds.length + removedEdgeIds.length > 0;
  return {
    doc: touched ? { nodes, edges } : raw,
    strippedNodeIds,
    strippedWatchIds,
    removedEdgeIds,
  };
};

export const flagsRetirementTouches = (plan: FlagsRetirement): boolean =>
  plan.strippedNodeIds.length + plan.strippedWatchIds.length + plan.removedEdgeIds.length > 0;
