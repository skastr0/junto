import { describe, expect, it } from "vitest";
import { terminalActivity } from "../src/renderer/lib/activity";
import { seatLine } from "../src/renderer/lib/seat-line";

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
