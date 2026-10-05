/**
 * Onboarding nudge policy for the managed-terminal seat. Pure: signal values
 * in, one Intervention decision out. Never touches the PTY; the decision is
 * the contract the supervisor honors, and the drive's own gate still has the
 * last word on every write.
 *
 * Nothing is sent to a seat at session start. A seat learns it is a seat by
 * running `junto onboard`, pointed there by its mail or by this nudge: one
 * sentence, at most twice per generation.
 *
 * The nudge is an interjection, not an end-of-turn note. A turn can run for
 * hours, so it goes in as soon as it can no longer get in the way of the
 * message that started the turn: that message has been submitted, the
 * composer holds no draft, and no dialog is up. The harness queues or steers
 * what it receives mid-turn, as it does mail.
 *
 * Decision ladder (highest priority first):
 *
 *   onboarded            → silent            (`junto onboard` ran in this harness session)
 *   seat gone            → silent            (no reachable PTY)
 *   onboarding unknown   → hold("loading")   (a resumed session's status is still being read)
 *   no first message     → hold("no-message")(the session has not been spoken to yet)
 *   budget spent         → silent            (NUDGE_AFTER_TURNS.length nudges delivered)
 *   not due yet          → hold("turn")
 *   ── write-gates ──
 *   seat attention       → hold("dialog")
 *   seat state unknown   → hold("unsettled")
 *   composer draft       → hold("draft")     (the operator is drafting)
 *   idle + unreadable    → hold("unreadable")(a transition or an unprobed box)
 *   else                 → nudge             (idle or mid-turn)
 *
 * No compaction detection and no periodic re-orientation: a seat that loses
 * track shows as such, and the operator has a button.
 */

import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Cadence

/**
 * Turns that must have STARTED before each nudge. The first counts from the
 * first real message into the session, each later one from the nudge before
 * it: one into the first turn, one more into the third turn after that, then
 * none. Starts, not completions: waiting for a turn to end can be hours late.
 */
export const NUDGE_AFTER_TURNS: ReadonlyArray<number> = [1, 3];

// ---------------------------------------------------------------------------
// Signal literals

/** Managed terminal seat state (kept local — never imported from agent-state). */
export const SeatSignal = Schema.Literals([
  "idle",
  "working",
  "attention",
  "unknown",
  "gone",
]);
export type SeatSignal = typeof SeatSignal.Type;

/**
 * The composer as the harness's own probes read it: the drive's write gate.
 * Only `empty` is typeable; `unreadable` covers a dialog over the box, a
 * transition, and a harness with no composer probes.
 */
export const ComposerSignal = Schema.Literals(["empty", "draft", "unreadable"]);
export type ComposerSignal = typeof ComposerSignal.Type;

/**
 * Has `junto onboard` run in this seat's current harness session? `unknown`
 * while a resumed session's recorded status is still being read.
 */
export const OnboardingSignal = Schema.Literals([
  "unknown",
  "not-onboarded",
  "onboarded",
]);
export type OnboardingSignal = typeof OnboardingSignal.Type;

// ---------------------------------------------------------------------------
// Interaction context

const Count = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

export const InteractionContext = Schema.Struct({
  seat: SeatSignal,
  composer: ComposerSignal,
  onboarding: OnboardingSignal,
  /**
   * A first real message has gone into this generation's session: one the
   * operator typed and submitted, or mail.
   */
  firstMessageSeen: Schema.Boolean,
  /**
   * Turns started since (and including) the first message, or since the last
   * delivered nudge once there is one.
   */
  turnsWaited: Count,
  /** Nudges delivered to this generation. */
  nudgesDelivered: Count,
});
export type InteractionContext = typeof InteractionContext.Type;

// ---------------------------------------------------------------------------
// Intervention — the decision

/** What the supervisor may do next. `nudge` is the only PTY write. */
export const Intervention = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("silent") }),
  Schema.Struct({ kind: Schema.Literal("hold"), reason: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("nudge") }),
]).pipe(Schema.toTaggedUnion("kind"));
export type Intervention = typeof Intervention.Type;

/** The intervention kinds that physically write to the PTY. */
export const PTY_WRITE_KINDS: ReadonlySet<string> = new Set(["nudge"]);

// ---------------------------------------------------------------------------
// Decision

/**
 * Total, exhaustive policy evaluation. Every input combination maps to
 * exactly one Intervention.
 */
