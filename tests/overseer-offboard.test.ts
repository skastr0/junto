import { describe, expect, it, vi } from "vitest";
import { Result } from "effect";
import { decodeOverseerArgs, isOverseerMutation } from "../src/shared/overseer-control";
import { composeOffboardAsk } from "../src/shared/seat-sessions";
import {
  OFFBOARD_MISSING,
  OFFBOARD_OWN_SEAT,
  OFFBOARD_SEAT_FAILED,
  executeOverseerOffboard,
  offboardSeats,
} from "../src/main/junto/overseer/offboard";
import type {
  OverseerOffboard,
  OverseerOffboardRules,
  OverseerOffboardSeatResult,
} from "../src/main/junto/overseer/offboard-seam";
import { offboardRefusedAny } from "../src/cli/commands/overseer";

const caller = { canvasName: "factory", nodeId: "boss" };

const DEFAULT_RULES: OverseerOffboardRules = {
  auto: { enabled: true, minutes: 120 },
  nudge: { enabled: false, minutes: 40 },
};

/** A stand-in for main's entry point: it answers per seat from a table. */
const fakeOffboard = (
  seats: Record<string, OverseerOffboardSeatResult | Error>,
) => {
  let rules = DEFAULT_RULES;
  const seat = vi.fn<OverseerOffboard["seat"]>(async ({ nodeId }) => {
    const answer = seats[nodeId];
    if (answer instanceof Error) throw answer;
    return answer ?? { ok: false, reason: "Junto could not find that seat." };
  });
  const offboard: OverseerOffboard = {
    seat,
    rules: async () => rules,
    configure: async (change) => {
      rules = {
        auto: { ...rules.auto, ...change.auto },
        nudge: { ...rules.nudge, ...change.nudge },
      };
      return rules;
    },
  };
  return { offboard, seat };
};

const ok = (operation: Parameters<typeof decodeOverseerArgs>[0], args: unknown) =>
  Result.isSuccess(decodeOverseerArgs(operation, args));

describe("offboard arg schemas", () => {
  it("takes one or many seats, an action and a mode", () => {
    expect(ok("agent.offboard", { nodeIds: ["a"] })).toBe(true);
    expect(ok("agent.offboard", { canvas: "work", nodeIds: ["a", "b"], action: "ask", mode: "rest" })).toBe(true);
    expect(ok("agent.offboard", { nodeIds: ["a"], mode: "continue" })).toBe(true);
    expect(ok("agent.offboard", { nodeIds: ["a", "b"], action: "now" })).toBe(true);
  });

  it("refuses no seats, a seat named twice, a mode with now, and unknown words", () => {
    expect(ok("agent.offboard", {})).toBe(false);
    expect(ok("agent.offboard", { nodeIds: [] })).toBe(false);
    expect(ok("agent.offboard", { nodeIds: ["a", "a"] })).toBe(false);
    expect(ok("agent.offboard", { nodeIds: ["a"], action: "now", mode: "continue" })).toBe(false);
    expect(ok("agent.offboard", { nodeIds: ["a"], action: "now", mode: "rest" })).toBe(false);
    expect(ok("agent.offboard", { nodeIds: ["a"], action: "later" })).toBe(false);
    expect(ok("agent.offboard", { nodeIds: ["a"], mode: "pause" })).toBe(false);
    expect(ok("agent.offboard", { nodeIds: ["a"], text: "my own wording" })).toBe(false);
    expect(ok("agent.offboard", { nodeIds: Array.from({ length: 101 }, (_, i) => `n${i}`) })).toBe(false);
  });

  it("changes a rule only with at least one real field", () => {
    expect(ok("agent.offboard-configure", { auto: { minutes: 180 } })).toBe(true);
    expect(ok("agent.offboard-configure", { nudge: { enabled: true } })).toBe(true);
    expect(ok("agent.offboard-configure", { auto: { enabled: false }, nudge: { enabled: true, minutes: 15 } })).toBe(true);
    expect(ok("agent.offboard-configure", {})).toBe(false);
    expect(ok("agent.offboard-configure", { auto: {} })).toBe(false);
    for (const minutes of [0, -5, 1.5, "120"]) {
      expect(ok("agent.offboard-configure", { auto: { minutes } })).toBe(false);
    }
    expect(ok("agent.offboard-configure", { auto: { minutes: 60 }, other: true })).toBe(false);
    expect(ok("agent.offboard-rules", {})).toBe(true);
  });

  it("classifies the rules read as a read and the rest as mutations", () => {
    expect(isOverseerMutation("agent.offboard-rules")).toBe(false);
    expect(isOverseerMutation("agent.offboard")).toBe(true);
    expect(isOverseerMutation("agent.offboard-configure")).toBe(true);
  });
});

