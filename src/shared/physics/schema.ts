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

export const FactoryRole = Schema.Literal(
  "actor",
  "sink",
  "scheduler",
  "geography",
);
export type FactoryRole = typeof FactoryRole.Type;

// ---------------------------------------------------------------------------
// Ports — capability facets on an edge (access plane, not phase/criteria)

export const Port = Schema.Literal(
  "tasks.list",
  "tasks.claim",
  "tasks.update",
  "msg.list",
  "msg.send",
  "request.create",
  "artifact.publish",
  "browser.automate",
);
export type Port = typeof Port.Type;

export const ALL_PORTS: ReadonlyArray<Port> = [
  "tasks.list",
  "tasks.claim",
  "tasks.update",
  "msg.list",
  "msg.send",
  "request.create",
  "artifact.publish",
  "browser.automate",
];

export const portSet = (...ports: ReadonlyArray<Port>): HashSet.HashSet<Port> =>
  HashSet.fromIterable(ports);

// ---------------------------------------------------------------------------
// Well-known kinds (physics registry keys)

export const WellKnownKind = Schema.Literal(
  "agent",
  "terminal",
  "herdr",
  "page",
  "task",
  "requests",
  "artifacts",
  "watcher",
  "timer",
);
export type WellKnownKind = typeof WellKnownKind.Type;

export const WELL_KNOWN_KINDS: ReadonlyArray<WellKnownKind> = [
  "agent",
  "terminal",
  "herdr",
  "page",
  "task",
  "requests",
  "artifacts",
  "watcher",
  "timer",
];

export const isWellKnownKind = (kind: string): kind is WellKnownKind =>
  (WELL_KNOWN_KINDS as ReadonlyArray<string>).includes(kind);

// ---------------------------------------------------------------------------
// Port grants — ocap attenuation; attenuate never expands

export const PortMode = Schema.Literal("full", "empty", "subset");
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
