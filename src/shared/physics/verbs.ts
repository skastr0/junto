/**
 * Semantic verbs — the single authored fact on an edge.
 *
 * An edge says one thing: *what this relationship is*. `verb` is the only word
 * the operator writes; ports, claimability, board wake, watch predicates,
 * scheduler effects, task-path flow, and scheduler chaining are all **compiled**
 * from the verb plus the two endpoint kinds. There is no second authoring
 * surface and no mirror to keep in sync.
 *
 * - `VERB_TABLE` — which verbs an ordered kind pair admits (hand-written, one
 *   row per row of the grammar; `clock` shares one row for the non-relay
 *   schedulers). Anything absent from the table is refused at connect.
 * - `compileVerb` — verb + pair → the flat grant the kernel reads.
 *
 * `WatchWhen` and `EdgeEffect` live here because a verb is what produces them:
 * the watch predicate and the fire action are compiled facets of a verb, not
 * fields the document carries.
 */
import { Schema } from "effect";
import {
  isWellKnownKind,
  type ActorKind,
  type Port,
  type SchedulerKind,
  type SinkKind,
  type WellKnownKind,
} from "./schema";

// ---------------------------------------------------------------------------
// Watch predicates — compiled by `announces` / `chains`

/** Source finished something. `equals` discriminates completion variants. */
export const WatchWhenCompletes = Schema.Struct({
  word: Schema.Literal("completes"),
  /** Item state; default completed. */
  equals: Schema.optionalKey(Schema.String),
  itemId: Schema.optionalKey(Schema.String),
});
export type WatchWhenCompletes = typeof WatchWhenCompletes.Type;

/**
 * Source agent seat has raised a hand: an open `blocked` or `escalate` signal
 * (`junto blocked`, `junto escalate`). Answering, dismissing or withdrawing
 * every such signal clears it.
 */
export const WatchWhenSignals = Schema.Struct({
  word: Schema.Literal("signals"),
});
export type WatchWhenSignals = typeof WatchWhenSignals.Type;

/** Atomic watch atoms — multi-select OR nests these under `any`. */
export const WatchWhenAtom = Schema.Union([
  WatchWhenCompletes,
  WatchWhenSignals,
]);
export type WatchWhenAtom = typeof WatchWhenAtom.Type;

/** Multi-select OR within one watch relationship. Single atoms decode alone. */
export const WatchWhenAny = Schema.Struct({
  word: Schema.Literal("any"),
  any: Schema.Array(WatchWhenAtom).pipe(Schema.check(Schema.isMinLength(1))),
});
export type WatchWhenAny = typeof WatchWhenAny.Type;

export const WatchWhen = Schema.Union([
  WatchWhenCompletes,
  WatchWhenSignals,
  WatchWhenAny,
]);
export type WatchWhen = typeof WatchWhen.Type;

// ---------------------------------------------------------------------------
// Fire actions — compiled by `enqueues` / `wakes`
//
// Two, and only two: those are the verbs a scheduler holds. Kernel-home
// fire applies them; never a process-bind ocap. Task claiming stays in the
// factory tick. `data` is opaque here; the target sink's closed create schema
// is decoded fail-closed at apply.

export const EdgeEffectEnqueueTask = Schema.Struct({
  mode: Schema.Literal("enqueue_task"),
  data: Schema.Unknown,
});
export type EdgeEffectEnqueueTask = typeof EdgeEffectEnqueueTask.Type & {
  readonly data:
    | import("../node-insert").EffectTasksCreate
    | Record<string, unknown>;
};

/** Inject a prompt into an agent seat. Text optional — kernel fills from fire provenance. */
export const EdgeEffectInjectPrompt = Schema.Struct({
  mode: Schema.Literal("inject_prompt"),
  text: Schema.optionalKey(Schema.String),
});
export type EdgeEffectInjectPrompt = typeof EdgeEffectInjectPrompt.Type;

export const EdgeEffect = Schema.Union([
  EdgeEffectEnqueueTask,
  EdgeEffectInjectPrompt,
]);
export type EdgeEffect = typeof EdgeEffect.Type;

// ---------------------------------------------------------------------------
// The verbs

export const Verb = Schema.Literals([
  "messages",
  "reviews",
  "participates",
  "navigates",
  "feeds",
  "fires",
  "announces",
  "enqueues",
  "wakes",
  "chains",
]);
export type Verb = typeof Verb.Type;

