/**
 * Wires grammar — edges as configuration, never runtime state.
 *
 * Families: access | watch | trigger | effect | flow.
 * Words come from kind-areas (open lexicon). Sentence = family - word*.
 * Connect refused when no family exists for the pair.
 *
 * Law: only schedulers push; actors pull. Automation families require a
 * scheduler on exactly one end (or two for scheduler–scheduler chains).
 *
 * `flow` is the one family with no automation end and no grant: the pipeline
 * hop between two task sinks. It is plumbing between stations, so it offers
 * no port to any seat — see `familiesForPair` and `offerPortsForAccessWire`.
 * Layering holds: role decides the matrix row, kind configuration refines it
 * (task↔task is the only sink pair that carries a wire).
 */
import { HashSet, Match } from "effect";
import type { FactoryRole, Port, SinkKind } from "./schema";

/**
 * Ports that exist on the schema for future ops but must not appear in access
 * chips until a real consumer exists (otherwise operators attenuate into air).
 */
/** Empty — relay.trigger ships (agent fire + operator Fire now). */
export const PORTS_HIDDEN_FROM_CHIPS: ReadonlySet<Port> = new Set([]);

/**
 * Which port set an access wire attenuates. Direction-agnostic:
 * - actor–actor → union of both inboxes
 * - actor–non-actor → the non-actor's offers (sink/scheduler)
 * - else empty (no access family ports — a task-flow hop grants nothing)
 */
export const offerPortsForAccessWire = (
  fromRole: FactoryRole,
  toRole: FactoryRole,
  fromOffers: HashSet.HashSet<Port>,
  toOffers: HashSet.HashSet<Port>,
): HashSet.HashSet<Port> => {
  if (fromRole === "actor" && toRole === "actor") {
    return HashSet.union(fromOffers, toOffers);
  }
  if (fromRole === "actor") return toOffers;
  if (toRole === "actor") return fromOffers;
  return HashSet.empty();
};

/** Drop ports that are schema scaffolding without a live consumer. */
export const chipPortsFromOffers = (
  offers: HashSet.HashSet<Port>,
): ReadonlyArray<Port> =>
  [...offers].filter((port) => !PORTS_HIDDEN_FROM_CHIPS.has(port));

/** Closed set — four capability families plus the task-flow hop. */
export type WireFamily = "access" | "watch" | "trigger" | "effect" | "flow";

export const WIRE_FAMILIES: ReadonlyArray<WireFamily> = [
  "access",
  "watch",
  "trigger",
  "effect",
  "flow",
] as const;

/** Scheduler-assigned role of this wire end at the scheduler. */
export type WireSlot = "input" | "output" | "trigger" | "recipient";

export const WIRE_SLOTS: ReadonlyArray<WireSlot> = [
  "input",
  "output",
  "trigger",
  "recipient",
] as const;

/**
 * Lexicon words (v1). New kinds add words; never new families.
 * Planned v1.1 words (posts, agent wakes, publishes) stay out until wired.
 */
export type WireWord =
  | "stops"
  | "wakes"
  | "messages"
  | "completes"
  | "flagged"
  | "enqueues"
  | "flags";

export const WIRE_WORDS: ReadonlyArray<WireWord> = [
  "stops",
  "wakes",
  "messages",
  "completes",
  "flagged",
  "enqueues",
  "flags",
] as const;

export type WireSentence = {
  readonly family: WireFamily;
  readonly words: ReadonlyArray<WireWord>;
};

/**
 * Role pair for connectability (undirected for matrix A), with one kind-level
 * refinement: `TaskFlow` is the sink–sink row narrowed to two `task` sinks.
 */
export type WireRolePair =
  | { readonly _tag: "ActorActor" }
  | { readonly _tag: "ActorSink" }
  | { readonly _tag: "ActorScheduler" }
  | { readonly _tag: "SinkScheduler" }
  | { readonly _tag: "SchedulerScheduler" }
  | { readonly _tag: "SinkSink" }
  | { readonly _tag: "TaskFlow" }
  | { readonly _tag: "GeographyAny" }
  | { readonly _tag: "Denied" };

/** The only sink kind a pipeline hop may join — task sinks project rows. */
const TASK_SINK: SinkKind = "task";

/** Endpoint kinds, when the caller has them — refines sink–sink to TaskFlow. */
export type WirePairKinds = {
  readonly fromKind?: string;
  readonly toKind?: string;
};

