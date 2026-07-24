import { HashMap, HashSet, Option, Schema } from "effect";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../canvas";
import { groupMembers, isGroup } from "../graph";
import type { CapabilityView, NodeMeta } from "./admit";
import { undirectedEdgeKey } from "./admit";
import { Port, asNodeId, type NodeId } from "./schema";

// Pure canvas → CapabilityView adapter. No Node, no live process-bind.

const decodePort = Schema.decodeUnknownOption(Port);

const nodeMetaOf = (node: CanvasNode): NodeMeta => ({
  kind: node.ether?.entity?.kind,
  isGroup: isGroup(node),
});

/**
 * Read edge.ether.ports into a Port set.
 * Invalid / unknown strings are skipped (fail-closed for those tokens only).
 * Absent, empty, or all-invalid → no mask (full offers).
 */
const readEdgePorts = (
  edge: CanvasEdge,
): HashSet.HashSet<Port> | undefined => {
  const ports = edge.ether?.ports;
  if (!ports || ports.length === 0) return undefined;
  let set = HashSet.empty<Port>();
  let any = false;
  for (const p of ports) {
    const decoded = decodePort(p);
    if (Option.isSome(decoded)) {
      set = HashSet.add(set, decoded.value);
      any = true;
    }
  }
  return any ? set : undefined;
};

/**
 * Build an undirected capability view from a canvas document.
 * - connected: adjacency from edges (undirected)
 * - regionPeers: group co-members (excluding self), geometry-derived
 * - nodeMeta: kind + isGroup
 * - edgePortMask: only when ether.ports is present and yields ≥1 valid Port
 */
export const canvasDocToCapabilityView = (doc: CanvasDoc): CapabilityView => {
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

  // Per undirected pair: any edge without ports ⇒ no mask (full offers).
  // When every declaring edge has ports: union masks (I7 — each edge is an
  // independent capability; possession is additive, ocap-style). `allows()`
  // in admit.ts still intersects the resulting grant with target offers, so
  // the union can never smuggle a port the target does not offer.
  const pairState = new Map<
    string,
    { unmasked: boolean; mask: HashSet.HashSet<Port> | undefined }
  >();

  for (const edge of doc.edges) {
    const a = asNodeId(edge.fromNode);
    const b = asNodeId(edge.toNode);
    addAdj(a, b);
    addAdj(b, a);

    const key = undirectedEdgeKey(edge.fromNode, edge.toNode);
    const ports = readEdgePorts(edge);
    const prev = pairState.get(key);
    if (ports === undefined) {
      pairState.set(key, { unmasked: true, mask: undefined });
      continue;
    }
    if (prev?.unmasked) continue;
    if (prev === undefined || prev.mask === undefined) {
      pairState.set(key, { unmasked: false, mask: ports });
    } else {
      pairState.set(key, {
        unmasked: false,
        mask: HashSet.union(prev.mask, ports),
      });
    }
  }

  let edgePortMask = HashMap.empty<string, HashSet.HashSet<Port>>();
  for (const [key, state] of pairState) {
    if (!state.unmasked && state.mask !== undefined) {
      edgePortMask = HashMap.set(edgePortMask, key, state.mask);
    }
  }

  let regionPeers = HashMap.empty<NodeId, HashSet.HashSet<NodeId>>();
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

  return { nodeMeta, connected, regionPeers, edgePortMask };
};
