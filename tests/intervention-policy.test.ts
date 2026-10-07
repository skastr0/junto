import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  InteractionContext,
  Intervention,
  NUDGE_AFTER_TURNS,
  POLICY_TABLE,
  PTY_WRITE_KINDS,
  decideIntervention,
} from "../src/main/junto/term/intervention/policy";
import type { InteractionContext as InteractionContextT } from "../src/main/junto/term/intervention/policy";

/**
 * Onboarding nudge policy.
 *
 * 1. POLICY_TABLE rows: every documented combo decides to its expected kind.
 * 2. One block per clause of the nudge rule: never before a first message,
 *    without waiting for the turn to end, never while drafting or on a
 *    dialog, exactly two nudges at the stated turns, none once onboarded,
 *    none after a resume of an onboarded session.
 * 3. Exhaustive sweep: the full product space holds every invariant.
 * 4. Totality: every decision decodes as a valid Intervention via Schema.
 */

// POLICY_TABLE rows are partials; the full context fills the neutral
// defaults: an unonboarded seat, mid-turn with an empty composer, that has
// been spoken to but whose turns have not been counted yet.
const DEFAULT_CTX: InteractionContextT = {
  seat: "working",
  composer: "empty",
  onboarding: "not-onboarded",
  firstMessageSeen: true,
  turnsWaited: 0,
  nudgesDelivered: 0,
  closing: false,
};

const ctxFrom = (over: Partial<InteractionContextT>): InteractionContextT => ({
  ...DEFAULT_CTX,
  ...over,
});

const decide = (over: Partial<InteractionContextT>) => decideIntervention(ctxFrom(over)).kind;
const decode = Schema.decodeUnknownSync(Intervention);

const SEAT_SIGNALS = ["idle", "working", "attention", "unknown", "gone"] as const;
const COMPOSER_SIGNALS = ["empty", "draft", "unreadable"] as const;
const ONBOARDING_SIGNALS = ["unknown", "not-onboarded", "onboarded"] as const;
const TURN_VALUES = [0, 1, 2, 3, 4, 5, 8, 50] as const;
const NUDGE_VALUES = [0, 1, 2, 3] as const;

/**
 * A session as the supervisor counts it: every turn that starts re-decides,
 * and a nudge that goes out restarts the wait. Returns the turns (1 based,
 * the first message's turn is 1) during which a nudge was sent.
 */
const nudgeTurns = (turns: number, over: Partial<InteractionContextT> = {}): number[] => {
  const sent: number[] = [];
  let turnsWaited = 0;
  let nudgesDelivered = 0;
  for (let turn = 1; turn <= turns; turn += 1) {
    turnsWaited += 1;
    if (decide({ ...over, turnsWaited, nudgesDelivered }) === "nudge") {
      sent.push(turn);
      nudgesDelivered += 1;
      turnsWaited = 0;
    }
  }
  return sent;
};

