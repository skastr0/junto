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
 *    never while drafting or on a dialog, exactly two nudges at the stated
 *    turns, none once onboarded, none after a resume of an onboarded session.
 * 3. Exhaustive sweep: the full product space holds every invariant.
 * 4. Totality: every decision decodes as a valid Intervention via Schema.
 */

// POLICY_TABLE rows are partials; the full context fills the neutral
// defaults: an idle, unonboarded seat with an empty composer that has been
// spoken to and has not completed a turn since.
const DEFAULT_CTX: InteractionContextT = {
  seat: "idle",
  composer: "empty",
  onboarding: "not-onboarded",
  firstMessageSeen: true,
  turnsWaited: 0,
  nudgesDelivered: 0,
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
 * A session as the supervisor counts it: every completed turn re-decides, and
 * a nudge that goes out restarts the wait. Returns the completed turns (1
 * based, since the first message) after which a nudge was sent.
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

  describe("only at a completed turn, never while drafting or on a dialog", () => {
    it("holds while the operator has a draft in the composer", () => {
      expect(decideIntervention(ctxFrom({ turnsWaited: 1, composer: "draft" }))).toEqual({
        kind: "hold",
        reason: "draft",
      });
    });

    it("holds while a dialog is up", () => {
      expect(decideIntervention(ctxFrom({ turnsWaited: 1, seat: "attention" }))).toEqual({
        kind: "hold",
        reason: "dialog",
      });
      // A dialog painted over the composer makes it unreadable too.
      expect(decide({ turnsWaited: 1, composer: "unreadable" })).toBe("hold");
    });

    it("holds mid-turn", () => {
      expect(decide({ turnsWaited: 1, seat: "working" })).toBe("hold");
      expect(decide({ nudgesDelivered: 1, turnsWaited: 3, seat: "working" })).toBe("hold");
    });

    it("a held nudge is not lost: it goes out once the draft is gone", () => {
      expect(decide({ turnsWaited: 2, composer: "draft" })).toBe("hold");
      expect(decide({ turnsWaited: 2, composer: "empty" })).toBe("nudge");
    });
  });

  describe("exactly two nudges, at the stated turns", () => {
    it("one after the first completed turn, one three completed turns later, then none", () => {
      expect(nudgeTurns(40)).toEqual([1, 4]);
    });

    it("the second waits three turns from a first that was held back", () => {
      // The first nudge was held through turns 1 and 2 (a draft) and went out
      // after turn 3: the second follows three completed turns after that.
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
      // The resumed generation is spoken to and completes turns like any
      // other; its session's recorded status is what keeps it quiet.
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
                combos += 1;
                const ctx = Schema.decodeUnknownSync(InteractionContext)({
                  seat,
                  composer,
                  onboarding,
                  firstMessageSeen,
                  turnsWaited,
                  nudgesDelivered,
                });
                const decision = decode(decideIntervention(ctx));
                if (decision.kind !== "nudge") continue;
                // A write happens only when every clause allows it.
                expect(onboarding).toBe("not-onboarded");
                expect(firstMessageSeen).toBe(true);
                expect(seat).toBe("idle");
                expect(composer).toBe("empty");
                expect(nudgesDelivered).toBeLessThan(NUDGE_AFTER_TURNS.length);
                expect(turnsWaited).toBeGreaterThanOrEqual(NUDGE_AFTER_TURNS[nudgesDelivered]!);
              }
            }
          }
        }
      }
    }
    expect(combos).toBe(5 * 3 * 3 * 2 * 8 * 4);
  });
});