export const VERBS: ReadonlyArray<Verb> = Verb.literals;

// ---------------------------------------------------------------------------
// Table sides
//
// A row is keyed by kind, except the non-relay schedulers: cron, timer, and
// watcher push identically and share the single `clock` row. Only relay
// evaluates a watch predicate, so only relay takes `announces` inbound.

/** Schedulers that only push — they share the `clock` row. */
export type ClockKind = Exclude<SchedulerKind, "relay">;

export type VerbSide = ActorKind | SinkKind | "relay" | "clock";

/**
 * Kind → table side. Unknown or geography kinds have no side, which is what
 * makes them unwireable: no side, no row, no verb.
 */
export const verbSideOf = (kind: string | undefined): VerbSide | undefined => {
  if (kind === undefined || !isWellKnownKind(kind)) return undefined;
  switch (kind) {
    case "relay":
      return "relay";
    case "cron":
    case "timer":
    case "watcher":
      return "clock";
    default:
      return kind;
  }
};

type VerbTable = {
  readonly [S in VerbSide]?: {
    readonly [T in VerbSide]?: ReadonlyArray<Verb>;
  };
};

/**
 * Ordered source → target rows. The order is semantic: the row's source is the
 * verb's subject, whatever way the operator happened to drag.
 *
 * Two verbs per ordered pair is the ceiling (tested). Row order is plain
 * reading order (`fires` beside `announces`), so it never decides the default
 * — `DEFAULT_CONNECT_VERBS` does. No verb grants access to a resource node: a
 * seat reaches those by region (01).
 */
export const VERB_TABLE = {
  agent: {
    agent: ["messages", "reviews"],
    board: ["messages", "participates"],
    page: ["navigates"],
    relay: ["fires", "announces"],
  },
  task: {
    task: ["feeds"],
    relay: ["announces"],
  },
  requests: { relay: ["announces"] },
  artifacts: { relay: ["announces"] },
  board: { relay: ["announces"] },
  page: { relay: ["announces"] },
  // Terminal publishes nothing and offers no port: no verb speaks to it yet.
  terminal: {},
  // Automations take no edge: they act by reach (07).
  automations: {},
  relay: {
    agent: ["wakes"],
    task: ["enqueues"],
    relay: ["chains"],
    clock: ["chains"],
  },
  clock: {
    agent: ["wakes"],
    task: ["enqueues"],
    relay: ["chains"],
    clock: ["chains"],
  },
} as const satisfies VerbTable;

const NO_VERBS: ReadonlyArray<Verb> = [];

/** Verbs legal for this ordered pair. Empty = connect refused. */
export const verbsForPair = (
  source: string | undefined,
  target: string | undefined,
): ReadonlyArray<Verb> => {
  const from = verbSideOf(source);
  const to = verbSideOf(target);
  if (from === undefined || to === undefined) return NO_VERBS;
  const row: { readonly [T in VerbSide]?: ReadonlyArray<Verb> } =
    VERB_TABLE[from];
  return row[to] ?? NO_VERBS;
};

/**
 * What a plain connect stamps where a pair holds two verbs: the fuller
 * relationship — participate, not just read the board — because the narrow
 * one is the deliberate choice, not the accident.
 */
const DEFAULT_CONNECT_VERBS: ReadonlyArray<Verb> = [
  "participates",
  "fires",
  "enqueues",
  "wakes",
];

export const defaultVerbForPair = (
  source: string | undefined,
  target: string | undefined,
): Verb | undefined => {
  const verbs = verbsForPair(source, target);
  if (verbs.length <= 1) return verbs[0];
  return verbs.find((verb) => DEFAULT_CONNECT_VERBS.includes(verb)) ?? verbs[0];
};

// ---------------------------------------------------------------------------
// Compilation

/**
 * The flat facts a verb grants. Every field is derived — nothing here is ever
 * read from, or written back to, the document.
 */
export type VerbGrant = {
  /** Ports this relationship opens. Empty for non-access verbs. */
  readonly ports: ReadonlyArray<Port>;
  /** Board megaphone reaches this seat. */
  readonly wake?: boolean;
  /** Watch predicate the relay evaluates on the source. */
  readonly when?: WatchWhen;
  /** Fire action applied to the target. */
  readonly does?: EdgeEffect;
  /** Task path hop between Tasks nodes (DAG-guarded). */
  readonly flow?: boolean;
  /** Upstream scheduler fires downstream (cycle-guarded). */
  readonly chain?: boolean;
};

