import { Data, HashMap, HashSet, Match } from "effect";
import { BROWSER_ENABLED, TASKS_ENABLED } from "../features";
import {
  isWellKnownKind,
  portSet,
  WELL_KNOWN_KINDS,
  type ActorKind,
  type FactoryRole,
  type Port,
  type SinkKind,
  type WellKnownKind,
} from "./schema";

// Kind → role + offered ports. Exhaustive over WellKnownKind.
// Roles are derived here, never read from anything authored on a node.

export type KindSpec = {
  readonly kind: WellKnownKind;
  readonly role: FactoryRole;
  readonly offers: HashSet.HashSet<Port>;
};

const emptyOffers: HashSet.HashSet<Port> = HashSet.empty();

/**
 * The actor inbox: the ports one actor offers another. Declared once so the
 * kind table and work-plane admission cannot restate and drift from the rule.
 */
export const ACTOR_ACTOR_INBOX_PORTS: ReadonlyArray<Port> = [
  "msg.list",
  "msg.send",
  "msg.prompt",
  "seat.wait",
  "terminal.read",
];

const msgOffers = portSet(...ACTOR_ACTOR_INBOX_PORTS);
// Feature-gated sink offers. A disabled feature keeps its role (historical
// rows stay decodable and render as cards) but offers no port, so every
// capability surface — CLI grants, work ops, overseer admin, station wire —
// fails closed on the same empty set. The gate lives here, at the one table
// both admission and the work vocabulary read.
const taskOffers = TASKS_ENABLED ? portSet("msg.list", "msg.send") : emptyOffers;
const pageOffers = BROWSER_ENABLED ? portSet("browser.automate") : emptyOffers;

/**
 * The role a kind carries, decided by which literal group it was written into
 * (`schema.ts`). A row cannot claim a role its kind group does not have.
 */
type RoleForKind<K extends WellKnownKind> = K extends ActorKind
  ? "actor"
  : K extends SinkKind
    ? "sink"
    : never;

type KindSpecTable = {
  readonly [K in WellKnownKind]: {
    readonly kind: K;
    readonly role: RoleForKind<K>;
    readonly offers: HashSet.HashSet<Port>;
  };
};

/**
 * Exhaustive well-known kind table. Adding a WellKnownKind without a row is a
 * type error, and so is giving a row a role its kind group does not carry
 * (`satisfies KindSpecTable`).
 */
export const KindSpecs = {
  agent: { kind: "agent", role: "actor", offers: msgOffers },
  page: { kind: "page", role: "sink", offers: pageOffers },
  task: { kind: "task", role: "sink", offers: taskOffers },
  // Artifacts offer no port: a seat publishes to the node in its reach.
  artifacts: { kind: "artifacts", role: "sink", offers: emptyOffers },
  // Automations offer no port: only the operator and overseers write them,
  // and seats read them by reach, never by an edge.
  automations: { kind: "automations", role: "sink", offers: emptyOffers },
  // Files offer no port and take no edge: seats use the filesystem, and file
  // comment threads follow reach.
  files: { kind: "files", role: "sink", offers: emptyOffers },
  // Terminal sink: tmux-like resource. Ports TBD in v1 — access family only.
  terminal: { kind: "terminal", role: "sink", offers: emptyOffers },
} as const satisfies KindSpecTable;

export const KindRegistry: HashMap.HashMap<WellKnownKind, KindSpec> =
  HashMap.fromIterable(
    WELL_KNOWN_KINDS.map((kind) => [kind, KindSpecs[kind]] as const),
  );

/**
 * What a node **is** — the sum every capability decision matches on.
 *
 * One variant per role, each carrying only the kinds that role admits. There is
 * no `role` string to compare and no kind list to re-declare: a call site that
 * cares about actors writes an `Actor` arm, and adding a kind to a role group is
 * a compile error at every non-exhaustive site.
 */
export type NodeSpec = Data.TaggedEnum<{
  Actor: {
    readonly kind: ActorKind;
    readonly offers: HashSet.HashSet<Port>;
  };
  Sink: {
    readonly kind: SinkKind;
    readonly offers: HashSet.HashSet<Port>;
  };
  Geography: {
    /** Free-form: notes, files, links, groups, and any unknown authored kind. */
    readonly kind: string | undefined;
    /** Always empty; geography offers no port. */
    readonly offers: HashSet.HashSet<Port>;
  };
}>;

export const NodeSpec = Data.taggedEnum<NodeSpec>();

/** The `Actor` variant, for call sites that prove the role before reading it. */
export type ActorSpec = Extract<NodeSpec, { readonly _tag: "Actor" }>;

export type ResolveSpecInput = {
  readonly isGroup: boolean;
  readonly kind: string | undefined;
};

/**
 * The only resolution site. Canvas node shape → NodeSpec.
 * Well-known kinds → their role variant; groups and everything else → geography.
 */
export const resolveSpec = (input: ResolveSpecInput): NodeSpec => {
  if (!input.isGroup && input.kind !== undefined && isWellKnownKind(input.kind)) {
    const spec = KindSpecs[input.kind];
    switch (spec.role) {
      case "actor":
        return NodeSpec.Actor({ kind: spec.kind, offers: spec.offers });
      case "sink":
        return NodeSpec.Sink({ kind: spec.kind, offers: spec.offers });
      default: {
        const exhaustive: never = spec;
        return exhaustive;
      }
    }
  }
  return NodeSpec.Geography({ kind: input.kind, offers: emptyOffers });
};

export const roleOf = (spec: NodeSpec): FactoryRole =>
  Match.value(spec).pipe(
    Match.tagsExhaustive({
      Actor: () => "actor" as const,
      Sink: () => "sink" as const,
      Geography: () => "geography" as const,
    }),
  );

export const offersOf = (spec: NodeSpec): HashSet.HashSet<Port> =>
  Match.value(spec).pipe(
    Match.tagsExhaustive({
      Actor: (s) => s.offers,
      Sink: (s) => s.offers,
      Geography: (s) => s.offers,
    }),
  );

export const lookupKindSpec = (
  kind: WellKnownKind,
): KindSpec => KindSpecs[kind];
