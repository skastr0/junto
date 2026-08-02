import { Context, Data, HashMap, Layer, Schema } from "effect";
import type { CanvasDoc, CanvasNode } from "../canvas";
import {
  DEFAULT_STATION_HOST_ID,
  isExecutableNode,
  resolveNodeHostId,
} from "../station";
import { asNodeId, type NodeId, type Port } from "./schema";

// Placement plane (I18/I19) — inter-runtime half of admit.
// Roles stay kind-derived (I1); placement is a third admit input alongside
// connectivity and offers, never a fourth role or ACL table.
//
// Pattern matches occupancy ActivityFeed: typed service + null producer here;
// fleet-lane producers bind topology later without touching consumers.

// ---------------------------------------------------------------------------
// Where a node runs
//
// Placement is DATA, not a permission axis. It says which machine hosts the
// node; it never decides which ports the node may wield — that is the role-pair
// law crossed with kind-declared offers and the authorial mask. There is no
// tier scale and no actor class.

export type RuntimePlacement = Data.TaggedEnum<{
  Cc: {};
  Station: { readonly hostId: string };
}>;

export const RuntimePlacement = Data.taggedEnum<RuntimePlacement>();

export type NodePlacement = {
  readonly runtime: RuntimePlacement;
  /** Display assignment (host id). */
  readonly assignment?: string;
};

// ---------------------------------------------------------------------------
// Topology inputs (pure; no live CC reachability)

/**
 * Fleet topology snapshot for resolving placement from ether.host.
 * Producers supply enrolled stations; null/default treats only the CC host
 * as known Command Center and every other host id as a Station.
 */
export type PlacementTopology = {
  /** Host id of the Command Center runtime (default: "local"). */
  readonly commandCenterHostId: string;
  /**
   * Enrolled Station host ids. When empty, any non-CC host is still treated
   * as `station(hostId)` so multi-host canvases classify without a fleet
   * registry (honest station class; route checks still apply).
   */
  readonly stationHostIds?: ReadonlySet<string>;
};

export const DEFAULT_PLACEMENT_TOPOLOGY: PlacementTopology = {
  commandCenterHostId: DEFAULT_STATION_HOST_ID,
};

// ---------------------------------------------------------------------------
// Pure resolve (ether.host + topology → NodePlacement)

/**
 * Resolve placement for one canvas node: which machine hosts it. The CC host
 * is `Cc`; every other host id is a `Station`. Nothing here gates a port.
 */
export const resolveNodePlacement = (
  node: CanvasNode,
  topology: PlacementTopology = DEFAULT_PLACEMENT_TOPOLOGY,
): NodePlacement => {
  const hostId = resolveNodeHostId(node);
  if (hostId === topology.commandCenterHostId) {
    return { runtime: RuntimePlacement.Cc(), assignment: hostId };
  }
  return { runtime: RuntimePlacement.Station({ hostId }), assignment: hostId };
};

/** Build the admit placement map for a document under a topology. */
export const placementMapFromDoc = (
  doc: CanvasDoc,
  topology: PlacementTopology = DEFAULT_PLACEMENT_TOPOLOGY,
): HashMap.HashMap<NodeId, NodePlacement> => {
  let map = HashMap.empty<NodeId, NodePlacement>();
  for (const node of doc.nodes) {
    map = HashMap.set(map, asNodeId(node.id), resolveNodePlacement(node, topology));
  }
  return map;
};

// ---------------------------------------------------------------------------
// PlacementView seam (interface + null producer)

export interface PlacementViewService {
  /**
   * Placement for one node. `undefined` = unknown (stale / missing projection)
   * → admit fails closed with placement_unknown.
   */
  readonly placementFor: (nodeId: string) => NodePlacement | undefined;
}

export class PlacementView extends Context.Service<PlacementView,
  PlacementViewService>()("@vellum/PlacementView") {}

/** Everything unknown — shippable default before a fleet producer binds. */
export const nullPlacementView: PlacementViewService = {
  placementFor: () => undefined,
};

export const PlacementViewNull = Layer.succeed(PlacementView, nullPlacementView);

/** Pure map-backed producer (tests + pure admit view). */
export const mapPlacementView = (
  map: HashMap.HashMap<NodeId, NodePlacement>,
): PlacementViewService => ({
  placementFor: (nodeId) => {
    const opt = HashMap.get(map, asNodeId(nodeId));
    return opt._tag === "Some" ? opt.value : undefined;
  },
});

// ---------------------------------------------------------------------------
// Route physics (pure)

const runtimeKey = (runtime: RuntimePlacement): string => {
  switch (runtime._tag) {
    case "Cc":
      return "cc";
    case "Station":
      return `station:${runtime.hostId}`;
  }
};

export const sameRuntime = (a: RuntimePlacement, b: RuntimePlacement): boolean =>
  runtimeKey(a) === runtimeKey(b);

/**
 * Cross-runtime routes must be CC↔Station only.
 * Same runtime always ok. Station↔Station and other pairs denied.
 */
export const routeAllowed = (
  caller: NodePlacement,
  target: NodePlacement,
): boolean => {
  if (sameRuntime(caller.runtime, target.runtime)) return true;
  const tags = new Set([caller.runtime._tag, target.runtime._tag]);
  return tags.has("Cc") && tags.has("Station");
};

/** Human-readable placement label for chips. */
export const placementLabel = (placement: NodePlacement): string =>
  placement.runtime._tag === "Station"
    ? `station:${placement.runtime.hostId}`
    : "cc";
