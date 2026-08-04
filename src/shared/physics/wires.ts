/**
 * Wires grammar — edges as configuration, never runtime state.
 *
 * Closed families: access | watch | trigger | effect.
 * Words come from kind-areas (open lexicon). Sentence = family · word*.
 * Connect refused when no family exists for the role pair.
 *
 * Law: only schedulers push; actors pull. Automation families require a
 * scheduler on exactly one end (or two for scheduler–scheduler chains).
 */
import { HashSet, Match } from "effect";
import type { FactoryRole } from "./schema";

/** Closed forever — four families. */
export type WireFamily = "access" | "watch" | "trigger" | "effect";

export const WIRE_FAMILIES: ReadonlyArray<WireFamily> = [
  "access",
  "watch",
  "trigger",
  "effect",
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

/** Role pair for connectability (undirected for matrix A). */
export type WireRolePair =
  | { readonly _tag: "ActorActor" }
  | { readonly _tag: "ActorSink" }
  | { readonly _tag: "ActorScheduler" }
  | { readonly _tag: "SinkScheduler" }
  | { readonly _tag: "SchedulerScheduler" }
  | { readonly _tag: "SinkSink" }
  | { readonly _tag: "GeographyAny" }
  | { readonly _tag: "Denied" };

export const wireRolePair = (
  a: FactoryRole,
  b: FactoryRole,
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
    return { _tag: "SinkSink" };
  }
  return { _tag: "Denied" };
};

/**
 * Families legal for a role pair. Empty = refuse at connect.
 * Actor–scheduler: trigger XOR effect (exclusive per edge, chosen by slot).
 * Sink–scheduler: watch XOR effect (input vs output slot).
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
      SinkSink: () => [] as const,
      GeographyAny: () => [] as const,
      Denied: () => [] as const,
    }),
  );

export const connectable = (
  roleA: FactoryRole,
  roleB: FactoryRole,
): boolean => familiesForPair(wireRolePair(roleA, roleB)).length > 0;

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
): ConnectOk | ConnectRefusal => {
  const pair = wireRolePair(roleA, roleB);
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

/** Default slot when drawing a directed edge into/out of a scheduler. */
export const defaultSlotForDraw = (input: {
  readonly fromRole: FactoryRole;
  readonly toRole: FactoryRole;
}): WireSlot | undefined => {
  const { fromRole, toRole } = input;
  // sink → scheduler = watch input
  if (fromRole === "sink" && toRole === "scheduler") return "input";
  // scheduler → sink = effect output
  if (fromRole === "scheduler" && toRole === "sink") return "output";
  // actor → scheduler = trigger (agent fires the scheduler)
  if (fromRole === "actor" && toRole === "scheduler") return "trigger";
  // scheduler → actor = effect on recipient
  if (fromRole === "scheduler" && toRole === "actor") return "recipient";
  // scheduler → scheduler = upstream fires downstream (trigger on target)
  if (fromRole === "scheduler" && toRole === "scheduler") return "trigger";
  return undefined;
};

/**
 * Family color tokens (fixed forever). Renderers map these to theme hues.
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
    default: {
      const _exhaustive: never = family;
      return _exhaustive;
    }
  }
};

export const formatWireSentence = (sentence: WireSentence): string => {
  if (sentence.words.length === 0) return sentence.family;
  return `${sentence.family} · ${sentence.words.join(" · ")}`;
};

/** Build a sentence from known areas (pure; no canvas). */
export const sentenceOf = (input: {
  readonly family: WireFamily;
  readonly words?: ReadonlyArray<WireWord>;
}): WireSentence => ({
  family: input.family,
  words: input.words ?? [],
});
