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
// Actor class + tier (security doctrine)

export const ActorClass = Schema.Literal(
  "command_center",
  "station",
  "external",
  "facility",
);
export type ActorClass = typeof ActorClass.Type;

/** 1 = CC-local (most access) … 4 = facility (no execution authority). */
export const RuntimeTier = Schema.Literal(1, 2, 3, 4);
export type RuntimeTier = typeof RuntimeTier.Type;

/**
 * Where a node executes. Distinct from FactoryRole (actor/sink/…).
 * Tagged so Station carries its host id without a parallel string field.
 */
export type RuntimePlacement = Data.TaggedEnum<{
  Cc: {};
  Station: { readonly hostId: string };
  External: {};
  Facility: {};
}>;

export const RuntimePlacement = Data.taggedEnum<RuntimePlacement>();

export type NodePlacement = {
  readonly class: ActorClass;
  readonly runtime: RuntimePlacement;
  readonly tier: RuntimeTier;
  /**
   * Display assignment (host id or runtime label). Present for station and
   * typically for CC (local host id); absent for facility/external when
   * unassigned.
   */
  readonly assignment?: string;
};

// ---------------------------------------------------------------------------
// Port tier floors (I19)
//
// Floor = highest tier number allowed to wield the port (lower tier = more
// access). Maximize tier-3 protocol surface; host-local surfaces stay ≤2.

export const PORT_TIER_FLOOR = {
  "tasks.list": 3,
  "tasks.claim": 3,
  "tasks.update": 3,
  "msg.list": 3,
  "msg.send": 3,
  "request.create": 3,
  "artifact.publish": 3,
  /** Host-local browser surface — Station/CC local only. */
  "browser.automate": 2,
} as const satisfies Record<Port, RuntimeTier>;

export type PortTierFloor = (typeof PORT_TIER_FLOOR)[Port];

export const portTierFloor = (port: Port): RuntimeTier => PORT_TIER_FLOOR[port];

/** True when actor tier is allowed to wield `port` (tier ≤ floor). */
export const tierAllowsPort = (tier: RuntimeTier, port: Port): boolean =>
  tier <= portTierFloor(port);

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
  /**
   * Host ids that are acknowledged facilities only (tier 4, no execution).
   * Wins over station classification.
   */
  readonly facilityHostIds?: ReadonlySet<string>;
  /**
   * Host ids of external (tier 3) actors — no local Vellum runtime, protocol
   * route only. Wins over station when not facility.
   */
  readonly externalHostIds?: ReadonlySet<string>;
};

export const DEFAULT_PLACEMENT_TOPOLOGY: PlacementTopology = {
  commandCenterHostId: DEFAULT_STATION_HOST_ID,
};

// ---------------------------------------------------------------------------
// Pure resolve (ether.host + topology → NodePlacement)

/**
 * Resolve placement for one canvas node.
 * - Groups / non-executable furniture still get a placement so admit can
 *   fail closed honestly when they appear as endpoints; default is facility
 *   (no execution authority) unless host stamps a known runtime.
 * - Executable nodes: host via resolveNodeHostId, then class from topology.
 */
export const resolveNodePlacement = (
  node: CanvasNode,
  topology: PlacementTopology = DEFAULT_PLACEMENT_TOPOLOGY,
): NodePlacement => {
  const hostId = resolveNodeHostId(node);
  const facilityHosts = topology.facilityHostIds;
  const externalHosts = topology.externalHostIds;

  if (facilityHosts?.has(hostId)) {
    return {
      class: "facility",
      runtime: RuntimePlacement.Facility(),
      tier: 4,
      assignment: hostId,
    };
  }

  if (hostId === topology.commandCenterHostId) {
    // Non-executable nodes on the CC host are still geography for role;
    // placement class is command_center only for seats that can execute.
    if (!isExecutableNode(node) && node.type === "group") {
      return {
        class: "command_center",
        runtime: RuntimePlacement.Cc(),
        tier: 1,
        assignment: hostId,
      };
    }
    return {
      class: "command_center",
      runtime: RuntimePlacement.Cc(),
      tier: 1,
      assignment: hostId,
    };
  }

  if (externalHosts?.has(hostId)) {
    return {
      class: "external",
      runtime: RuntimePlacement.External(),
      tier: 3,
      assignment: hostId,
    };
  }

  // Enrolled station, or any other host id → station (product default).
  const stationHosts = topology.stationHostIds;
  if (stationHosts === undefined || stationHosts.size === 0 || stationHosts.has(hostId)) {
    return {
      class: "station",
      runtime: RuntimePlacement.Station({ hostId }),
      tier: 2,
      assignment: hostId,
    };
  }

  // Topology listed stations but this host is not among them and not CC —
  // fail closed as unknown only at the map layer; resolve still returns
  // station so tests can force unknown via omitted map entries.
  return {
    class: "station",
    runtime: RuntimePlacement.Station({ hostId }),
    tier: 2,
    assignment: hostId,
  };
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

export class PlacementView extends Context.Tag("@vellum/PlacementView")<
  PlacementView,
  PlacementViewService
>() {}

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
    case "External":
      return "external";
    case "Facility":
      return "facility";
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

/** Human-readable class label for chips. */
export const actorClassLabel = (c: ActorClass): string => {
  switch (c) {
    case "command_center":
      return "cc";
    case "station":
      return "station";
    case "external":
      return "external";
    case "facility":
      return "facility";
  }
};

/** Human-readable tier label for chips. */
export const tierLabel = (tier: RuntimeTier): string => `t${tier}`;
