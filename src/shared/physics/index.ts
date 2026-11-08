// Canvas physics — pure capability kernel (edges as ocaps, roles derived from kind).
// An edge authors one verb; every grant is compiled (verbs.ts). Phase stays in
// execution-graph.ts. Occupancy / process-bind are live planes.

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
  SINK_KINDS,
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
  OPS_BY_SINK,
  PortForWorkOp,
  TARGET_WORK_OPS,
  TASK_REACH_OPS,
  isTargetWorkOp,
  isTaskReachOp,
  opsForSink,
  portForWorkOp,
} from "./work-ports";
export type { OldTaskStoreOp, TargetWorkOpName, TaskReachOp } from "./work-ports";

export { canvasToCapabilityView } from "./view";
export type { CapabilityViewOptions, VerbCapabilityView } from "./view";

export {
  VERBS,
  VERB_COLOR_TOKEN,
  VERB_TABLE,
  TASK_PATH_VERBS,
  Verb,
  compileVerb,
  isTaskPathVerb,
  defaultVerbForPair,
  verbSideOf,
  verbsForPair,
} from "./verbs";
export type {
  TaskPathVerb,
  VerbGrant,
  VerbSide,
} from "./verbs";

export { NodeContracts, contractOf, familyColorToken } from "./contracts";
export type {
  ContractEvent,
  ContractInput,
  NodeContract,
  WireFamily,
} from "./contracts";
