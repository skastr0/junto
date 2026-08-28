/**
 * Semantic verbs — the single authored fact on an edge.
 *
 * An edge says one thing: *what this relationship is*. `verb` is the only word
 * the operator writes; ports, assignability, board wake, watch predicates,
 * scheduler effects, pipeline flow, and scheduler chaining are all **compiled**
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
import { KindSpecs } from "./kinds";
import {
  isWellKnownKind,
  type ActorKind,
  type Port,
  type SchedulerKind,
  type SinkKind,
  type WellKnownKind,
} from "./schema";

// ---------------------------------------------------------------------------
// Flag vocabulary
//
// Mirrors the node flag words. Declared here rather than imported from the
// document schema so physics stays free of a canvas import (the document
// imports this module for `Verb`).

export const EdgeFlag = Schema.Literals(["blocker", "parked", "attention"]);
export type EdgeFlag = typeof EdgeFlag.Type;

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

export const WatchWhenFlagged = Schema.Struct({
  word: Schema.Literal("flagged"),
  flag: EdgeFlag,
});
export type WatchWhenFlagged = typeof WatchWhenFlagged.Type;

/** Atomic watch atoms — multi-select OR nests these under `any`. */
export const WatchWhenAtom = Schema.Union([
  WatchWhenCompletes,
  WatchWhenFlagged,
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
  WatchWhenFlagged,
  WatchWhenAny,
]);
export type WatchWhen = typeof WatchWhen.Type;

// ---------------------------------------------------------------------------
// Fire actions — compiled by `enqueues` / `wakes` / `flags`
//
// Three, and only three: those are the verbs a scheduler holds. Kernel-home
// fire applies them; never a process-bind ocap. Claim assignment stays the
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

export const EdgeEffectSetFlag = Schema.Struct({
  mode: Schema.Literal("set_flag"),
  flag: EdgeFlag,
  /** true = enable, false = clear. "mirror" = pending→on / satisfied→off. */
  enabled: Schema.Union([Schema.Boolean, Schema.Literal("mirror")]),
});
export type EdgeEffectSetFlag = typeof EdgeEffectSetFlag.Type;

/** Inject a prompt into an agent seat. Text optional — kernel fills from fire provenance. */
export const EdgeEffectInjectPrompt = Schema.Struct({
  mode: Schema.Literal("inject_prompt"),
  text: Schema.optionalKey(Schema.String),
});
export type EdgeEffectInjectPrompt = typeof EdgeEffectInjectPrompt.Type;

export const EdgeEffect = Schema.Union([
  EdgeEffectEnqueueTask,
  EdgeEffectSetFlag,
  EdgeEffectInjectPrompt,
]);
export type EdgeEffect = typeof EdgeEffect.Type;

// ---------------------------------------------------------------------------
// The verbs

