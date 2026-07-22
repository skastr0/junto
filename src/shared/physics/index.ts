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
  RolePair,
  canonicalRolePair,
  defaultGrantBetween,
  defaultGrantForRoles,
} from "./laws";
export type { RolePair as RolePairValue } from "./laws";

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
  PortForWorkOp,
  TARGET_WORK_OPS,
  isTargetWorkOp,
  portForWorkOp,
} from "./work-ports";
export type { TargetWorkOpName } from "./work-ports";

export { canvasDocToCapabilityView } from "./view";
