/**
 * Typed intervention policy for the managed-terminal seat — the mayInject
 * matrix. Pure: signal values in, one Intervention decision out. Never
 * touches the PTY; the decision is the contract that the drive layer honors.
 *
 * Decision ladder (highest priority first):
 *
 *   L4  proven        → silent            (vellum awareness proven — nothing to do)
 *   gone              → silent            (seat vanished — no reachable PTY)
 *   ── escalate (canvas-only, NOT a PTY write — never gated) ──
 *   turnsWithoutProof ≥ MAX_TURNS_WITHOUT_PROOF (and still unproven/confused/
 *       env-broken/socket-down) → escalate
 *   socket-down       → escalate
 *   ── write-gates: guard PTY writes only ──
 *   user present/drafted/submitted → hold("user")
 *   injection live    → hold("one-live")
 *   seat attention    → hold("modal")
 *   ── writes (all write-gated above) ──
 *   env-broken        → repair-env        (first repair attempt, budget not spent)
 *   confused          → notify-orient
 *   turn ended + unproven → notify-orient (one quiet orient notice)
 *   else              → hold("turn")
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

/** Vellum comprehension: has the seat proven it knows vellum? */
export const AwarenessSignal = Schema.Literals([
  "unproven",
  "proven",
  "confused",
  "env-broken",
  "socket-down",
]);
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
});
export type InteractionContext = typeof InteractionContext.Type;

// ---------------------------------------------------------------------------
// Intervention — the decision

/**
 * What the drive layer may do next. `notify-orient` and `repair-env` are the
 * only PTY writes (`PTY_WRITE_KINDS`); `escalate` surfaces on the canvas only.
 */
export const Intervention = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("silent") }),
  Schema.Struct({ kind: Schema.Literal("hold"), reason: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("notify-orient"),
    payload: Schema.Literal("orient"),
  }),
  Schema.Struct({ kind: Schema.Literal("repair-env") }),
  Schema.Struct({
    kind: Schema.Literal("escalate"),
    diagnostics: Schema.Array(Schema.String),
  }),
]).pipe(Schema.toTaggedUnion("kind"));
export type Intervention = typeof Intervention.Type;

