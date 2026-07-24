// Factory physics — pure capability kernel (edges as ocaps, roles derived from kind).
// Phase (criteria) stays in execution-graph.ts. Occupancy / process-bind are live planes.

export {
  ALL_PORTS,
  EdgeId,
  FactoryRole,
  NodeId,
  Port,
  PortGrant,
  PortMode,
  WELL_KNOWN_KINDS,
  WellKnownKind,
  asEdgeId,
  asNodeId,
  isWellKnownKind,
  portSet,
} from "./schema";
export type {
  EdgeId as EdgeIdBrand,
  FactoryRole as FactoryRoleName,
  NodeId as NodeIdBrand,
  Port as PortName,
  PortMode as PortModeName,
  WellKnownKind as WellKnownKindName,
} from "./schema";

export {
  KindRegistry,
  KindSpecs,
  ResolvedSpec,
  lookupKindSpec,
  offersOf,
  resolveSpec,
  roleOf,
} from "./kinds";
export type { KindSpec, ResolveSpecInput, ResolvedSpec as ResolvedSpecValue } from "./kinds";

export {
  GrantLaw,
  RolePair,
  canonicalRolePair,
  grantLawBetween,
  grantLawForRoles,
  selectGrant,
  selectGrantFromOption,
} from "./laws";
export type {
  GrantLaw as GrantLawValue,
  RolePair as RolePairValue,
} from "./laws";

export {
  kindsWithRole,
  roleMayBeBlocked,
  seatMayBeBlocked,
} from "./phase-membership";

export {
  ACTOR_ACTOR_INBOX_PORTS,
  stampActorActorMsgPorts,
} from "./stamp";

export {
  Granted,
  ScopeDenial,
  ScopeDenialReason,
  admit,
  admitPure,
  undirectedEdgeKey,
} from "./admit";
export type {
  CapabilityView,
  NodeMeta,
  ScopeDenialReason as ScopeDenialReasonName,
} from "./admit";

export {
  ActorClass,
  DEFAULT_PLACEMENT_TOPOLOGY,
  PORT_TIER_FLOOR,
  PlacementView,
  PlacementViewNull,
  RuntimePlacement,
  RuntimeTier,
  actorClassLabel,
  mapPlacementView,
  nullPlacementView,
  placementMapFromDoc,
  portTierFloor,
  resolveNodePlacement,
  routeAllowed,
  sameRuntime,
  tierAllowsPort,
  tierLabel,
} from "./placement";
export type {
  ActorClass as ActorClassName,
  NodePlacement,
  PlacementTopology,
  PlacementViewService,
  RuntimePlacement as RuntimePlacementValue,
  RuntimeTier as RuntimeTierValue,
} from "./placement";

export {
  PortForWorkOp,
  TARGET_WORK_OPS,
  isTargetWorkOp,
  portForWorkOp,
} from "./work-ports";
export type { TargetWorkOpName } from "./work-ports";

export { canvasDocToCapabilityView } from "./view";
export type { CapabilityViewOptions } from "./view";