export const wireRolePair = (
  a: FactoryRole,
  b: FactoryRole,
  kinds?: WirePairKinds,
): WireRolePair => {
  if (a === "geography" || b === "geography") {
    return { _tag: "GeographyAny" };
  }
  const set = HashSet.make(a, b);
  if (HashSet.has(set, "actor") && HashSet.size(set) === 1) {
    return { _tag: "ActorActor" };
  }
  if (HashSet.has(set, "actor") && HashSet.has(set, "sink")) {
    return { _tag: "ActorSink" };
  }
  if (HashSet.has(set, "actor") && HashSet.has(set, "scheduler")) {
    return { _tag: "ActorScheduler" };
  }
  if (HashSet.has(set, "sink") && HashSet.has(set, "scheduler")) {
    return { _tag: "SinkScheduler" };
  }
  if (HashSet.has(set, "scheduler") && HashSet.size(set) === 1) {
    return { _tag: "SchedulerScheduler" };
  }
  if (HashSet.has(set, "sink") && HashSet.size(set) === 1) {
    // Task↔task is the single sink pair that carries a wire — the pipeline
    // hop. Kind configuration decides; every other sink pair still refuses.
    return kinds?.fromKind === TASK_SINK && kinds.toKind === TASK_SINK
      ? { _tag: "TaskFlow" }
      : { _tag: "SinkSink" };
  }
  return { _tag: "Denied" };
};

/**
 * Families legal for a pair. Empty = refuse at connect.
 * Actor–scheduler: trigger XOR effect (exclusive per edge, chosen by slot).
 * Sink–scheduler: watch XOR effect (input vs output slot).
 * Task sink–task sink: flow only — a hop grants nothing, so `access` (the
 * grant family) is never legal there.
 */
export const familiesForPair = (
  pair: WireRolePair,
): ReadonlyArray<WireFamily> =>
  Match.value(pair).pipe(
    Match.discriminatorsExhaustive("_tag")({
      ActorActor: () => ["access"] as const,
      ActorSink: () => ["access"] as const,
      ActorScheduler: () => ["trigger", "effect"] as const,
      SinkScheduler: () => ["watch", "effect"] as const,
      SchedulerScheduler: () => ["trigger", "effect"] as const,
      TaskFlow: () => ["flow"] as const,
      SinkSink: () => [] as const,
      GeographyAny: () => [] as const,
      Denied: () => [] as const,
    }),
  );

export const connectable = (
  roleA: FactoryRole,
  roleB: FactoryRole,
  kinds?: WirePairKinds,
): boolean => familiesForPair(wireRolePair(roleA, roleB, kinds)).length > 0;

export type ConnectRefusal = {
  readonly ok: false;
  readonly reason: string;
};

export type ConnectOk = {
  readonly ok: true;
  readonly families: ReadonlyArray<WireFamily>;
};

export const connectCheck = (
  roleA: FactoryRole,
  roleB: FactoryRole,
  kinds?: WirePairKinds,
): ConnectOk | ConnectRefusal => {
  const pair = wireRolePair(roleA, roleB, kinds);
  const families = familiesForPair(pair);
  if (families.length === 0) {
    return {
      ok: false,
      reason: refusalReason(pair),
    };
  }
  return { ok: true, families };
};

const refusalReason = (pair: WireRolePair): string =>
  Match.value(pair).pipe(
    Match.discriminatorsExhaustive("_tag")({
      SinkSink: () => "Sinks cannot wire to each other — use a relay between them",
      GeographyAny: () => "Geography takes no edges",
      Denied: () => "This pair cannot be wired",
      ActorActor: () => "unreachable",
      ActorSink: () => "unreachable",
      ActorScheduler: () => "unreachable",
      SinkScheduler: () => "unreachable",
      SchedulerScheduler: () => "unreachable",
      TaskFlow: () => "unreachable",
    }),
  );

/**
 * Derive family from scheduler slot when one endpoint is a scheduler.
 * Without a slot, fall back to the sole legal family (access pairs).
 */
export const familyFromSlot = (
  slot: WireSlot | undefined,
  pair: WireRolePair,
): WireFamily | undefined => {
  if (slot === "input") return "watch";
  if (slot === "output") return "effect";
  if (slot === "trigger") return "trigger";
  if (slot === "recipient") return "effect";
  const families = familiesForPair(pair);
  if (families.length === 1) return families[0];
  return undefined;
};

