/**
 * Typed intervention policy for the managed-terminal seat — the mayInject
 * matrix. Pure: signal values in, one Intervention decision out. Never
 * touches the PTY; the decision is the contract that the drive layer honors.
 *
 * Decision ladder (highest priority first):
 *
 *   L2  proven        → silent            (vellum awareness proven — nothing to do)
 *   gone              → silent            (seat vanished — no reachable PTY)
 *   ── escalate (canvas-only, NOT a PTY write — never gated) ──
 *   turnsWithoutProof ≥ MAX_TURNS_WITHOUT_PROOF (still unproven) → escalate
 *   ── write-gates: guard PTY writes only ──
 *   user present/drafted/submitted → hold("user")
 *   injection live    → hold("one-live")
 *   seat attention    → hold("modal")
 *   ── writes (all write-gated above) ──
 *   turn ended + unproven → notify-orient (one quiet orient notice, once per generation)
 *   else              → hold("turn")
 *
 * Structural-only: awareness is binary (unproven | proven). Text heuristics
 * were removed (live false alert) — no phrase scanning, no repair-env,
 * no socket-down inference. JUNTO_CLI is the one canonical CLI
 * location, injected at spawn; agent-facing messages never print host paths.
 *
 * The write-gates ALWAYS override every would-be PTY write: when a gate is
 * violated the decision is hold (or silent for proven/gone) regardless of
 * awareness or budget. Escalate is not a PTY write, so it stays legal even
 * under user-present — it only surfaces on the canvas.
 */

import { Schema } from "effect";
import type {
  InjectionSignal as InteractionInjectionSignal,
  TurnSignal as InteractionTurnSignal,
  UserSignal as InteractionUserSignal,
} from "../observer/interaction";

// ---------------------------------------------------------------------------
// Turn budget

/** Turns a seat may go without proof of vellum awareness before we escalate. */
export const MAX_TURNS_WITHOUT_PROOF = 3;

/**
 * Turns between orient notices.
 *
 * The floor exists because doctrine is not permanent. A Tier-B seat carries it
 * only in conversation history, and a harness that compacts its own context
 * throws it away mid-session — verified on codex-cli 0.149.1, where a forced
 * `/compact` leaves the agent answering "None" about its standing instruction.
 * Nothing in the spawn path can fix that after the fact, so the supervisor
 * re-delivers on a budget instead of assuming one delivery lasts forever.
 *
 * Two, not one: a single quiet turn is normal work, and a notice after every
 * turn would be nagging rather than a floor.
 */
export const REORIENT_EVERY_TURNS = 2;

// ---------------------------------------------------------------------------
// Signal literals
//
// `user`, `injection`, and `turn` mirror ../observer/interaction (same literal
// values, enforced by the type-level assertions at the bottom of this file).
// `seat` and `awareness` are local to this package: seat deliberately does NOT
// import agent-state, and awareness is the policy package's own vellum
// comprehension signal.

/** Is the operator at the seat, drafting, or is our own text in the box? */
export const UserSignal = Schema.Literals([
  "absent",
  "present",
  "drafted",
  "submitted",
]);
export type UserSignal = typeof UserSignal.Type;

/** Managed terminal seat state (kept local — never imported from agent-state). */
export const SeatSignal = Schema.Literals([
  "idle",
  "working",
  "attention",
  "unknown",
  "gone",
]);
export type SeatSignal = typeof SeatSignal.Type;

/** Delivery lifecycle of the last injection. */
export const InjectionSignal = Schema.Literals([
  "none",
  "live",
  "in-flight",
  "consumed",
  "failed",
]);
export type InjectionSignal = typeof InjectionSignal.Type;

/** Agent turn lifecycle relative to the seat. */
export const TurnSignal = Schema.Literals(["none", "in-turn", "ended"]);
export type TurnSignal = typeof TurnSignal.Type;

/** Junto comprehension: has the seat proven it knows vellum? */
export const AwarenessSignal = Schema.Literals(["unproven", "proven"]);
export type AwarenessSignal = typeof AwarenessSignal.Type;

// ---------------------------------------------------------------------------
// Interaction context

/**
 * Full decision input. `turnsWithoutProof` counts turns since the seat last
 * proved vellum awareness, capped at 8.
 */
export const InteractionContext = Schema.Struct({
  seat: SeatSignal,
  user: UserSignal,
  injection: InjectionSignal,
  turn: TurnSignal,
  awareness: AwarenessSignal,
  turnsWithoutProof: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
  ),
  /**
   * Orient notices already delivered to this generation. The re-orientation
   * floor is budgeted off this: a seat whose doctrine was destroyed mid-session
   * gets told again, on a schedule, rather than once at spawn and never after.
   */
  orientationsDelivered: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
  ),
  /**
   * The canvas has already been told about this generation. Escalation stays
   * once per generation, and — unlike before — it does not end the floor: a
   * seat that has been escalated keeps getting its scheduled re-orientation.
   */
  escalated: Schema.Boolean,
});
export type InteractionContext = typeof InteractionContext.Type;

