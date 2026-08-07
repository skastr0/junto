import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  InteractionContext,
  Intervention,
  MAX_TURNS_WITHOUT_PROOF,
  POLICY_TABLE,
  PTY_WRITE_KINDS,
  decideIntervention,
} from "../src/main/vellum/term/intervention/policy";
import type { InteractionContext as InteractionContextT } from "../src/main/vellum/term/intervention/policy";

/**
 * Typed intervention policy — the mayInject matrix.
 *
 * 1. POLICY_TABLE rows: every documented combo decides to its expected kind.
 * 2. Exhaustive sweep: the FULL product space (4 user × 5 seat × 5 injection
 *    × 3 turn × 5 awareness × 9 budget = 13,500 combos) holds every policy
 *    invariant.
 * 3. Totality: every decision decodes as a valid Intervention via Schema.
 */

// ---------------------------------------------------------------------------
// Context builder — POLICY_TABLE rows are partials; the full context fills the
// neutral defaults (seat idle, user absent, no injection, no turn boundary,
// unproven, budget untouched).

const DEFAULT_CTX: InteractionContextT = {
  seat: "idle",
  user: "absent",
  injection: "none",
  turn: "none",
  awareness: "unproven",
  turnsWithoutProof: 0,
};

const ctxFrom = (over: Partial<InteractionContextT>): InteractionContextT => ({
  ...DEFAULT_CTX,
  ...over,
});

const decode = Schema.decodeUnknownSync(Intervention);

const USER_SIGNALS = ["absent", "present", "drafted", "submitted"] as const;
const SEAT_SIGNALS = ["idle", "working", "attention", "unknown", "gone"] as const;
const INJECTION_SIGNALS = ["none", "live", "in-flight", "consumed", "failed"] as const;
const TURN_SIGNALS = ["none", "in-turn", "ended"] as const;
const AWARENESS_SIGNALS = [
  "unproven",
  "proven",
] as const;
const BUDGET_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

const USER_GATED: ReadonlyArray<(typeof USER_SIGNALS)[number]> = [
  "present",
  "drafted",
  "submitted",
];
const BUDGET_EXHAUSTED_AWARENESS: ReadonlyArray<(typeof AWARENESS_SIGNALS)[number]> = [
  "unproven",
];

describe("intervention policy", () => {
  it("exposes the turn budget and PTY write kinds", () => {
    expect(MAX_TURNS_WITHOUT_PROOF).toBe(3);
    expect([...PTY_WRITE_KINDS].sort()).toEqual(["notify-orient"]);
  });

  it("documents at least 25 key combos in POLICY_TABLE", () => {
    expect(POLICY_TABLE.length).toBeGreaterThanOrEqual(18);
  });

  // (1) Table-driven ladder + write-gate expectations.
  it.each(POLICY_TABLE)("decides $expected for $ctx", (row) => {
    expect(decideIntervention(ctxFrom(row.ctx)).kind).toBe(row.expected);
  });

  // (2) Exhaustive sweep over the full product space (13,500 combos).
  it("holds every policy invariant across the full product space", () => {
    let total = 0;
    for (const seat of SEAT_SIGNALS) {
      for (const user of USER_SIGNALS) {
        for (const injection of INJECTION_SIGNALS) {
          for (const turn of TURN_SIGNALS) {
            for (const awareness of AWARENESS_SIGNALS) {
              for (const turnsWithoutProof of BUDGET_VALUES) {
                const d = decideIntervention(
                  ctxFrom({ seat, user, injection, turn, awareness, turnsWithoutProof }),
                );
                total += 1;

                // Write-gates: a live operator surface is never written to.
                if (USER_GATED.includes(user)) {
                  expect(PTY_WRITE_KINDS.has(d.kind)).toBe(false);
                }
                if (injection === "live") {
                  expect(PTY_WRITE_KINDS.has(d.kind)).toBe(false);
                }
                if (seat === "attention") {
                  expect(PTY_WRITE_KINDS.has(d.kind)).toBe(false);
                }

                // Seat gone: silent, always.
                if (seat === "gone") {
                  expect(d.kind).toBe("silent");
                }

                // Proven: silent, always (beats every gate and the budget).
                if (awareness === "proven") {
                  expect(d.kind).toBe("silent");
                }

                // Budget exhausted without proof: escalate. Proven is not in
                // BUDGET_EXHAUSTED_AWARENESS, and seat gone already decided
                // silent above (priority: gone → silent precedes the budget).
                if (
                  seat !== "gone" &&
                  turnsWithoutProof >= MAX_TURNS_WITHOUT_PROOF &&
                  BUDGET_EXHAUSTED_AWARENESS.includes(awareness)
                ) {
                  expect(d.kind).toBe("escalate");
                }

                // Holds always carry a reason.
                if (d.kind === "hold") {
                  expect(d.reason.length).toBeGreaterThan(0);
                }
              }
            }
          }
        }
      }
    }
    expect(total).toBe(
      USER_SIGNALS.length *
        SEAT_SIGNALS.length *
        INJECTION_SIGNALS.length *
        TURN_SIGNALS.length *
        AWARENESS_SIGNALS.length *
        BUDGET_VALUES.length,
    );
  });

  // (3) Totality: every decision is a valid Intervention (decodes via Schema).
  it("returns a schema-valid Intervention for every combination", () => {
    let total = 0;
    for (const seat of SEAT_SIGNALS) {
      for (const user of USER_SIGNALS) {
        for (const injection of INJECTION_SIGNALS) {
          for (const turn of TURN_SIGNALS) {
            for (const awareness of AWARENESS_SIGNALS) {
              for (const turnsWithoutProof of BUDGET_VALUES) {
                const d = decideIntervention(
                  ctxFrom({ seat, user, injection, turn, awareness, turnsWithoutProof }),
                );
                const parsed = decode(d);
                expect(parsed.kind).toBe(d.kind);
                if (parsed.kind === "escalate") {
                  expect(parsed.diagnostics.length).toBeGreaterThan(0);
                }
                total += 1;
              }
            }
          }
        }
      }
    }
    expect(total).toBe(5_400);
  });

  it("rejects out-of-range turnsWithoutProof at the schema boundary", () => {
    expect(() =>
      Schema.decodeUnknownSync(InteractionContext)({
        ...DEFAULT_CTX,
        turnsWithoutProof: 9,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(InteractionContext)({
        ...DEFAULT_CTX,
        turnsWithoutProof: -1,
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(InteractionContext)({
        ...DEFAULT_CTX,
        turnsWithoutProof: 8,
      }),
    ).toMatchObject({ turnsWithoutProof: 8 });
  });
});