const MSG_PORTS = [
  "msg.list", "msg.send", "msg.prompt", "seat.wait", "terminal.read",
] as const satisfies ReadonlyArray<Port>;

const BOARD_MESSAGE_PORTS = [
  "board.list",
  "board.post",
  "board.mark_read",
] as const satisfies ReadonlyArray<Port>;

const BOARD_PARTICIPATE_PORTS = [
  "board.list",
  "board.create_topic",
  "board.post",
  "board.mark_read",
] as const satisfies ReadonlyArray<Port>;

const NO_PORTS: ReadonlyArray<Port> = [];

/**
 * The event a kind announces by default. This is the kind's own headline
 * event: task/requests complete, artifacts publish, board posts, page becomes
 * ready, and an agent raises a hand.
 */
const ANNOUNCE_WHEN = {
  // An agent's news is a raised hand: an open blocked or escalate signal.
  agent: { word: "signals" },
  task: { word: "completes" },
  requests: { word: "completes" },
  // Artifacts count published items; an `equals` here would be read as a state.
  artifacts: { word: "completes" },
  board: { word: "completes", equals: "post" },
  page: { word: "completes", equals: "ready" },
} as const satisfies { readonly [K in WellKnownKind]?: WatchWhen };

const announceWhenFor = (kind: string | undefined): WatchWhen | undefined => {
  if (kind === undefined || !isWellKnownKind(kind)) return undefined;
  const table: { readonly [K in WellKnownKind]?: WatchWhen } = ANNOUNCE_WHEN;
  return table[kind];
};

/** Payload is built from fire provenance at apply time, not authored here. */
const ENQUEUE_FROM_PROVENANCE: EdgeEffect = { mode: "enqueue_task", data: {} };

/** Prompt text is filled from fire provenance at apply time. */
const INJECT_FROM_PROVENANCE: EdgeEffect = { mode: "inject_prompt" };

/** Scheduler chaining watches the upstream's single `fired` event. */
const CHAIN_WHEN: WatchWhen = { word: "completes" };

/**
 * Verb + ordered pair → grant. `undefined` when the verb is not legal for the
 * pair, so a stale or hand-edited verb grants nothing rather than something
 * adjacent.
 */
export const compileVerb = (
  verb: Verb,
  source: string | undefined,
  target: string | undefined,
): VerbGrant | undefined => {
  if (!verbsForPair(source, target).includes(verb)) return undefined;
  switch (verb) {
    case "messages":
      return target === "board"
        ? { ports: BOARD_MESSAGE_PORTS, wake: false }
        : { ports: MSG_PORTS };
    case "reviews":
      return { ports: ["verdict.post"] };
    case "participates":
      return { ports: BOARD_PARTICIPATE_PORTS, wake: true };
    case "navigates":
      return { ports: ["browser.automate"] };
    case "feeds":
      return { ports: NO_PORTS, flow: true };
    case "fires":
      return { ports: ["relay.trigger"] };
    case "announces": {
      const when = announceWhenFor(source);
      return when === undefined ? undefined : { ports: NO_PORTS, when };
    }
    case "enqueues":
      return { ports: NO_PORTS, does: ENQUEUE_FROM_PROVENANCE };
    case "wakes":
      return { ports: NO_PORTS, does: INJECT_FROM_PROVENANCE };
    case "chains":
      return { ports: NO_PORTS, chain: true, when: CHAIN_WHEN };
    default: {
      const exhaustive: never = verb;
      return exhaustive;
    }
  }
};

// ---------------------------------------------------------------------------
// Paint

/**
 * CSS custom-property names per verb. Hues live in the stylesheet — this maps
 * the verb to its token and holds no color.
 */
export const VERB_COLOR_TOKEN: Record<Verb, string> = {
  messages: "--wire-verb-messages",
  reviews: "--wire-verb-reviews",
  participates: "--wire-verb-participates",
  navigates: "--wire-verb-navigates",
  feeds: "--wire-verb-feeds",
  fires: "--wire-verb-fires",
  announces: "--wire-verb-announces",
  enqueues: "--wire-verb-enqueues",
  wakes: "--wire-verb-wakes",
  chains: "--wire-verb-chains",
};
