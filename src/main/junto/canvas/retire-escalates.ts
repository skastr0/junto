import type { CanvasEdge, CanvasNode } from "@shared/canvas";

/**
 * Canvas-document migration: retire the agent -> requests `escalates` verb.
 *
 * Raising a hand became universal (`junto escalate`, `blocked`, `feedback`),
 * so the verb and its `request.escalate` port left the grammar. Stored
 * documents authored before that still carry them. The edge is DROPPED, never
 * converted: the canvas doctrine (`scrubCanvasDocInput`) refuses to turn an
 * edge its pair can no longer hold into an adjacent verb, because that would
 * mint a capability at load time the live document never had. `messages` is
 * not a verb agent -> requests can hold, so there is nothing to convert to.
 *
 * A surviving edge whose operator mask names the retired port keeps its mask
 * minus that port. The port granted nothing, so removing it narrows nothing.
 *
 * This file is the pure plan; `canvases.ts` proves the stored bytes, applies
 * it in one authority transaction, and gates it with an install-ops marker.
 */

export const RETIRED_EDGE_VERB = "escalates";
export const RETIRED_PORT = "request.escalate";

type RawDoc = {
  readonly nodes: ReadonlyArray<CanvasNode>;
  readonly edges: ReadonlyArray<CanvasEdge>;
};

export type EscalatesRetirement = {
  readonly doc: RawDoc;
  /** Edges dropped because they carried the retired verb. */
  readonly removedEdgeIds: ReadonlyArray<string>;
  /** Surviving edges whose mask lost the retired port. */
  readonly narrowedEdgeIds: ReadonlyArray<string>;
};

type RawEther = {
  readonly verb?: unknown;
  readonly mask?: unknown;
  readonly [key: string]: unknown;
};

const etherOf = (edge: CanvasEdge): RawEther | undefined => {
  const ether = (edge as { readonly ether?: unknown }).ether;
  return ether !== null && typeof ether === "object" && !Array.isArray(ether)
    ? (ether as RawEther)
    : undefined;
};

/** Plan the retirement for one raw stored document. Pure; never throws. */
export const retireEscalatesFromRawDoc = (raw: RawDoc): EscalatesRetirement => {
  const removedEdgeIds: string[] = [];
  const narrowedEdgeIds: string[] = [];
  const edges: CanvasEdge[] = [];
  for (const edge of raw.edges) {
    const ether = etherOf(edge);
    if (ether?.verb === RETIRED_EDGE_VERB) {
      removedEdgeIds.push(edge.id);
      continue;
    }
    if (Array.isArray(ether?.mask) && ether.mask.includes(RETIRED_PORT)) {
      narrowedEdgeIds.push(edge.id);
      edges.push({
        ...edge,
        ether: {
          ...ether,
          mask: ether.mask.filter((port) => port !== RETIRED_PORT),
        },
      } as CanvasEdge);
      continue;
    }
    edges.push(edge);
  }
  return {
    doc: removedEdgeIds.length + narrowedEdgeIds.length === 0
      ? raw
      : { nodes: raw.nodes, edges },
    removedEdgeIds,
    narrowedEdgeIds,
  };
};

export const retirementTouches = (plan: EscalatesRetirement): boolean =>
  plan.removedEdgeIds.length + plan.narrowedEdgeIds.length > 0;
