import { HashMap, HashSet, Option } from "effect";
import {
  compileEdgeGrant,
  edgeKindIndex,
  type CanvasDoc,
  type CanvasNode,
} from "../canvas";
import { groupMembers, isGroup } from "../graph";
import type { CapabilityView, NodeMeta } from "./admit";
import { undirectedEdgeKey } from "./admit";
import {
  DEFAULT_PLACEMENT_TOPOLOGY,
  placementMapFromDoc,
  type NodePlacement,
  type PlacementTopology,
} from "./placement";
import { asNodeId, type NodeId, type Port } from "./schema";

// Pure canvas → CapabilityView adapter. No Node, no live process-bind.
//
// Ports are not read off the document: the edge's verb plus the two endpoint
// kinds compile them (`physics/verbs.ts`). An edge with no verb — one that
// never went through the document scrub — grants nothing, the same fail-closed
// answer an empty mask has always given.

const nodeMetaOf = (node: CanvasNode): NodeMeta => ({
  kind: node.ether?.entity?.kind,
  isGroup: isGroup(node),
});

export type CapabilityViewOptions = {
  /**
   * Fleet topology for placement resolve (I18). Default treats `local` as
   * Command Center and every other host as Station — product path without a
   * live PlacementView producer.
   */
  readonly topology?: PlacementTopology;
  /**
   * Explicit placement map. When set, replaces topology resolve (tests:
   * facility, unknown-by-omission, forced tiers).
   */
  readonly placement?: HashMap.HashMap<NodeId, NodePlacement>;
};

/**
 * The capability view plus the facts a verb grants that are not ports.
 *
 * `claimable` holds the undirected pair keys whose relationship lets the
 * factory tick hand work to the actor seat — the `works` verb says so
 * explicitly, where a port only ever said the seat *may* claim.
 */
export type VerbCapabilityView = CapabilityView & {
  readonly claimable: HashSet.HashSet<string>;
};

/**
 * Build an undirected capability view from a canvas document.
 * - connected: adjacency from edges (undirected)
 * - regionPeers: group co-members (excluding self), geometry-derived
 * - nodeMeta: kind + isGroup
 * - edgePortMask: union of the compiled grants on that undirected pair
 * - claimable: pairs whose verb lets the factory claim for the actor seat
 * - placement: from topology resolve or explicit map (I18)
 */
export const canvasDocToCapabilityView = (
  doc: CanvasDoc,
  options?: CapabilityViewOptions,
): VerbCapabilityView => {
  let nodeMeta = HashMap.empty<NodeId, NodeMeta>();
  for (const node of doc.nodes) {
    nodeMeta = HashMap.set(nodeMeta, asNodeId(node.id), nodeMetaOf(node));
  }

  let connected = HashMap.empty<NodeId, HashSet.HashSet<NodeId>>();
  const addAdj = (from: NodeId, to: NodeId): void => {
    const prev = HashMap.get(connected, from);
    const next = Option.isSome(prev)
      ? HashSet.add(prev.value, to)
      : HashSet.make(to);
    connected = HashMap.set(connected, from, next);
  };

  // Per undirected pair: union the compiled grants (I7 — each edge is an
  // independent capability; possession is additive, ocap-style). `allows()`
  // in admit.ts still intersects the resulting grant with target offers, so
  // the union can never smuggle a port the target does not offer.
  const kinds = edgeKindIndex(doc);
  const pairPorts = new Map<string, HashSet.HashSet<Port>>();
  let claimable = HashSet.empty<string>();

  for (const edge of doc.edges) {
    const a = asNodeId(edge.fromNode);
    const b = asNodeId(edge.toNode);
    addAdj(a, b);
    addAdj(b, a);

    const key = undirectedEdgeKey(edge.fromNode, edge.toNode);
    const grant = compileEdgeGrant(edge, kinds);
    const ports = HashSet.fromIterable(grant?.ports ?? []);
    const prev = pairPorts.get(key);
    pairPorts.set(key, prev === undefined ? ports : HashSet.union(prev, ports));
    if (grant?.claimable === true) {
      claimable = HashSet.add(claimable, key);
    }
  }

  let edgePortMask = HashMap.empty<string, HashSet.HashSet<Port>>();
  for (const [key, ports] of pairPorts) {
    edgePortMask = HashMap.set(edgePortMask, key, ports);
  }

  let regionPeers = HashMap.empty<NodeId, HashSet.HashSet<NodeId>>();
  // Nesting-correct as-is: a node inside an inner region is a member of every
  // container, so peers already span the whole region stack; groups stay out
  // (geography holds no seat, so a region is never a peer).
  for (const [, ids] of groupMembers(doc)) {
    for (const id of ids) {
      const nid = asNodeId(id);
      let peerSet = HashSet.empty<NodeId>();
      for (const other of ids) {
        if (other !== id) peerSet = HashSet.add(peerSet, asNodeId(other));
      }
      const existing = HashMap.get(regionPeers, nid);
      if (Option.isSome(existing)) {
        peerSet = HashSet.union(existing.value, peerSet);
      }
      regionPeers = HashMap.set(regionPeers, nid, peerSet);
    }
  }

  const placement =
    options?.placement ??
    placementMapFromDoc(doc, options?.topology ?? DEFAULT_PLACEMENT_TOPOLOGY);

  return { nodeMeta, connected, regionPeers, edgePortMask, claimable, placement };
};

/** Whether the relationship between two nodes lets the tick claim work. */
export const pairIsClaimable = (
  view: VerbCapabilityView,
  a: string,
  b: string,
): boolean => HashSet.has(view.claimable, undirectedEdgeKey(a, b));
