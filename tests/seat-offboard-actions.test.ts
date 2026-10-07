import { describe, expect, it } from "vitest";
import {
  askOffboardLine,
  offboardIdleLine,
  offboardLineTone,
  offboardNowBlock,
  offboardNowLine,
  offboardPreferred,
  parseOffboardMinutes,
  planOffboardRulesChange,
  seedHarnessOverride,
} from "../src/renderer/lib/seat-offboard";
import { DEFAULT_OFFBOARD_RULES } from "../src/shared/seat-offboard";
import type {
  OffboardRefusalCode,
  SeatOffboardRunRow,
  SeatOffboardStatus,
} from "../src/shared/seat-offboard";

const closed = (seatId = "s"): SeatOffboardRunRow => ({ seatId, ok: true, action: "now", outcome: "closed", pastWindow: true });
const asked = (seatId = "s"): SeatOffboardRunRow => ({ seatId, ok: true, action: "ask", outcome: "asked", pastWindow: false });
const refused = (code: OffboardRefusalCode, reason = "This seat is working. Offboard now only closes a seat that is idle, offline or resting."): SeatOffboardRunRow => ({
  seatId: "s",
  ok: false,
  code,
  reason,
});

const status = (over: Partial<SeatOffboardStatus> = {}): SeatOffboardStatus => ({
  seatId: "s",
  now: { allowed: true },
  idleMinutes: 12,
  pastWindow: false,
  preferred: "ask",
  ...over,
});
const working: SeatOffboardStatus["now"] = {
  allowed: false,
  code: "working",
  reason: "This seat is working. Offboard now only closes a seat that is idle, offline or resting.",
};

describe("the line after offboard now", () => {
  it("counts what closed and why the rest did not", () => {
    expect(offboardNowLine([...Array.from({ length: 8 }, () => closed()), refused("working"), refused("working")])).toBe(
      "8 closed, 2 are working",
    );
  });
  it("speaks in the singular", () => {
    expect(offboardNowLine([closed(), refused("working")])).toBe("1 closed, 1 is working");
  });
  it("gives one seat main's own sentence", () => {
    expect(offboardNowLine([refused("working")])).toBe(
      "Not closed. This seat is working. Offboard now only closes a seat that is idle, offline or resting.",
    );
    expect(offboardNowLine([closed()])).toBe("Session closed. The seat is resting.");
  });
  it("has words for each way a seat is not closable, and one count for the rest", () => {
    expect(
      offboardNowLine([
        closed(),
        refused("attention"),
        refused("closing"),
        refused("not-local"),
        refused("not-a-seat"),
        refused("failed"),
        refused("undelivered"),
      ]),
    ).toBe(
      "1 closed, 1 is waiting on you, 1 is already closing, 1 runs on another installation, 1 is not an agent, 2 could not be closed",
    );
  });
  it("says so when nothing was closed, and when there was nothing to close", () => {
    expect(offboardNowLine([refused("working"), refused("working")])).toBe("None closed: 2 are working");
    expect(offboardNowLine([])).toBe("No agent to close.");
  });
});

describe("the line after asking to offboard", () => {
  it("names the mode and counts", () => {
    expect(askOffboardLine("continue", [asked()])).toBe("Asked to offboard and continue.");
    expect(askOffboardLine("rest", [asked()])).toBe("Asked to offboard and rest.");
    expect(askOffboardLine("continue", [asked(), asked(), asked()])).toBe("Asked 3 agents to offboard and continue");
  });
  it("says how many could not be asked, and one seat's reason in full", () => {
    expect(askOffboardLine("continue", [asked(), asked(), refused("undelivered")])).toBe(
      "Asked 2 agents to offboard and continue, 1 could not be asked",
    );
    expect(askOffboardLine("continue", [asked(), refused("not-local"), refused("not-local")])).toBe(
      "Asked 1 agent to offboard and continue, 2 run on another installation",
    );
    expect(askOffboardLine("rest", [refused("not-local", "This seat runs on another installation.")])).toBe(
      "Not asked. This seat runs on another installation.",
    );
    expect(askOffboardLine("rest", [refused("undelivered"), refused("undelivered")])).toBe("None asked: 2 could not be asked");
  });
});

describe("the colour of a result line", () => {
  it("is done, partial or refused", () => {
    expect(offboardLineTone([closed(), closed()])).toBe("done");
    expect(offboardLineTone([closed(), refused("working")])).toBe("partial");
    expect(offboardLineTone([refused("working")])).toBe("refused");
    expect(offboardLineTone([])).toBe("refused");
  });
});