export const decideIntervention = (ctx: InteractionContext): Intervention => {
  if (ctx.onboarding === "onboarded") return { kind: "silent" };
  if (ctx.seat === "gone") return { kind: "silent" };
  if (ctx.onboarding === "unknown") return { kind: "hold", reason: "loading" };

  // A fresh seat opens to the harness's own empty composer and stays that
  // way until someone speaks to it.
  if (!ctx.firstMessageSeen) return { kind: "hold", reason: "no-message" };

  const wait = NUDGE_AFTER_TURNS[ctx.nudgesDelivered];
  if (wait === undefined) return { kind: "silent" };
  if (ctx.turnsWaited < wait) return { kind: "hold", reason: "turn" };

  // ── write-gates ──────────────────────────────────────────────────────────
  // The nudge may land mid-turn, but never on top of something of the
  // operator's: a dialog waiting for an answer, or a draft in the composer.
  if (ctx.seat === "attention") return { kind: "hold", reason: "dialog" };
  if (ctx.seat !== "idle" && ctx.seat !== "working") {
    return { kind: "hold", reason: "unsettled" };
  }
  if (ctx.composer === "draft") return { kind: "hold", reason: "draft" };
  // Mid-turn a harness may not paint a composer the probes can read; that is
  // the turn, not a dialog (a dialog is `attention`). At rest an unreadable
  // box is a transition or an unprobed harness, and is left alone.
  if (ctx.seat === "idle" && ctx.composer !== "empty") {
    return { kind: "hold", reason: "unreadable" };
  }

  return { kind: "nudge" };
};

// ---------------------------------------------------------------------------
// Policy matrix (documentation + table-driven tests)

/**
 * Key combos across the ladder. Partials are filled with defaults by tests:
 *   { seat: "working", composer: "empty", onboarding: "not-onboarded",
 *     firstMessageSeen: true, turnsWaited: 0, nudgesDelivered: 0 }
 */
export const POLICY_TABLE: ReadonlyArray<{
  readonly ctx: Partial<InteractionContext>;
  readonly expected: Intervention["kind"];
}> = [
  // ── onboarded: nothing to do, ever ────────────────────────────────────────
  { ctx: { onboarding: "onboarded" }, expected: "silent" },
  { ctx: { onboarding: "onboarded", turnsWaited: 9 }, expected: "silent" },
  // A resumed session whose status is still loading is never written to.
  { ctx: { onboarding: "unknown", turnsWaited: 9 }, expected: "hold" },

  // ── never before a first real message ─────────────────────────────────────
  { ctx: { firstMessageSeen: false }, expected: "hold" },
  { ctx: { firstMessageSeen: false, turnsWaited: 9 }, expected: "hold" },

  // ── cadence: into the first turn, then into the third turn after ──────────
  { ctx: { turnsWaited: 0 }, expected: "hold" },
  { ctx: { turnsWaited: 1 }, expected: "nudge" },
  { ctx: { nudgesDelivered: 1, turnsWaited: 0 }, expected: "hold" },
  { ctx: { nudgesDelivered: 1, turnsWaited: 2 }, expected: "hold" },
  { ctx: { nudgesDelivered: 1, turnsWaited: 3 }, expected: "nudge" },
  // Then none, however long the seat stays unonboarded.
  { ctx: { nudgesDelivered: 2, turnsWaited: 3 }, expected: "silent" },
  { ctx: { nudgesDelivered: 2, turnsWaited: 99 }, expected: "silent" },

  // ── it does not wait for the turn to end ──────────────────────────────────
  { ctx: { turnsWaited: 1, seat: "working" }, expected: "nudge" },
  { ctx: { turnsWaited: 1, seat: "idle" }, expected: "nudge" },
  // A harness that paints no readable composer mid-turn is still mid-turn.
  { ctx: { turnsWaited: 1, seat: "working", composer: "unreadable" }, expected: "nudge" },
  { ctx: { turnsWaited: 1, seat: "unknown" }, expected: "hold" },
  // ── never while the operator is drafting or a dialog is up ────────────────
  { ctx: { turnsWaited: 1, composer: "draft" }, expected: "hold" },
  { ctx: { turnsWaited: 1, seat: "idle", composer: "draft" }, expected: "hold" },
  { ctx: { turnsWaited: 1, seat: "idle", composer: "unreadable" }, expected: "hold" },
  { ctx: { turnsWaited: 1, seat: "attention" }, expected: "hold" },
  { ctx: { nudgesDelivered: 1, turnsWaited: 3, composer: "draft" }, expected: "hold" },

  // ── seat gone ─────────────────────────────────────────────────────────────
  { ctx: { seat: "gone", turnsWaited: 1 }, expected: "silent" },
];