// ---------------------------------------------------------------------------
// Intervention — the decision

/**
 * What the drive layer may do next. `notify-orient` is the only
 * only PTY writes (`PTY_WRITE_KINDS`); `escalate` surfaces on the canvas only.
 */
export const Intervention = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("silent") }),
  Schema.Struct({ kind: Schema.Literal("hold"), reason: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("notify-orient"),
    payload: Schema.Literal("orient"),
  }),
  Schema.Struct({
    kind: Schema.Literal("escalate"),
    diagnostics: Schema.Array(Schema.String),
  }),
]).pipe(Schema.toTaggedUnion("kind"));
export type Intervention = typeof Intervention.Type;

/** The intervention kinds that physically write to the PTY. */
export const PTY_WRITE_KINDS: ReadonlySet<string> = new Set(["notify-orient"]);

// ---------------------------------------------------------------------------
// Decision

/**
 * Total, exhaustive policy evaluation. Every input combination maps to
 * exactly one Intervention; the write-gates always win over every would-be
 * PTY write (repair-env / notify-orient), while escalate stays reachable
 * because it only surfaces on the canvas.
 */
export const decideIntervention = (ctx: InteractionContext): Intervention => {
  const { seat, user, injection, turn, awareness, turnsWithoutProof } = ctx;

  // L4 — proof of vellum awareness: nothing to do, ever.
  if (awareness === "proven") return { kind: "silent" };

  // Seat gone: no live PTY to reach. Stay quiet.
  if (seat === "gone") return { kind: "silent" };

  // ── turn budget ──────────────────────────────────────────────────────────
  // Budget exhausted without proof: escalate. Escalate is canvas-only — NOT a
  // PTY write — so the write-gates never block it (a live operator surface
  // still never gets written to: only notify-orient is a write).
  if (
    turnsWithoutProof >= MAX_TURNS_WITHOUT_PROOF &&
    awareness === "unproven" &&
    // Once per generation. Re-escalating would only repeat a canvas event the
    // operator has already seen, and it would starve the re-orientation floor
    // below — which is the part that can still fix the seat by itself.
    !ctx.escalated
  ) {
    return {
      kind: "escalate",
      diagnostics: [
        `seat unguided after ${MAX_TURNS_WITHOUT_PROOF} turns without proof of vellum awareness`,
      ],
    };
  }

  // ── write-gates ──────────────────────────────────────────────────────────
  // The gates guard PTY writes only. Any live operator surface (user at the
  // seat, our own injection still pending, or a modal) ALWAYS overrides a
  // would-be write (notify-orient) regardless of awareness or
  // budget — the decision becomes hold.
  if (user === "present" || user === "drafted" || user === "submitted") {
    return { kind: "hold", reason: "user" };
  }
  if (injection === "live") return { kind: "hold", reason: "one-live" };
  if (seat === "attention") return { kind: "hold", reason: "modal" };

  // ── unproven after a turn: the re-orientation floor ───────────────────────
  // Spawn-time delivery is not durable. A Tier-B seat holds its doctrine only
  // in conversation history, and a harness that compacts its own context
  // discards it mid-session with nothing on the spawn path able to notice.
  // So an unproven seat is re-told on a budget: one notice every
  // REORIENT_EVERY_TURNS unproven turns, each one still behind every
  // write-gate above (an operator at the keyboard, our own text still pending,
  // or a modal all win).
  //
  // The old objection to this write was the stuck `[Pasted text #N]` chip.
  // That is now handled where it belongs, in the drive: multiline paste is
  // paste → CR → evidence CR (the chip-submit), notices stay one line, and
  // prompt-pending evidence refuses to receipt a turn whose text never left
  // the composer.
  if (
    turn === "ended" &&
    awareness === "unproven" &&
    turnsWithoutProof >=
      (ctx.orientationsDelivered + 1) * REORIENT_EVERY_TURNS
  ) {
    return { kind: "notify-orient", payload: "orient" };
  }
  if (turn === "ended" && awareness === "unproven") {
    return { kind: "hold", reason: "turn" };
  }

  // Default: hold until a turn boundary or a signal change.
  return { kind: "hold", reason: "turn" };
};

// ---------------------------------------------------------------------------
// Policy matrix (documentation + table-driven tests)