/** The intervention kinds that physically write to the PTY. */
export const PTY_WRITE_KINDS: ReadonlySet<string> = new Set([
  "notify-orient",
  "repair-env",
]);

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
  // still never gets written to: only notify-orient/repair-env are writes).
  if (turnsWithoutProof >= MAX_TURNS_WITHOUT_PROOF) {
    if (awareness === "unproven") {
      return {
        kind: "escalate",
        diagnostics: [
          `seat unguided after ${MAX_TURNS_WITHOUT_PROOF} turns without proof of vellum awareness`,
        ],
      };
    }
    if (awareness === "confused") {
      return {
        kind: "escalate",
        diagnostics: [
          `seat still confused about vellum after ${MAX_TURNS_WITHOUT_PROOF} turns without proof`,
        ],
      };
    }
    if (awareness === "env-broken") {
      return {
        kind: "escalate",
        diagnostics: [
          `environment still broken after ${MAX_TURNS_WITHOUT_PROOF} turns without proof`,
          "repair-env did not converge",
        ],
      };
    }
    if (awareness === "socket-down") {
      return {
        kind: "escalate",
        diagnostics: [
          `vellum control socket still down after ${MAX_TURNS_WITHOUT_PROOF} turns without proof`,
        ],
      };
    }
  }

  // Control socket unreachable: escalate at any budget (canvas-only surface).
  if (awareness === "socket-down") {
    return {
      kind: "escalate",
      diagnostics: ["vellum control socket down; seat cannot reach the work plane"],
    };
  }

  // ── write-gates ──────────────────────────────────────────────────────────
  // The gates guard PTY writes only. Any live operator surface (user at the
  // seat, our own injection still pending, or a modal) ALWAYS overrides a
  // would-be write (repair-env / notify-orient) regardless of awareness or
  // budget — the decision becomes hold.
  if (user === "present" || user === "drafted" || user === "submitted") {
    return { kind: "hold", reason: "user" };
  }
  if (injection === "live") return { kind: "hold", reason: "one-live" };
  if (seat === "attention") return { kind: "hold", reason: "modal" };

  // ── awareness-driven writes (all write-gated above) ──────────────────────
  // First repair attempt before escalating repeat failures.
  if (awareness === "env-broken") return { kind: "repair-env" };
  // Confused about what vellum is: a compact orient notice — the full
  // doctrine was already delivered at spawn; re-injecting it is noise.
  if (awareness === "confused") {
    return { kind: "notify-orient", payload: "orient" };
  }
  // Turn over, still unproven: one compact orient notice, never the full
  // doctrine (agents reported repeated full re-injection as spam).
  if (turn === "ended" && awareness === "unproven") {
    return { kind: "notify-orient", payload: "orient" };
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
  { ctx: { awareness: "socket-down" }, expected: "escalate" },
  { ctx: { awareness: "socket-down", turnsWithoutProof: 5 }, expected: "escalate" },
  { ctx: { awareness: "env-broken" }, expected: "repair-env" },
  { ctx: { awareness: "env-broken", turn: "ended" }, expected: "repair-env" },
  // Budget exhaustion beats the first repair attempt.
  { ctx: { awareness: "env-broken", turnsWithoutProof: 3 }, expected: "escalate" },
  { ctx: { awareness: "env-broken", turnsWithoutProof: 8 }, expected: "escalate" },

  // ── L2: confused ──────────────────────────────────────────────────────────
  { ctx: { awareness: "confused" }, expected: "notify-orient" },
  { ctx: { awareness: "confused", turn: "in-turn" }, expected: "notify-orient" },
  { ctx: { awareness: "confused", turnsWithoutProof: 2 }, expected: "notify-orient" },
  // Budget exhaustion beats the orient notice.
  { ctx: { awareness: "confused", turnsWithoutProof: 3 }, expected: "escalate" },
  { ctx: { awareness: "confused", turnsWithoutProof: 8, turn: "none" }, expected: "escalate" },

  // ── L1: unproven, turn ended ──────────────────────────────────────────────
  { ctx: { turn: "ended" }, expected: "notify-orient" },
  { ctx: { turn: "ended", turnsWithoutProof: 2 }, expected: "notify-orient" },
  // Budget exhaustion beats the end-of-turn orient notice.
  { ctx: { turn: "ended", turnsWithoutProof: 3 }, expected: "escalate" },
  { ctx: { turn: "ended", turnsWithoutProof: 8 }, expected: "escalate" },

  // ── L0: unproven, no boundary yet ─────────────────────────────────────────
  { ctx: {}, expected: "hold" },
  { ctx: { turn: "in-turn" }, expected: "hold" },
  { ctx: { seat: "working", turn: "in-turn" }, expected: "hold" },
  { ctx: { turn: "none", turnsWithoutProof: 2 }, expected: "hold" },
  { ctx: { turnsWithoutProof: 3 }, expected: "escalate" },
  { ctx: { turnsWithoutProof: 8, turn: "none" }, expected: "escalate" },

  // ── escalate passes the write-gates (canvas-only, not a PTY write) ────────
  { ctx: { user: "present", awareness: "socket-down" }, expected: "escalate" },
  { ctx: { user: "present", turnsWithoutProof: 3 }, expected: "escalate" },
  { ctx: { injection: "live", turnsWithoutProof: 8, awareness: "socket-down" }, expected: "escalate" },
  { ctx: { seat: "attention", turnsWithoutProof: 8, awareness: "confused" }, expected: "escalate" },

  // ── write-gates: user (block PTY writes, always) ──────────────────────────
  { ctx: { user: "present", awareness: "confused" }, expected: "hold" },
  { ctx: { user: "drafted", awareness: "env-broken" }, expected: "hold" },
  { ctx: { user: "submitted", awareness: "env-broken" }, expected: "hold" },
  { ctx: { user: "drafted", turn: "ended" }, expected: "hold" },
  { ctx: { user: "present", awareness: "confused", turnsWithoutProof: 2 }, expected: "hold" },

  // ── write-gates: injection live ───────────────────────────────────────────
  { ctx: { injection: "live", awareness: "env-broken" }, expected: "hold" },
  { ctx: { injection: "live", awareness: "confused", turn: "ended" }, expected: "hold" },
  { ctx: { injection: "live", awareness: "unproven", turnsWithoutProof: 2 }, expected: "hold" },

  // ── write-gates: seat attention ───────────────────────────────────────────
  { ctx: { seat: "attention", awareness: "env-broken" }, expected: "hold" },
  { ctx: { seat: "attention", awareness: "confused" }, expected: "hold" },

  // ── seat gone ─────────────────────────────────────────────────────────────
  { ctx: { seat: "gone" }, expected: "silent" },
  { ctx: { seat: "gone", user: "present" }, expected: "silent" },
  { ctx: { seat: "gone", turnsWithoutProof: 8, awareness: "env-broken" }, expected: "silent" },
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