describe("offboard many seats", () => {
  it("defaults to ask and continue, and answers per seat in the order asked", async () => {
    const { offboard, seat } = fakeOffboard({
      one: { ok: true, title: "One", outcome: "asked" },
      two: { ok: true, outcome: "asked" },
    });
    const result = await offboardSeats(caller, { nodeIds: ["two", "one"] }, offboard);
    expect(result).toEqual({
      results: [
        { nodeId: "two", ok: true, action: "ask", outcome: "asked" },
        { nodeId: "one", title: "One", ok: true, action: "ask", outcome: "asked" },
      ],
      refused: 0,
    });
    expect(seat.mock.calls.map(([input]) => input)).toEqual([
      { canvasName: "factory", nodeId: "two", action: "ask", mode: "continue" },
      { canvasName: "factory", nodeId: "one", action: "ask", mode: "continue" },
    ]);
  });

  it("carries the asked canvas, action and mode to main", async () => {
    const { offboard, seat } = fakeOffboard({ one: { ok: true, outcome: "asked" } });
    await offboardSeats(caller, { canvas: "work", nodeIds: ["one"], mode: "rest" }, offboard);
    await offboardSeats(caller, { nodeIds: ["one"], action: "now" }, offboard);
    expect(seat.mock.calls.map(([input]) => input)).toMatchObject([
      { canvasName: "work", action: "ask", mode: "rest" },
      { canvasName: "factory", action: "now" },
    ]);
  });

  it("keeps a refused seat as its own row and still answers for the others", async () => {
    const { offboard } = fakeOffboard({
      idle: { ok: true, title: "Idle", outcome: "ended" },
      busy: { ok: false, title: "Busy", reason: "This seat is working. Offboard now ends only an idle, offline or resting seat." },
      broken: new Error("ENOENT /Users/someone/.junto/secret-path"),
    });
    const result = await offboardSeats(
      caller,
      { nodeIds: ["idle", "busy", "ghost", "broken"], action: "now" },
      offboard,
    );
    expect(result).toEqual({
      results: [
        { nodeId: "idle", title: "Idle", ok: true, action: "now", outcome: "ended" },
        { nodeId: "busy", title: "Busy", ok: false, reason: "This seat is working. Offboard now ends only an idle, offline or resting seat." },
        { nodeId: "ghost", ok: false, reason: "Junto could not find that seat." },
        { nodeId: "broken", ok: false, reason: OFFBOARD_SEAT_FAILED },
      ],
      refused: 3,
    });
  });

  it("refuses to ask the caller's own seat without mailing it, and leaves now to main", async () => {
    const { offboard, seat } = fakeOffboard({
      boss: { ok: false, reason: "This seat is working." },
      peer: { ok: true, outcome: "asked" },
    });
    const asked = await offboardSeats(caller, { nodeIds: ["boss", "peer"] }, offboard);
    expect(asked.results[0]).toEqual({ nodeId: "boss", ok: false, reason: OFFBOARD_OWN_SEAT });
    expect(asked.refused).toBe(1);
    expect(seat.mock.calls.map(([input]) => input.nodeId)).toEqual(["peer"]);

    // The same node id on another canvas is another seat.
    seat.mockClear();
    await offboardSeats(caller, { canvas: "other", nodeIds: ["boss"] }, offboard);
    expect(seat).toHaveBeenCalledTimes(1);

    // Ending now is main's rule to refuse, not this side's.
    seat.mockClear();
    const now = await offboardSeats(caller, { nodeIds: ["boss"], action: "now" }, offboard);
    expect(seat).toHaveBeenCalledTimes(1);
    expect(now.results[0]).toEqual({ nodeId: "boss", ok: false, reason: "This seat is working." });
  });

  it("adds no wording of its own: the ask text stays main's", async () => {
    const { offboard, seat } = fakeOffboard({ one: { ok: true, outcome: "asked" } });
    await offboardSeats(caller, { nodeIds: ["one"] }, offboard);
    const sent = JSON.stringify(seat.mock.calls);
    expect(sent).not.toContain(composeOffboardAsk("continue").slice(0, 30));
    expect(Object.keys(seat.mock.calls[0]![0]).sort()).toEqual(["action", "canvasName", "mode", "nodeId"]);
  });
});

describe("offboard operations", () => {
  it("reads and changes the rules, returning them after the change", async () => {
    const { offboard } = fakeOffboard({});
    expect(await executeOverseerOffboard(caller, { operation: "agent.offboard-rules" }, offboard))
      .toEqual({ ok: true, data: DEFAULT_RULES });
    expect(
      await executeOverseerOffboard(
        caller,
        { operation: "agent.offboard-configure", args: { auto: { minutes: 180 }, nudge: { enabled: true } } },
        offboard,
      ),
    ).toEqual({
      ok: true,
      data: { auto: { enabled: true, minutes: 180 }, nudge: { enabled: true, minutes: 40 } },
    });
  });

  it("answers Unsupported with no entry point, and fixed words when the rules fail", async () => {
    expect(await executeOverseerOffboard(caller, { operation: "agent.offboard-rules" }, undefined))
      .toEqual({ ok: false, error: { type: "Unsupported", message: OFFBOARD_MISSING } });
    const failing: OverseerOffboard = {
      seat: async () => ({ ok: true, outcome: "asked" }),
      rules: () => Promise.reject(new Error("sqlite: disk I/O error at /private/path")),
      configure: () => Promise.reject(new Error("nope")),
    };
    const failed = await executeOverseerOffboard(caller, { operation: "agent.offboard-rules" }, failing);
    expect(failed).toMatchObject({ ok: false, error: { type: "InternalError" } });
    expect(JSON.stringify(failed)).not.toContain("/private/path");
  });

  it("tells the CLI to exit non-zero only when a seat was refused", () => {
    expect(offboardRefusedAny({ results: [], refused: 0 })).toBe(false);
    expect(offboardRefusedAny({ results: [{ nodeId: "a", ok: false, reason: "busy" }], refused: 1 })).toBe(true);
    expect(offboardRefusedAny({ auto: { enabled: true, minutes: 120 } })).toBe(false);
    expect(offboardRefusedAny(undefined)).toBe(false);
  });
});
