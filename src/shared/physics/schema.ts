import { HashSet, Schema } from "effect";

// Factory physics schema surface — pure domain brands, ports, and grants.
// No Node / Electron. Roles are derived from kind (see kinds.ts); never authorial.

// ---------------------------------------------------------------------------
// Brands

export const NodeId = Schema.String.pipe(Schema.brand("NodeId"));
export type NodeId = typeof NodeId.Type;

export const EdgeId = Schema.String.pipe(Schema.brand("EdgeId"));
export type EdgeId = typeof EdgeId.Type;

/** Trusted canvas / view ids → branded NodeId without parse overhead. */
export const asNodeId = (id: string): NodeId => id as NodeId;
export const asEdgeId = (id: string): EdgeId => id as EdgeId;

// ---------------------------------------------------------------------------
// Roles (derived, not stored)

export const FactoryRole = Schema.Literals(["actor", "sink",
"scheduler",
"geography",]);
export type FactoryRole = typeof FactoryRole.Type;

// ---------------------------------------------------------------------------
// Ports — capability facets on an edge (access plane, not phase/criteria)

export const Port = Schema.Literals(["tasks.list", "tasks.create",
"tasks.claim",
"tasks.update",
"msg.list",
"msg.send",
"msg.prompt",
"seat.wait",
"terminal.read",
"verdict.post",
/** Retired: decodable in stored edge masks; no kind offers it. */
"request.escalate",
"artifact.publish",
"browser.automate",
"board.list",
"board.create_topic",
"board.post",
"board.mark_read",
"pad.read",
"pad.patch",
/** Actor → sheet: read the operator's grid. Sheets are authored, never agent-written. */
"sheet.read",
/** Actor → relay: admit trigger (ocap path for agent-fired automation). */
"relay.trigger",]);
export type Port = typeof Port.Type;

export const ALL_PORTS: ReadonlyArray<Port> = [
  "tasks.list",
  "tasks.create",
  "tasks.claim",
  "tasks.update",
  "msg.list",
  "msg.send",
  "msg.prompt",
  "seat.wait",
  "terminal.read",
  "verdict.post",
  "request.escalate",
  "artifact.publish",
  "browser.automate",
  "board.list",
  "board.create_topic",
  "board.post",
  "board.mark_read",
  "pad.read",
  "pad.patch",
  "sheet.read",
  "relay.trigger",
];

export const portSet = (...ports: ReadonlyArray<Port>): HashSet.HashSet<Port> =>
  HashSet.fromIterable(ports);

// ---------------------------------------------------------------------------
// Well-known kinds (physics registry keys), partitioned by the role they carry.
//
// The partition is the role. A kind belongs to exactly one group, and the group
// it is written in *is* its role — `KindSpecs` cannot state a different one
// (see kinds.ts `KindSpecTable`). This is what lets `NodeSpec` narrow `kind` per
// role variant instead of every call site re-deciding from a parallel list.

// Exactly one actor kind, and it is a single literal — the invariant lives here
// at construction, not in a doc or a test. `agent` is the Junto-spawned
// template seat. Raw user terminal is a **sink** (tmux-like resource), not an actor.
// Literals (not single Literal) so `.literals` stays available for kind tables.
export const ActorKind = Schema.Literals(["agent" as const]);
export type ActorKind = typeof ActorKind.Type;

export const SinkKind = Schema.Literals(["page", "task",
"requests",
"artifacts",
"board",
"pad",
"sheet",
"terminal",]);
export type SinkKind = typeof SinkKind.Type;

/** Closed scheduler kinds. `timer` remains for decode of older docs; product UI authors `cron`. */
export const SchedulerKind = Schema.Literals(["watcher", "timer",
"cron",
"relay",]);
export type SchedulerKind = typeof SchedulerKind.Type;

export const WellKnownKind = Schema.Union([ActorKind, SinkKind, SchedulerKind]);
export type WellKnownKind = typeof WellKnownKind.Type;

export const ACTOR_KINDS: ReadonlyArray<ActorKind> = ActorKind.literals;
export const SINK_KINDS: ReadonlyArray<SinkKind> = SinkKind.literals;
export const SCHEDULER_KINDS: ReadonlyArray<SchedulerKind> =
  SchedulerKind.literals;

export const WELL_KNOWN_KINDS: ReadonlyArray<WellKnownKind> = [
  ...ACTOR_KINDS,
  ...SINK_KINDS,
  ...SCHEDULER_KINDS,
];

export const isWellKnownKind = (kind: string): kind is WellKnownKind =>
  (WELL_KNOWN_KINDS as ReadonlyArray<string>).includes(kind);

// ---------------------------------------------------------------------------
// Port grants — ocap attenuation; attenuate never expands

export const PortMode = Schema.Literals(["full", "empty", "subset"]);
export type PortMode = typeof PortMode.Type;

/**
 * Concrete or symbolic grant of ports. `full` means "all of the target's
 * offers" at admit time; `subset` is a concrete set; `empty` admits nothing.
 *
 * `attenuate(mask)` intersects — empty stays empty; full becomes the mask as
 * a subset; subset shrinks. The result never gains ports the prior grant
 * lacked (full is the sole expansion relative to offers, not relative to mask).
 */
export class PortGrant extends Schema.Class<PortGrant>("PortGrant")({
  mode: PortMode,
  ports: Schema.HashSet(Port),
}) {
  static readonly empty: PortGrant = new PortGrant({
    mode: "empty",
    ports: HashSet.empty(),
  });

  static readonly full: PortGrant = new PortGrant({
    mode: "full",
    ports: HashSet.empty(),
  });

  static subset(ports: HashSet.HashSet<Port>): PortGrant {
    if (HashSet.size(ports) === 0) return PortGrant.empty;
    return new PortGrant({ mode: "subset", ports });
  }

  static of(...ports: ReadonlyArray<Port>): PortGrant {
    return PortGrant.subset(portSet(...ports));
  }

  /**
   * Restrict this grant by a port mask. Never expands:
   * - empty ∩ mask = empty
   * - full ∩ mask = subset(mask)
   * - subset ∩ mask = subset(intersection)
   */
  attenuate(mask: HashSet.HashSet<Port>): PortGrant {
    if (this.mode === "empty") return PortGrant.empty;
    if (this.mode === "full") return PortGrant.subset(mask);
    return PortGrant.subset(HashSet.intersection(this.ports, mask));
  }

  /**
   * Whether `port` is admitted given the target's offered ports.
   * Full ⇒ any offered port; subset ⇒ port in both grant and offers; empty ⇒ never.
   */
  allows(port: Port, offers: HashSet.HashSet<Port>): boolean {
    if (!HashSet.has(offers, port)) return false;
    if (this.mode === "empty") return false;
    if (this.mode === "full") return true;
    return HashSet.has(this.ports, port);
  }

  isEmpty(): boolean {
    return this.mode === "empty";
  }

  isFull(): boolean {
    return this.mode === "full";
  }
}
