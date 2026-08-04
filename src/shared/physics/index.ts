// Factory physics — pure capability kernel (edges as ocaps, roles derived from kind).
// Phase (criteria) stays in execution-graph.ts. Occupancy / process-bind are live planes.

export {
  ACTOR_KINDS,
  ALL_PORTS,
  ActorKind,
  EdgeId,
  FactoryRole,
  NodeId,
  Port,
  PortGrant,
  PortMode,
  SCHEDULER_KINDS,
  SINK_KINDS,
  SchedulerKind,
  SinkKind,
  WELL_KNOWN_KINDS,
  WellKnownKind,
  asEdgeId,
  asNodeId,
  isWellKnownKind,
  portSet,
} from "./schema";
export type {
  ActorKind as ActorKindName,
  EdgeId as EdgeIdBrand,
  FactoryRole as FactoryRoleName,
  NodeId as NodeIdBrand,
  Port as PortName,
  PortMode as PortModeName,
  SchedulerKind as SchedulerKindName,
  SinkKind as SinkKindName,
  WellKnownKind as WellKnownKindName,
} from "./schema";

export {
  ACTOR_ACTOR_INBOX_PORTS,
  KindRegistry,
  KindSpecs,
  NodeSpec,
  lookupKindSpec,
  offersOf,
  resolveSpec,
  roleOf,
} from "./kinds";
export type {
  ActorSpec,
  KindSpec,
  NodeSpec as NodeSpecValue,
  ResolveSpecInput,
} from "./kinds";

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
  DEFAULT_PLACEMENT_TOPOLOGY,
  PlacementView,
  PlacementViewNull,
  RuntimePlacement,
  mapPlacementView,
  nullPlacementView,
  placementLabel,
  placementMapFromDoc,
  resolveNodePlacement,
  routeAllowed,
  sameRuntime,
} from "./placement";
export type {
  NodePlacement,
  PlacementTopology,
  PlacementViewService,
  RuntimePlacement as RuntimePlacementValue,
} from "./placement";

export {
  OPS_BY_SINK,
  PortForWorkOp,
  TARGET_WORK_OPS,
  isTargetWorkOp,
  opsForSink,
  portForWorkOp,
} from "./work-ports";
export type { TargetWorkOpName } from "./work-ports";

export { canvasDocToCapabilityView, edgeMaskAllows } from "./view";
export type { CapabilityViewOptions } from "./view";

export {
  PORTS_HIDDEN_FROM_CHIPS,
  WIRE_FAMILIES,
  WIRE_SLOTS,
  WIRE_WORDS,
  chipPortsFromOffers,
  connectCheck,
  connectable,
  defaultSlotForDraw,
  familiesForPair,
  familyColorToken,
  familyFromSlot,
  formatWireSentence,
  offerPortsForAccessWire,
  sentenceOf,
  wireRolePair,
} from "./wires";
export type {
  ConnectOk,
  ConnectRefusal,
  WireFamily,
  WireRolePair,
  WireSentence,
  WireSlot,
  WireWord,
} from "./wires";
