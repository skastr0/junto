import { HashMap, HashSet, Option } from "effect";
import type { Canvas } from "../model/canvas";
import { nodesOf, regionMembers } from "../model/canvas";
import type { Node } from "../model/kinds";
import { wireGrant, type Wire } from "../model/wire";
import { RESOURCE_KINDS, isResourceKind, onOneLine, positionsOf, type Positions } from "../region-reach";
import type { CapabilityView, NodeMeta } from "./admit";
import { directedEdgeKey, undirectedEdgeKey } from "./admit";
import { asNodeId, type NodeId, type Port } from "./schema";

// Pure canvas → CapabilityView adapter. No Node, no live process-bind.
//
// A seat reaches resource nodes by where it sits, worked out from the
// rectangles each time a view is made. Between other nodes, the verb plus
// endpoint kinds compile ports; an operator mask may only remove them. A wire
// whose two kinds cannot hold its verb grants nothing, the same fail-closed
// answer an empty mask has always given.

export type CapabilityViewOptions = {
  /**
   * The machine that edits this canvas. A kind that stays with the canvas (a
   * board, a note, a region) names no machine of its own and is on this one.
   */
  readonly editingMachine: string;
};

/** The capability view a canvas compiles to. */
export type VerbCapabilityView = CapabilityView;

/** A note, a file and a link are plain things: they have no kind to offer. */
const metaOfNode = (node: Node): NodeMeta =>
  node.kind === "region"
    ? { kind: undefined, isGroup: true }
    : node.kind === "peer"
      // Another machine's seat: an actor for the role law and for what a wire
      // to it compiles, marked so admission lets it be mailed and nothing else.
      ? { kind: "agent", isGroup: false, peer: true }
    : {
        kind:
          node.kind === "note" || node.kind === "file" || node.kind === "link"
            ? undefined
            : node.kind,
        isGroup: false,
      };

/**
 * The same view from a canvas. A node's machine is the name on its row; a
 * node that carries none is on the machine that edits the canvas.
 */
export const canvasToCapabilityView = (
  canvas: Pick<Canvas, "nodes" | "wires">,
  options: CapabilityViewOptions,
): VerbCapabilityView => {
  let nodeMeta = HashMap.empty<NodeId, NodeMeta>();
  let machine = HashMap.empty<NodeId, string>();
  const kinds = new Map<string, string>();
  for (const node of canvas.nodes.values()) {
    nodeMeta = HashMap.set(nodeMeta, node.id, metaOfNode(node));
    if (node.kind !== "region") kinds.set(node.id, node.kind === "peer" ? "agent" : node.kind);
    machine = HashMap.set(machine, node.id, ("host" in node ? node.host : undefined) ?? options.editingMachine);
  }
  const joins: Array<Join> = [];
  for (const wire of canvas.wires.values()) {
    joins.push({ from: wire.from, to: wire.to, wire });
  }
  return viewOf({
    nodeMeta,
    kinds,
    joins,
    regions: nodesOf(canvas, "region").map((region) =>
      regionMembers(canvas, region).map((node) => node.id),
    ),
    machine,
    reach: reachOf(canvas),
  });
};

/**
 * The resource nodes each seat reaches: `resourcesInReach` for every seat at
 * once, so each node's positions are worked out a single time.
 */
const reachOf = (
  canvas: Pick<Canvas, "nodes">,
): HashMap.HashMap<NodeId, HashSet.HashSet<NodeId>> => {
  const resources: Array<readonly [NodeId, Positions]> = [];
  const seats: Array<readonly [NodeId, Positions]> = [];
  for (const node of canvas.nodes.values()) {
    const into = node.kind === "agent" ? seats : isResourceKind(node.kind) ? resources : undefined;
    const at = into === undefined ? undefined : positionsOf(canvas, node.id);
    if (into !== undefined && at !== undefined) into.push([node.id, at]);
  }
  let reach = HashMap.empty<NodeId, HashSet.HashSet<NodeId>>();
  for (const [seat, seatAt] of seats) {
    const reached = resources.filter(([, at]) => onOneLine(canvas, seatAt, at)).map(([id]) => id);
    reach = HashMap.set(reach, seat, HashSet.fromIterable(reached));
  }
  return reach;
};

type Join = {
  readonly from: string;
  readonly to: string;
  /** Nothing when the join is not a wire: it still makes its ends adjacent. */
  readonly wire: Wire | undefined;
};

const viewOf = (input: {
  readonly nodeMeta: HashMap.HashMap<NodeId, NodeMeta>;
  /** The kind at each end a grant can reach. */
  readonly kinds: ReadonlyMap<string, string>;
  readonly joins: Iterable<Join>;
  /** The members of each region, regions themselves left out. */
  readonly regions: Iterable<ReadonlyArray<string>>;
  readonly machine: HashMap.HashMap<NodeId, string>;
  readonly reach: HashMap.HashMap<NodeId, HashSet.HashSet<NodeId>>;
}): VerbCapabilityView => {
  const { nodeMeta, kinds, machine, reach } = input;

  const resourceAt = (id: string): boolean => {
    const kind = kinds.get(id);
    return kind !== undefined && (RESOURCE_KINDS as ReadonlyArray<string>).includes(kind);
  };

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
  const pairPorts = new Map<string, HashSet.HashSet<Port>>();
  let directedEdgePortMask = HashMap.empty<string, HashSet.HashSet<Port>>();

  for (const { from, to, wire } of input.joins) {
    const a = asNodeId(from);
    const b = asNodeId(to);
    addAdj(a, b);
    addAdj(b, a);

    const key = undirectedEdgeKey(from, to);
    const grant = wire === undefined ? undefined : wireGrant(wire, kinds);
    const ports = HashSet.fromIterable(
      (grant?.ports ?? []).filter((port) => port !== "verdict.post"),
    );
    if (wire?.verb === "reviews" && grant?.ports.includes("verdict.post")) {
      const directedKey = directedEdgeKey(from, to);
      const prior = HashMap.get(directedEdgePortMask, directedKey);
      directedEdgePortMask = HashMap.set(
        directedEdgePortMask,
        directedKey,
        HashSet.add(Option.getOrElse(prior, () => HashSet.empty<Port>()), "verdict.post"),
      );
    }
    // A resource node is reached, never granted by a wire, so a wire to one
    // carries no mask.
    if (!resourceAt(from) && !resourceAt(to)) {
      const prev = pairPorts.get(key);
      pairPorts.set(key, prev === undefined ? ports : HashSet.union(prev, ports));
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
  for (const ids of input.regions) {
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

  return { nodeMeta, connected, regionPeers, edgePortMask, directedEdgePortMask, machine, reach };
};