describe("intervention policy", () => {
  it("exposes the cadence and the one PTY write kind", () => {
    expect(NUDGE_AFTER_TURNS).toEqual([1, 3]);
    expect([...PTY_WRITE_KINDS]).toEqual(["nudge"]);
  });

  it.each(POLICY_TABLE)("decides $expected for $ctx", (row) => {
    expect(decideIntervention(ctxFrom(row.ctx)).kind).toBe(row.expected);
  });

  describe("never before a first real message", () => {
    it("holds an idle, empty, unonboarded seat however many turns it shows", () => {
      for (const turnsWaited of TURN_VALUES) {
        for (const nudgesDelivered of NUDGE_VALUES) {
          expect(decide({ firstMessageSeen: false, turnsWaited, nudgesDelivered })).not.toBe("nudge");
        }
      }
    });

    it("sends nothing across a whole session nobody spoke to", () => {
      expect(nudgeTurns(12, { firstMessageSeen: false })).toEqual([]);
    });
  });

  describe("does not wait for the turn to end", () => {
    it("interjects mid-turn, as soon as the first message is in", () => {
      expect(decide({ turnsWaited: 1, seat: "working" })).toBe("nudge");
    });

    it("a turn that already ended is no reason to hold either", () => {
      expect(decide({ turnsWaited: 1, seat: "idle" })).toBe("nudge");
    });

    it("a harness that paints no readable composer mid-turn is still mid-turn", () => {
      expect(decide({ turnsWaited: 1, seat: "working", composer: "unreadable" })).toBe("nudge");
    });

    it("nothing is typed before the message's turn has started", () => {
      expect(decide({ turnsWaited: 0, seat: "idle" })).toBe("hold");
      expect(decide({ turnsWaited: 0, seat: "working" })).toBe("hold");
    });
  });

  describe("never while the operator is drafting or a dialog is up", () => {
    it("holds while the operator has a draft in the composer, mid-turn or at rest", () => {
      for (const seat of ["working", "idle"] as const) {
        expect(decideIntervention(ctxFrom({ turnsWaited: 1, seat, composer: "draft" }))).toEqual({
          kind: "hold",
          reason: "draft",
        });
      }
    });

    it("holds while a dialog is up", () => {
      for (const composer of COMPOSER_SIGNALS) {
        expect(decideIntervention(ctxFrom({ turnsWaited: 1, seat: "attention", composer }))).toEqual({
          kind: "hold",
          reason: "dialog",
        });
      }
    });

    it("leaves an idle seat with an unreadable composer alone", () => {
      expect(decideIntervention(ctxFrom({ turnsWaited: 1, seat: "idle", composer: "unreadable" }))).toEqual({
        kind: "hold",
        reason: "unreadable",
      });
    });

    it("a held nudge is not lost: it goes out once the draft is gone", () => {
      expect(decide({ turnsWaited: 2, composer: "draft" })).toBe("hold");
      expect(decide({ turnsWaited: 2, composer: "empty" })).toBe("nudge");
    });
  });

  describe("exactly two nudges, at the stated turns", () => {
    it("one into the first turn, one into the third turn after it, then none", () => {
      expect(nudgeTurns(40)).toEqual([1, 4]);
    });

    it("the second waits three turns from a first that was held back", () => {
      // The first nudge was held through turns 1 and 2 (a draft) and went out
      // in turn 3: the second follows three turns after that.
      expect(decide({ turnsWaited: 3, nudgesDelivered: 0 })).toBe("nudge");
      expect(decide({ turnsWaited: 2, nudgesDelivered: 1 })).toBe("hold");
      expect(decide({ turnsWaited: 3, nudgesDelivered: 1 })).toBe("nudge");
    });

    it("never a third", () => {
      for (const turnsWaited of TURN_VALUES) {
        expect(decide({ turnsWaited, nudgesDelivered: 2 })).toBe("silent");
        expect(decide({ turnsWaited, nudgesDelivered: 3 })).toBe("silent");
      }
    });
  });

  describe("never into a session that has offboarded and waits to close", () => {
    it("is silent whatever else is true", () => {
      for (const seat of SEAT_SIGNALS) {
        for (const composer of COMPOSER_SIGNALS) {
          for (const turnsWaited of TURN_VALUES) {
            for (const nudgesDelivered of NUDGE_VALUES) {
              expect(decide({ closing: true, seat, composer, turnsWaited, nudgesDelivered })).toBe("silent");
            }
          }
        }
      }
    });

    it("a nudge that was due and held is dropped, not sent as the session ends", () => {
      expect(decide({ turnsWaited: 1, seat: "idle" })).toBe("nudge");
      expect(decide({ turnsWaited: 1, seat: "idle", closing: true })).toBe("silent");
    });
  });

  describe("stops for good once the seat onboards", () => {
    it("is silent whatever else is true", () => {
      for (const seat of SEAT_SIGNALS) {
        for (const composer of COMPOSER_SIGNALS) {
          for (const turnsWaited of TURN_VALUES) {
            for (const nudgesDelivered of NUDGE_VALUES) {
              expect(decide({ onboarding: "onboarded", seat, composer, turnsWaited, nudgesDelivered })).toBe("silent");
            }
          }
        }
      }
    });

    it("onboarding after the first nudge cancels the second", () => {
      expect(nudgeTurns(1)).toEqual([1]);
      expect(decide({ onboarding: "onboarded", nudgesDelivered: 1, turnsWaited: 3 })).toBe("silent");
    });
  });

  describe("no nudge after a resume of an onboarded session", () => {
    it("a resumed generation starts with fresh counters and is still silent", () => {
      // The resumed generation is spoken to and runs turns like any other;
      // its session's recorded status is what keeps it quiet.
      expect(nudgeTurns(12, { onboarding: "onboarded" })).toEqual([]);
    });

    it("nothing is typed while the session's status is still being read back", () => {
      expect(nudgeTurns(12, { onboarding: "unknown" })).toEqual([]);
      expect(decideIntervention(ctxFrom({ onboarding: "unknown", turnsWaited: 1 }))).toEqual({
        kind: "hold",
        reason: "loading",
      });
    });
  });

  it("holds every invariant across the full product space", () => {
    let combos = 0;
    for (const seat of SEAT_SIGNALS) {
      for (const composer of COMPOSER_SIGNALS) {
        for (const onboarding of ONBOARDING_SIGNALS) {
          for (const firstMessageSeen of [false, true]) {
            for (const turnsWaited of TURN_VALUES) {
              for (const nudgesDelivered of NUDGE_VALUES) {
               for (const closing of [false, true]) {
                combos += 1;
                const ctx = Schema.decodeUnknownSync(InteractionContext)({
                  seat,
                  composer,
                  onboarding,
                  firstMessageSeen,
                  turnsWaited,
                  nudgesDelivered,
                  closing,
                });
                const decision = decode(decideIntervention(ctx));
                if (decision.kind !== "nudge") continue;
                // A write happens only when every clause allows it.
                expect(closing).toBe(false);
                expect(onboarding).toBe("not-onboarded");
                expect(firstMessageSeen).toBe(true);
                expect(["idle", "working"]).toContain(seat);
                expect(composer).not.toBe("draft");
                if (seat === "idle") expect(composer).toBe("empty");
                expect(nudgesDelivered).toBeLessThan(NUDGE_AFTER_TURNS.length);
                expect(turnsWaited).toBeGreaterThanOrEqual(NUDGE_AFTER_TURNS[nudgesDelivered]!);
               }
              }
            }
          }
        }
      }
    }
    expect(combos).toBe(5 * 3 * 3 * 2 * 8 * 4 * 2);
  });
});
