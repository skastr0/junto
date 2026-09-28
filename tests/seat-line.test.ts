import { describe, expect, it } from "vitest";
import { terminalActivity } from "../src/renderer/lib/activity";
import { SEAT_URGENCY, seatLine, seatUrgency } from "../src/renderer/lib/seat-line";

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
    [{ managedSeat: true, seatState: "unknown" }, "offline"],
    [{ managedSeat: true }, "offline"],
    [{ seatState: "gone" }, "offline"],
    [{}, "stopped"],
    [{ starting: true }, "starting up"],
    [{ running: true, processName: "npm run dev" }, "running npm run dev"],
  ] as const)("%o reads %s", (input, expected) => {
    expect(words(input)).toBe(expected);
  });

  it("never says unknown or idle", () => {
    for (const seatState of ["unknown", "idle", "gone", "working", "attention"] as const) {
      for (const managedSeat of [true, false]) {
        const text = words({ seatState, managedSeat });
        expect(text).not.toMatch(/unknown|^idle$/);
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
    [{ seatState: "idle", needsLook: true }, {}, SEAT_URGENCY.review],
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