/**
 * Default slot when drawing a directed edge into/out of a scheduler.
 * Watch input is **relay-only** — cron/gauge do not consume `when`.
 */
export const defaultSlotForDraw = (input: {
  readonly fromRole: FactoryRole;
  readonly toRole: FactoryRole;
  readonly fromKind?: string;
  readonly toKind?: string;
}): WireSlot | undefined => {
  const { fromRole, toRole, fromKind, toKind } = input;
  // sink → relay = watch input (only relay evaluates when)
  if (fromRole === "sink" && toRole === "scheduler" && toKind === "relay") {
    return "input";
  }
  // scheduler → sink = effect output
  if (fromRole === "scheduler" && toRole === "sink") return "output";
  // actor → relay = trigger (operator Fire now + agent relay.trigger)
  if (fromRole === "actor" && toRole === "scheduler" && toKind === "relay") {
    return "trigger";
  }
  // scheduler → actor = effect on recipient
  if (fromRole === "scheduler" && toRole === "actor") return "recipient";
  // scheduler → scheduler = upstream fires downstream
  if (fromRole === "scheduler" && toRole === "scheduler") return "trigger";
  void fromKind;
  return undefined;
};

/**
 * Family color tokens (fixed forever). Renderers map these to theme hues.
 * Flow shares amber with effect — both move inventory downstream, and the two
 * can never meet on one pair (effect needs a scheduler end, flow forbids one),
 * so the shared hue costs no glance ambiguity and adds no visual language.
 */
export const familyColorToken = (
  family: WireFamily,
): "steel" | "cyan" | "violet" | "amber" => {
  switch (family) {
    case "access":
      return "steel";
    case "watch":
      return "cyan";
    case "trigger":
      return "violet";
    case "effect":
      return "amber";
    case "flow":
      return "amber";
    default: {
      const _exhaustive: never = family;
      return _exhaustive;
    }
  }
};

export const formatWireSentence = (sentence: WireSentence): string => {
  if (sentence.words.length === 0) return sentence.family;
  return `${sentence.family} ${sentence.words.join(", ")}`;
};

/** Build a sentence from known areas (pure; no canvas). */
export const sentenceOf = (input: {
  readonly family: WireFamily;
  readonly words?: ReadonlyArray<WireWord>;
}): WireSentence => ({
  family: input.family,
  words: input.words ?? [],
});

/**
 * Family stroke lay — fixed forever. Renderers map dasharray to SVG stroke.
 * solid → explicit "none" so CSS soft-relation dots cannot win.
 */
export type FamilyStroke = {
  readonly dasharray: "none" | "12 6" | "3 6" | "10 4 2 4";
};

export const familyStroke = (family: WireFamily): FamilyStroke => {
  switch (family) {
    case "access":
      return { dasharray: "none" };
    case "watch":
      return { dasharray: "12 6" };
    case "trigger":
      return { dasharray: "3 6" };
    case "effect":
      return { dasharray: "none" };
    // Conveyor lay: long run, short beat. Reads as carriage along the wire
    // without inventing a marker — direction itself stays in `ether.flow`.
    case "flow":
      return { dasharray: "10 4 2 4" };
    default: {
      const _exhaustive: never = family;
      return _exhaustive;
    }
  }
};

/** Minimal ether surface for pure word derivation (no canvas import). */
export type WireEtherView = {
  readonly stops?: unknown;
  readonly wake?: boolean;
  readonly when?: {
    readonly word?: string;
    readonly any?: ReadonlyArray<{ readonly word?: string }>;
  };
  readonly does?: { readonly mode?: string };
  readonly ports?: ReadonlyArray<string>;
};

/**
 * Derive lexicon words from edge ether + endpoint kinds.
 * Words are pure config presence — never phase/runtime.
 */
