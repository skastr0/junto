import { describe, expect, it } from "vitest";
import { terminalActivity } from "../src/renderer/lib/activity";
import { seatLevel, seatLine, seatUrgency } from "../src/renderer/lib/seat-line";
import { compareUrgency, Level, SeatUrgency } from "../src/shared/wire/urgency";

const words = (input: Parameters<typeof terminalActivity>[0]) => seatLine(terminalActivity(input)).text;

describe("seatLine: friendly and true for every control state", () => {
  it.each([
    [{ seatState: "working" }, "working"],
    [{ seatState: "attention" }, "wants your input"],
    [{ seatState: "attention", seatReason: "turn-stalled" }, "stalled, needs a look"],
    [{ seatState: "idle", graphBlocked: true }, "blocked"],
    [{ seatState: "idle", needsLook: true }, "done, not read yet"],
    [{ seatState: "idle" }, "resting"],
    [{ running: true, managedSeat: true }, "ready"],
    [{ managedSeat: true, seatState: "unknown" }, "not running"],
    [{ managedSeat: true }, "not running"],
    [{ seatState: "gone" }, "not running"],
    [{}, "stopped"],
    [{ starting: true }, "starting up"],
    [{ running: true, processName: "npm run dev" }, "running npm run dev"],
  ] as const)("%o reads %s", (input, expected) => {
    expect(words(input)).toBe(expected);
  });

  it("never says unknown, idle or offline: offline is a machine's word", () => {
    for (const seatState of ["unknown", "idle", "gone", "working", "attention", undefined] as const) {
      for (const managedSeat of [true, false]) {
        const text = words({ seatState, managedSeat });
        expect(text).not.toMatch(/unknown|^idle$|offline/);
      }
    }
  });
});

describe("seatLevel: where a seat sits on the one urgency ladder", () => {
  const level = (
    input: Parameters<typeof terminalActivity>[0],
    extra: { readonly signal?: "blocked" | "escalate" | "feedback"; readonly failure?: string } = {},
  ) => seatLevel({ activity: terminalActivity(input), ...extra });

  it.each([
    [{ seatState: "idle", graphBlocked: true }, {}, Level.blocked],
    [{ exitReason: "spawn_failed", managedSeat: true }, {}, Level.blocked],
    [{ managedSeat: true }, { signal: "blocked" }, Level.blocked],
    [{ managedSeat: true }, { failure: "claude is not installed" }, Level.stopped],
    [{ seatState: "attention" }, {}, Level.waiting],
    [{ seatState: "working" }, { signal: "escalate" }, Level.escalated],
    [{ seatState: "idle" }, { signal: "feedback" }, Level.review],
    [{ seatState: "idle", needsLook: true }, {}, Level.done],
    [{ seatState: "working" }, {}, Level.working],
    [{ running: true, processName: "npm run dev" }, {}, Level.working],
    [{ seatState: "idle" }, {}, Level.resting],
    [{ running: true, managedSeat: true }, {}, Level.resting],
    [{ managedSeat: true }, {}, Level.offline],
    [{ seatState: "gone" }, {}, Level.offline],
    [{}, {}, Level.offline],
  ] as const)("%o with %o is %s", (input, extra, expected) => {
    expect(level(input, extra)).toBe(expected);
  });

  it("a declared signal outranks the control state it rides on", () => {
    expect(level({ seatState: "working" }, { signal: "blocked" })).toBe(Level.blocked);
    expect(level({ seatState: "attention" }, { signal: "feedback" })).toBe(Level.waiting);
  });

  it("a failed seat joins the rail's blocked group", () => {
    const failed = seatUrgency({ activity: terminalActivity({ managedSeat: true }), failure: "claude is not installed" });
    expect(failed).toBe(SeatUrgency.group.blocked);
  });
});

describe("review and done are different levels: asked for, or only settled", () => {
  const level = (input: Parameters<typeof terminalActivity>[0], extra: { signal?: "feedback" | "blocked" | "escalate" } = {}) =>
    seatLevel({ activity: terminalActivity(input), ...extra });

  it("a feedback signal is review, a settled unread turn is done, and review comes first", () => {
    expect(level({ seatState: "idle" }, { signal: "feedback" })).toBe(Level.review);
    expect(level({ seatState: "idle", needsLook: true })).toBe(Level.done);
    expect(compareUrgency(Level.review, Level.done)).toBeLessThan(0);
    expect(compareUrgency(Level.done, Level.working)).toBeLessThan(0);
  });

  it("a feedback signal on a settled unread turn stays review", () => {
    expect(level({ seatState: "idle", needsLook: true }, { signal: "feedback" })).toBe(Level.review);
  });
});