/**
 * Key interesting combos across the ladder (L0-L4), the write-gates, and
 * budget exhaustion. Partials are filled with defaults by tests:
 *   { seat: "idle", user: "absent", injection: "none", turn: "none",
 *     awareness: "unproven", turnsWithoutProof: 0 }
 *
 * Gate semantics: gates block PTY writes (notify-orient / repair-env) only;
 * escalate (canvas-only) passes them — see the socket-down / budget rows
 * combined with user/injection/attention below.
 */
export const POLICY_TABLE: ReadonlyArray<{
  readonly ctx: Partial<InteractionContext>;
  readonly expected: Intervention["kind"];
}> = [
  // ── L4: proven ────────────────────────────────────────────────────────────
  { ctx: { awareness: "proven" }, expected: "silent" },
  // Proof beats every gate and the budget.
  { ctx: { awareness: "proven", user: "present" }, expected: "silent" },
  { ctx: { awareness: "proven", turnsWithoutProof: 8 }, expected: "silent" },

  // ── L3: environment / socket ──────────────────────────────────────────────
  // Budget exhaustion beats the first repair attempt.

    // Budget exhaustion beats the orient notice.

  // ── L1: unproven, turn ended — the budgeted re-orientation floor ──────────
  // One quiet turn is ordinary work, so the first notice waits for the second.
  { ctx: { turn: "ended" }, expected: "hold" },
  { ctx: { turn: "ended", turnsWithoutProof: 1 }, expected: "hold" },
  { ctx: { turn: "ended", turnsWithoutProof: 2 }, expected: "notify-orient" },
  // A notice already spent buys the next two turns of quiet.
  {
    ctx: { turn: "ended", turnsWithoutProof: 2, orientationsDelivered: 1 },
    expected: "hold",
  },
  {
    ctx: {
      turn: "ended",
      turnsWithoutProof: 4,
      orientationsDelivered: 1,
      escalated: true,
    },
    expected: "notify-orient",
  },
  // The floor outlives escalation: the canvas has been told once, and the seat
  // is still being re-oriented in case it can fix itself.
  {
    ctx: {
      turn: "ended",
      turnsWithoutProof: 4,
      orientationsDelivered: 1,
      escalated: true,
    },
    expected: "notify-orient",
  },
  // Write-gates still win over the floor, exactly as over any PTY write.
  {
    ctx: { turn: "ended", turnsWithoutProof: 2, user: "drafted" },
    expected: "hold",
  },
  // Budget exhaustion escalates to the canvas (never a PTY write), once.
  { ctx: { turn: "ended", turnsWithoutProof: 3 }, expected: "escalate" },
  { ctx: { turn: "ended", turnsWithoutProof: 8 }, expected: "escalate" },
  {
    ctx: { turn: "ended", turnsWithoutProof: 8, escalated: true },
    expected: "notify-orient",
  },

  // ── L0: unproven, no boundary yet ─────────────────────────────────────────
  { ctx: {}, expected: "hold" },
  { ctx: { turn: "in-turn" }, expected: "hold" },
  { ctx: { seat: "working", turn: "in-turn" }, expected: "hold" },
  { ctx: { turn: "none", turnsWithoutProof: 2 }, expected: "hold" },
  { ctx: { turnsWithoutProof: 3 }, expected: "escalate" },
  { ctx: { turnsWithoutProof: 8, turn: "none" }, expected: "escalate" },

  // ── escalate passes the write-gates (canvas-only, not a PTY write) ────────
  { ctx: { user: "present", turnsWithoutProof: 3 }, expected: "escalate" },

  // ── write-gates: user (block PTY writes, always) ──────────────────────────
  { ctx: { user: "drafted", turn: "ended" }, expected: "hold" },

  // ── write-gates: injection live ───────────────────────────────────────────
  { ctx: { injection: "live", awareness: "unproven", turnsWithoutProof: 2 }, expected: "hold" },

  // ── write-gates: seat attention ───────────────────────────────────────────

  // ── seat gone ─────────────────────────────────────────────────────────────
  { ctx: { seat: "gone" }, expected: "silent" },
  { ctx: { seat: "gone", user: "present" }, expected: "silent" },
];

// ---------------------------------------------------------------------------
// Compile-time guard: the user/injection/turn literal sets MUST stay in sync
// with ../observer/interaction. If that package's union ever drifts, this
// module fails to typecheck.

type AssertSameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type _UserSignalMatchesInteraction = AssertSameUnion<UserSignal, InteractionUserSignal>;
type _InjectionSignalMatchesInteraction = AssertSameUnion<
  InjectionSignal,
  InteractionInjectionSignal
>;
type _TurnSignalMatchesInteraction = AssertSameUnion<TurnSignal, InteractionTurnSignal>;
