import { Data, HashMap, HashSet, Match } from "effect";
import {
  ARTIFACTS_ENABLED,
  BOARD_ENABLED,
  BROWSER_ENABLED,
  PAD_ENABLED,
  REQUESTS_ENABLED,
  SHEET_ENABLED,
  TASKS_ENABLED,
} from "../features";
import {
  isWellKnownKind,
  portSet,
  WELL_KNOWN_KINDS,
  type ActorKind,
  type FactoryRole,
  type Port,
  type SchedulerKind,
  type SinkKind,
  type WellKnownKind,
} from "./schema";

// Kind → role + offered ports. Exhaustive over WellKnownKind.
// Roles are derived here — never read from authorial ether.role.

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
  "verdict.post",
];

// Verdicts review the work of a task board; without the tasks surface the
// port has no runnable target, so it leaves the actor inbox with the gate.
const msgOffers = portSet(
  ...ACTOR_ACTOR_INBOX_PORTS.filter(
    (port) => port !== "verdict.post" || TASKS_ENABLED,
  ),
);
const taskOffers = TASKS_ENABLED
  ? portSet(
    "tasks.list",
    "tasks.create",
    "tasks.claim",
    "tasks.update",
    "msg.list",
    "msg.send",
  )
  : emptyOffers;
// Feature-gated sink offers. A disabled feature keeps its role (historical
// rows stay decodable and render as cards) but offers no port, so every
// capability surface — CLI grants, work ops, overseer admin, station wire —
// fails closed on the same empty set. The gate lives here, at the one table
// both admission and the work vocabulary read.
const requestsOffers = REQUESTS_ENABLED
  ? portSet("msg.list", "msg.send")
  : emptyOffers;
const artifactsOffers = ARTIFACTS_ENABLED
  ? portSet("artifact.publish")
  : emptyOffers;
const pageOffers = BROWSER_ENABLED ? portSet("browser.automate") : emptyOffers;
const boardOffers = BOARD_ENABLED
  ? portSet(
    "board.list",
    "board.create_topic",
    "board.post",
    "board.mark_read",
  )
  : emptyOffers;
const padOffers = PAD_ENABLED
  ? portSet("pad.read", "pad.patch")
  : emptyOffers;
/** Read-only by construction: the operator authors a sheet, agents consult it. */
const sheetOffers = SHEET_ENABLED ? portSet("sheet.read") : emptyOffers;

/**
 * The role a kind carries, decided by which literal group it was written into
 * (`schema.ts`). A row cannot claim a role its kind group does not have.
 */
type RoleForKind<K extends WellKnownKind> = K extends ActorKind
  ? "actor"
  : K extends SinkKind
    ? "sink"
    : K extends SchedulerKind
      ? "scheduler"
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
  requests: { kind: "requests", role: "sink", offers: requestsOffers },
  artifacts: { kind: "artifacts", role: "sink", offers: artifactsOffers },
  board: { kind: "board", role: "sink", offers: boardOffers },
  pad: { kind: "pad", role: "sink", offers: padOffers },
  sheet: { kind: "sheet", role: "sink", offers: sheetOffers },
  // Terminal sink: tmux-like resource. Ports TBD in v1 — access family only.
  terminal: { kind: "terminal", role: "sink", offers: emptyOffers },
  watcher: { kind: "watcher", role: "scheduler", offers: emptyOffers },
  timer: { kind: "timer", role: "scheduler", offers: emptyOffers },
  cron: { kind: "cron", role: "scheduler", offers: emptyOffers },
  relay: {
    kind: "relay",
    role: "scheduler",
    offers: portSet("relay.trigger"),
  },
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
  Scheduler: {
    readonly kind: SchedulerKind;
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
      case "scheduler":
        return NodeSpec.Scheduler({ kind: spec.kind, offers: spec.offers });
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
      Scheduler: () => "scheduler" as const,
      Geography: () => "geography" as const,
    }),
  );

export const offersOf = (spec: NodeSpec): HashSet.HashSet<Port> =>
  Match.value(spec).pipe(
    Match.tagsExhaustive({
      Actor: (s) => s.offers,
      Sink: (s) => s.offers,
      Scheduler: (s) => s.offers,
      Geography: (s) => s.offers,
    }),
  );

export const lookupKindSpec = (
  kind: WellKnownKind,
): KindSpec => KindSpecs[kind];