export const Verb = Schema.Literals([
  "messages",
  "manages",
  "contributes",
  "works",
  "escalates",
  "publishes",
  "participates",
  "reads",
  "edits",
  "navigates",
  "feeds",
  "fires",
  "announces",
  "enqueues",
  "wakes",
  "flags",
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
 * Two verbs per ordered pair is the ceiling (tested). Row order is narrow-first
 * where the two nest (`manages` inside `contributes`, `reads` inside `edits`)
 * and plain reading order where they do not (`fires` beside `announces`), so it
 * never decides the default — `DEFAULT_CONNECT_VERBS` does.
 */
export const VERB_TABLE = {
  agent: {
    agent: ["messages"],
    task: ["manages", "contributes"],
    requests: ["escalates"],
    artifacts: ["publishes"],
    board: ["messages", "participates"],
    pad: ["reads", "edits"],
    // Read, never edit: the operator authors a sheet; an agent consults it.
    sheet: ["reads"],
    page: ["navigates"],
    relay: ["fires", "announces"],
  },
  task: {
    agent: ["works"],
    task: ["feeds"],
    relay: ["announces"],
  },
  requests: { relay: ["announces"] },
  artifacts: { relay: ["announces"] },
  board: { relay: ["announces"] },
  pad: { relay: ["announces"] },
  sheet: { relay: ["announces"] },
  page: { relay: ["announces"] },
  // Terminal publishes nothing and offers no port: no verb speaks to it yet.
  terminal: {},
  relay: {
    agent: ["wakes", "flags"],
    task: ["enqueues", "flags"],
    requests: ["flags"],
    artifacts: ["flags"],
    board: ["flags"],
    pad: ["flags"],
    sheet: ["flags"],
    page: ["flags"],
    terminal: ["flags"],
    relay: ["chains"],
    clock: ["chains"],
  },
  clock: {
    agent: ["wakes", "flags"],
    task: ["enqueues", "flags"],
    requests: ["flags"],
    artifacts: ["flags"],
    board: ["flags"],
    pad: ["flags"],
    sheet: ["flags"],
    page: ["flags"],
    terminal: ["flags"],
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
 * What a plain connect stamps. Binary pairs default to the fuller relationship
 * — contribute, not just manage; participate, not just read the board — because
 * the narrow one is the deliberate choice, not the accident.
 */
const DEFAULT_CONNECT_VERBS: ReadonlyArray<Verb> = [
  "contributes",
  "participates",
  "edits",
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
  /** Actor seat may be assigned work by the factory tick. */
  readonly assignable?: boolean;
  /** Board megaphone reaches this seat. */
  readonly wake?: boolean;
  /** Watch predicate the relay evaluates on the source. */
  readonly when?: WatchWhen;
  /** Fire action applied to the target. */
  readonly does?: EdgeEffect;
  /** Pipeline hop between task sinks (DAG-guarded). */
  readonly flow?: boolean;
  /** Upstream scheduler fires downstream (cycle-guarded). */
  readonly chain?: boolean;
};

const MSG_PORTS = ["msg.list", "msg.send"] as const satisfies ReadonlyArray<Port>;

const MANAGE_PORTS = [
  "tasks.create",
  "tasks.update",
  "tasks.list",
  "msg.list",
  "msg.send",
] as const satisfies ReadonlyArray<Port>;

const CONTRIBUTE_PORTS = [
  ...MANAGE_PORTS,
  "tasks.claim",
] as const satisfies ReadonlyArray<Port>;

const WORK_PORTS = [
  "tasks.list",
  "tasks.claim",
  "tasks.update",
  "msg.list",
  "msg.send",
] as const satisfies ReadonlyArray<Port>;

const ESCALATE_PORTS = [
  "request.escalate",
  "msg.list",
  "msg.send",
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
 * ready, and the two kinds whose only news is a flag announce attention.
 */
const ANNOUNCE_WHEN = {
  agent: { word: "flagged", flag: "attention" },
  task: { word: "completes" },
  requests: { word: "completes" },
  // Artifacts count published items; an `equals` here would be read as a state.
  artifacts: { word: "completes" },
  board: { word: "completes", equals: "post" },
  page: { word: "completes", equals: "ready" },
  pad: { word: "flagged", flag: "attention" },
  sheet: { word: "flagged", flag: "attention" },
} as const satisfies { readonly [K in WellKnownKind]?: WatchWhen };

const announceWhenFor = (kind: string | undefined): WatchWhen | undefined => {
  if (kind === undefined || !isWellKnownKind(kind)) return undefined;
  const table: { readonly [K in WellKnownKind]?: WatchWhen } = ANNOUNCE_WHEN;
  return table[kind];
};

const SET_ATTENTION: EdgeEffect = {
  mode: "set_flag",
  flag: "attention",
  enabled: true,
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
    case "manages":
      return { ports: MANAGE_PORTS };
    case "contributes":
      return { ports: CONTRIBUTE_PORTS };
    case "works":
      return { ports: WORK_PORTS, assignable: true };
    case "escalates":
      return { ports: ESCALATE_PORTS };
    case "publishes":
      return { ports: ["artifact.publish"] };
    case "participates":
      return { ports: BOARD_PARTICIPATE_PORTS, wake: true };
    case "reads":
      // One verb, two read surfaces: the port follows the kind at the far end
      // of the wire, so `reads` never grants a port that end does not offer.
      return { ports: target === "sheet" ? ["sheet.read"] : ["pad.read"] };
    case "edits":
      return { ports: ["pad.read", "pad.patch"] };
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
    case "flags":
      return { ports: NO_PORTS, does: SET_ATTENTION };
    case "chains":
      return { ports: NO_PORTS, chain: true, when: CHAIN_WHEN };
    default: {
      const exhaustive: never = verb;
      return exhaustive;
    }
  }
};

// ---------------------------------------------------------------------------
// Legacy conversion (one shot, on scrub)

/**
 * The wire areas edges used to carry. Read loosely: this is raw document input
 * being converted once, not a shape anything emits.
 */
export type LegacyEdgeEther = {
  readonly ports?: ReadonlyArray<string> | undefined;
  readonly wake?: boolean | undefined;
  readonly slot?: string | undefined;
  readonly when?: unknown;
  readonly does?: unknown;
  readonly flow?:
    | { readonly source?: string; readonly destination?: string }
    | undefined;
};

const effectModeOf = (does: unknown): string | undefined => {
  if (typeof does !== "object" || does === null) return undefined;
  const mode = (does as { readonly mode?: unknown }).mode;
  return typeof mode === "string" ? mode : undefined;
};

const verbForEffectMode = (mode: string): Verb | undefined => {
  if (mode === "enqueue_task") return "enqueues";
  if (mode === "inject_prompt") return "wakes";
  if (mode === "set_flag" || mode.startsWith("board_")) return "flags";
  return undefined;
};

const ACCESS_VERB_FOR_SINK = {
  task: "contributes",
  pad: "edits",
  sheet: "reads",
  page: "navigates",
  requests: "escalates",
  artifacts: "publishes",
} as const satisfies { readonly [K in SinkKind]?: Verb };

const roleOfKind = (kind: WellKnownKind) => KindSpecs[kind].role;

/**
 * Legacy edge ether → the verb it always meant. Deterministic; `undefined`
 * means the edge does not survive (geography end, terminal access, a scheduler
 * pairing the grammar never admitted).
 *
 * Orientation-insensitive: the caller re-stores the edge in the verb's semantic
 * order, which for most conversions is the reverse of nothing and for
 * agent↔sink is agent-first regardless of how it was drawn.
 */
export const inferVerb = (
  legacyEther: LegacyEdgeEther | undefined,
  source: string | undefined,
  target: string | undefined,
): Verb | undefined => {
  if (source === undefined || target === undefined) return undefined;
  if (!isWellKnownKind(source) || !isWellKnownKind(target)) return undefined;
  const candidate = inferCandidate(legacyEther, source, target);
  if (candidate === undefined) return undefined;
  // A conversion only survives if the grammar admits it in one of the two
  // orientations — never a verb the pair could not hold.
  return verbsForPair(source, target).includes(candidate) ||
    verbsForPair(target, source).includes(candidate)
    ? candidate
    : undefined;
};

const inferCandidate = (
  legacyEther: LegacyEdgeEther | undefined,
  source: WellKnownKind,
  target: WellKnownKind,
): Verb | undefined => {
  if (source === "task" && target === "task") return "feeds";
  if (source === "agent" && target === "agent") return "messages";

  const sourceRole = roleOfKind(source);
  const targetRole = roleOfKind(target);

  if (sourceRole === "scheduler" && targetRole === "scheduler") return "chains";

  // agent ↔ sink: the access relationship, read off the sink kind.
  if (
    (sourceRole === "actor" && targetRole === "sink") ||
    (sourceRole === "sink" && targetRole === "actor")
  ) {
    const sink = (sourceRole === "sink" ? source : target) as SinkKind;
    if (sink === "board") {
      return legacyEther?.wake === false ? "messages" : "participates";
    }
    const table: { readonly [K in SinkKind]?: Verb } = ACCESS_VERB_FOR_SINK;
    return table[sink];
  }

  if (sourceRole === "scheduler" || targetRole === "scheduler") {
    const scheduler = sourceRole === "scheduler" ? source : target;
    const other = sourceRole === "scheduler" ? target : source;
    const schedulerIsSource = sourceRole === "scheduler";

    // Agent → relay trigger: the slot or the minted port proves it.
    if (
      scheduler === "relay" &&
      other === "agent" &&
      (legacyEther?.slot === "trigger" ||
        (legacyEther?.ports ?? []).includes("relay.trigger"))
    ) {
      return "fires";
    }

    // An authored fire action names its own verb.
    const mode = effectModeOf(legacyEther?.does);
    if (mode !== undefined) return verbForEffectMode(mode);

    // An authored watch predicate is an announcement into the relay.
    if (legacyEther?.when !== undefined) return "announces";

    // Neither authored: direction decides. Into a scheduler is an
    // announcement; out of one is the fire action its target accepts.
    if (!schedulerIsSource) return "announces";
    if (other === "task") return "enqueues";
    if (other === "agent") return "wakes";
    return "flags";
  }

  return undefined;
};

// ---------------------------------------------------------------------------
// Paint

/**
 * CSS custom-property names per verb. Hues live in the stylesheet — this maps
 * the verb to its token and holds no color.
 */
export const VERB_COLOR_TOKEN: Record<Verb, string> = {
  messages: "--wire-verb-messages",
  manages: "--wire-verb-manages",
  contributes: "--wire-verb-contributes",
  works: "--wire-verb-works",
  escalates: "--wire-verb-escalates",
  publishes: "--wire-verb-publishes",
  participates: "--wire-verb-participates",
  reads: "--wire-verb-reads",
  edits: "--wire-verb-edits",
  navigates: "--wire-verb-navigates",
  feeds: "--wire-verb-feeds",
  fires: "--wire-verb-fires",
  announces: "--wire-verb-announces",
  enqueues: "--wire-verb-enqueues",
  wakes: "--wire-verb-wakes",
  flags: "--wire-verb-flags",
  chains: "--wire-verb-chains",
};
