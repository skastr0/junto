import { describe, expect, it } from "vitest";
import { terminalActivity } from "../src/renderer/lib/activity";
import { PALETTE_RANK, paletteRank, SEAT_URGENCY, seatLine, seatUrgency } from "../src/renderer/lib/seat-line";

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

describe("seatUrgency: blocked, waiting on you, review, working, resting, offline", () => {
  const urgency = (
    input: Parameters<typeof terminalActivity>[0],
    extra: { readonly signal?: "blocked" | "escalate" | "feedback"; readonly failure?: string } = {},
  ) => seatUrgency({ activity: terminalActivity(input), ...extra });

  it.each([
    [{ seatState: "idle", graphBlocked: true }, {}, SEAT_URGENCY.blocked],
    [{ exitReason: "spawn_failed", managedSeat: true }, {}, SEAT_URGENCY.blocked],
    [{ managedSeat: true }, { signal: "blocked" }, SEAT_URGENCY.blocked],
    [{ seatState: "attention" }, {}, SEAT_URGENCY.waiting],
    [{ seatState: "working" }, { signal: "escalate" }, SEAT_URGENCY.waiting],
    [{ managedSeat: true }, { failure: "claude is not installed" }, SEAT_URGENCY.waiting],
    [{ seatState: "idle", needsLook: true }, {}, SEAT_URGENCY.done],
    [{ seatState: "idle" }, { signal: "feedback" }, SEAT_URGENCY.review],
    [{ seatState: "working" }, {}, SEAT_URGENCY.working],
    [{ running: true, processName: "npm run dev" }, {}, SEAT_URGENCY.working],
    [{ seatState: "idle" }, {}, SEAT_URGENCY.resting],
    [{ running: true, managedSeat: true }, {}, SEAT_URGENCY.resting],
    [{ managedSeat: true }, {}, SEAT_URGENCY.offline],
    [{ seatState: "gone" }, {}, SEAT_URGENCY.offline],
    [{}, {}, SEAT_URGENCY.offline],
  ] as const)("%o with %o ranks %d", (input, extra, expected) => {
    expect(urgency(input, extra)).toBe(expected);
  });

  it("a declared signal outranks the control state it rides on", () => {
    expect(urgency({ seatState: "working" }, { signal: "blocked" })).toBe(SEAT_URGENCY.blocked);
    expect(urgency({ seatState: "attention" }, { signal: "feedback" })).toBe(SEAT_URGENCY.waiting);
  });
});

describe("review and done are different urgencies: asked for, or only settled", () => {
  const urgency = (input: Parameters<typeof terminalActivity>[0], extra: { signal?: "feedback" | "blocked" | "escalate" } = {}) =>
    seatUrgency({ activity: terminalActivity(input), ...extra });

  it("a feedback signal is review, a settled unread turn is done, and review comes first", () => {
    expect(urgency({ seatState: "idle" }, { signal: "feedback" })).toBe(SEAT_URGENCY.review);
    expect(urgency({ seatState: "idle", needsLook: true })).toBe(SEAT_URGENCY.done);
    expect(SEAT_URGENCY.review).toBeLessThan(SEAT_URGENCY.done);
    expect(SEAT_URGENCY.done).toBeLessThan(SEAT_URGENCY.working);
  });

  it("a feedback signal on a settled unread turn stays review", () => {
    expect(urgency({ seatState: "idle", needsLook: true }, { signal: "feedback" })).toBe(SEAT_URGENCY.review);
  });
});

describe("paletteRank: blocked, waiting, working, review, done, resting, offline", () => {
  it("is one linear order, working above review, review above done", () => {
    expect(Object.values(PALETTE_RANK)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it.each([
    [SEAT_URGENCY.blocked, PALETTE_RANK.blocked],
    [SEAT_URGENCY.waiting, PALETTE_RANK.waiting],
    [SEAT_URGENCY.working, PALETTE_RANK.working],
    [SEAT_URGENCY.review, PALETTE_RANK.review],
    [SEAT_URGENCY.done, PALETTE_RANK.done],
    [SEAT_URGENCY.resting, PALETTE_RANK.resting],
    [SEAT_URGENCY.offline, PALETTE_RANK.offline],
  ] as const)("urgency %i ranks %i", (urgency, expected) => {
    expect(paletteRank(urgency)).toBe(expected);
  });
});