describe("what the operator reads before pressing", () => {
  it("one seat: how long it has sat still and which side of the cache window", () => {
    expect(offboardIdleLine([status({ idleMinutes: 12 })])).toBe("Idle 12m, inside the cache window: a turn is still cheap.");
    expect(offboardIdleLine([status({ idleMinutes: 72, pastWindow: true })])).toBe(
      "Idle 1h 12m, past the cache window: a turn now is expensive.",
    );
    expect(offboardIdleLine([status({ idleMinutes: 120, pastWindow: true })])).toMatch(/^Idle 2h, past/u);
  });
  it("one seat that is moving, or not known yet, gets no idle line", () => {
    expect(offboardIdleLine([status({ idleMinutes: null })])).toBe("");
    expect(offboardIdleLine([])).toBe("");
  });
  it("a selection: how many are past the window", () => {
    const past = status({ pastWindow: true, preferred: "now" });
    expect(offboardIdleLine([status(), status()])).toBe("None is past the cache window.");
    expect(offboardIdleLine([past, status(), past])).toBe("2 of 3 are past the cache window.");
    expect(offboardIdleLine([past, past])).toBe("Both are past the cache window.");
    expect(offboardIdleLine([past, past, past])).toBe("All 3 are past the cache window.");
  });
  it("marks a preferred action for one seat only", () => {
    expect(offboardPreferred([status({ preferred: "now" })])).toBe("now");
    expect(offboardPreferred([status({ preferred: "ask" })])).toBe("ask");
    expect(offboardPreferred([status({ preferred: "now" }), status({ preferred: "now" })])).toBeUndefined();
    expect(offboardPreferred([])).toBeUndefined();
  });
});

describe("offboard now before the press", () => {
  it("is open when the seat may be closed, or while nothing is known yet", () => {
    expect(offboardNowBlock([status()])).toBeUndefined();
    expect(offboardNowBlock([])).toBeUndefined();
  });
  it("one seat: closed with main's reason", () => {
    expect(offboardNowBlock([status({ now: working })])).toBe(working.reason);
  });
  it("a selection: open while any seat can be closed", () => {
    expect(offboardNowBlock([status({ now: working }), status()])).toBeUndefined();
    expect(offboardNowBlock([status({ now: working }), status({ now: working })])).toBe(
      "None of these agents can be closed right now.",
    );
  });
});

describe("a change to the automatic rules, before it is saved", () => {
  it("passes a change that keeps the order: nudge, then the cache window, then auto offboard", () => {
    expect(planOffboardRulesChange(DEFAULT_OFFBOARD_RULES, { nudge: { enabled: true } })).toEqual({
      ok: true,
      patch: { nudge: { enabled: true } },
    });
    expect(planOffboardRulesChange(DEFAULT_OFFBOARD_RULES, { cacheWindowMinutes: 90 }).ok).toBe(true);
  });
  it("refuses a nudge at or after the window, and an auto offboard before it, in plain words", () => {
    const late = planOffboardRulesChange(DEFAULT_OFFBOARD_RULES, { nudge: { minutes: 60 } });
    expect(late.ok).toBe(false);
    expect(late.ok === false && late.problem).toMatch(/^The idle nudge must come before the cache window \(60 min\)/u);
    const early = planOffboardRulesChange(DEFAULT_OFFBOARD_RULES, { auto: { minutes: 45 } });
    expect(early.ok === false && early.problem).toMatch(/^The auto offboard must come at or after the cache window \(60 min\)/u);
  });
  it("refuses a window change that would strand a rule, even one that is off", () => {
    // The nudge is off at 40 minutes; a 30 minute window would leave it after the window.
    expect(planOffboardRulesChange(DEFAULT_OFFBOARD_RULES, { cacheWindowMinutes: 30 }).ok).toBe(false);
    // And a 3 hour window would leave auto offboard (2 h) inside it.
    expect(planOffboardRulesChange(DEFAULT_OFFBOARD_RULES, { cacheWindowMinutes: 180 }).ok).toBe(false);
  });
  it("judges a harness override against that harness's own window, and names the harness", () => {
    const seeded = seedHarnessOverride(DEFAULT_OFFBOARD_RULES, "codex");
    expect(seeded).toEqual({
      harness: { codex: { cacheWindowMinutes: 60, auto: { minutes: 120 }, nudge: { minutes: 40 } } },
    });
    expect(planOffboardRulesChange(DEFAULT_OFFBOARD_RULES, seeded).ok).toBe(true);
    const bad = planOffboardRulesChange(DEFAULT_OFFBOARD_RULES, { harness: { codex: { cacheWindowMinutes: 30 } } });
    expect(bad.ok === false && bad.problem).toContain("for codex");
  });
});

describe("a minutes field", () => {
  it("takes whole minutes from 1 to 7 days, and nothing else", () => {
    expect(parseOffboardMinutes("40")).toBe(40);
    expect(parseOffboardMinutes(" 1 ")).toBe(1);
    expect(parseOffboardMinutes("10080")).toBe(10080);
    for (const raw of ["", "0", "10081", "2.5", "-3", "1e2", "forty"]) expect(parseOffboardMinutes(raw)).toBeUndefined();
  });
});