export const wordsOfEdge = (input: {
  readonly family: WireFamily;
  readonly ether?: WireEtherView;
  readonly fromKind?: string;
  readonly toKind?: string;
  /** True when msg.* is effectively available on an actor–actor wire. */
  readonly hasMessages?: boolean;
}): ReadonlyArray<WireWord> => {
  const { family, ether, fromKind, toKind, hasMessages } = input;
  const words: WireWord[] = [];
  // Flow carries no lexicon word: the hop's only content is its authored
  // direction (`ether.flow`), which the edge sheet states in full.
  if (family === "flow") return words;
  if (family === "access") {
    // No authorial "stops" word. Seat stoppage is derived from work attention
    // on the actor, not painted as edge vocabulary. Access words are wake
    // (board megaphone) and messages (actor↔actor reach) only.
    const touchesBoard = fromKind === "board" || toKind === "board";
    if (touchesBoard && ether?.wake !== false) words.push("wakes");
    if (hasMessages) words.push("messages");
    return words;
  }
  if (family === "watch") {
    const when = ether?.when;
    if (when?.word === "any" && Array.isArray(when.any)) {
      let hasCompletes = false;
      let hasFlagged = false;
      for (const atom of when.any) {
        if (atom.word === "completes") hasCompletes = true;
        else if (atom.word === "flagged") hasFlagged = true;
      }
      if (hasCompletes) words.push("completes");
      if (hasFlagged) words.push("flagged");
      if (words.length === 0) words.push("completes");
      return words;
    }
    const word = when?.word;
    if (word === "completes") words.push("completes");
    else if (word === "flagged") words.push("flagged");
    // Watch always carries a word in product; default completes when unset
    // so the sentence is never empty mid-draw.
    else words.push("completes");
    return words;
  }
  if (family === "effect") {
    const mode = ether?.does?.mode;
    if (mode === "enqueue_task") words.push("enqueues");
    else if (mode === "board_create_topic" || mode === "board_post")
      words.push("enqueues");
    else if (mode === "set_flag") words.push("flags");
    else if (mode === "inject_prompt") words.push("wakes");
    // Bare effect (no does yet) — do not pretend enqueues.
    return words;
  }
  // trigger — no live words yet
  return words;
};

/**
 * Halo rule:
 * - watch → always worded (completes/flagged default)
 * - effect → worded only when `does` is authored (no false enqueues)
 * - trigger → bare (no live words)
 * - flow → bare (direction is config, never edge vocabulary)
 * - access → worded only when wakes / messages present (never stops)
 */
export const isWorded = (
  family: WireFamily,
  words: ReadonlyArray<WireWord>,
): boolean => {
  if (family === "watch") return true;
  if (family === "trigger") return false;
  if (family === "flow") return false;
  if (family === "effect") return words.length > 0;
  return words.length > 0;
};

/**
 * Access disabled: no chip-ports remain effective.
 * Full default with empty offers (e.g. terminal) also dims.
 * Never crimson — only opacity.
 */
export const isAccessDisabled = (input: {
  readonly family: WireFamily;
  /** Chip ports the pair can offer (after PORTS_HIDDEN_FROM_CHIPS). */
  readonly offeredChipCount: number;
  /**
   * Active granted chip count. `"full"` = unattenuated default
   * (mask absent). Number = intersection size under an explicit mask.
   */
  readonly activeChipCount: number | "full";
}): boolean => {
  if (input.family !== "access") return false;
  if (input.offeredChipCount === 0) return true;
  if (input.activeChipCount === "full") return false;
  return input.activeChipCount === 0;
};

/** Full cold-scan presentation for one wire. */
export type WirePresentation = {
  readonly family: WireFamily;
  readonly colorToken: ReturnType<typeof familyColorToken>;
  readonly strokeDasharray: FamilyStroke["dasharray"];
  readonly words: ReadonlyArray<WireWord>;
  readonly sentence: string;
  readonly worded: boolean;
  readonly disabled: boolean;
};

export const wirePresentation = (input: {
  readonly family: WireFamily;
  readonly ether?: WireEtherView;
  readonly fromKind?: string;
  readonly toKind?: string;
  readonly hasMessages?: boolean;
  readonly offeredChipCount?: number;
  readonly activeChipCount?: number | "full";
}): WirePresentation => {
  const words = wordsOfEdge({
    family: input.family,
    ether: input.ether,
    fromKind: input.fromKind,
    toKind: input.toKind,
    hasMessages: input.hasMessages,
  });
  const disabled = isAccessDisabled({
    family: input.family,
    offeredChipCount: input.offeredChipCount ?? 1,
    activeChipCount: input.activeChipCount ?? "full",
  });
  const worded = !disabled && isWorded(input.family, words);
  return {
    family: input.family,
    colorToken: familyColorToken(input.family),
    strokeDasharray: familyStroke(input.family).dasharray,
    words,
    sentence: formatWireSentence(sentenceOf({ family: input.family, words })),
    worded,
    disabled,
  };
};
