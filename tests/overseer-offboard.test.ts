import { describe, expect, it, vi } from "vitest";
import { Result } from "effect";
import { decodeOverseerArgs, isOverseerMutation } from "../src/shared/overseer-control";
import {
  OFFBOARD_WORTH,
  OFFBOARD_REFUSAL_REASON,
  applyOffboardRulesPatch,
  defaultOffboardRules,
  offboardRulesProblem,
  summarizeOffboardRun,
  type OffboardRules,
  type SeatOffboardRunRow,
  type SeatOffboardStatus,
} from "../src/shared/seat-offboard";
import { composeOffboardAsk } from "../src/shared/seat-sessions";
import {
  OFFBOARD_FAILED,
  OFFBOARD_MISSING,
  executeOverseerOffboard,
} from "../src/main/junto/overseer/offboard";
import { overseerOffboard, type OverseerOffboard } from "../src/main/junto/overseer/offboard-seam";
import { setOperatorOffboard } from "../src/main/junto/seat-sessions/operator-offboard";
import { offboardRefusedAny } from "../src/cli/commands/overseer";

const caller = { canvasName: "factory", nodeId: "boss" };

/**
 * A stand-in for main's entry point. `now` closes the seats named idle and
 * refuses the rest as working; `ask` reaches every seat it knows.
 */
const fakeOffboard = (known: ReadonlyArray<string> = ["idle", "busy", "boss"]) => {
  let rules: OffboardRules = defaultOffboardRules();
  const run = vi.fn<OverseerOffboard["run"]>(async ({ seatIds, action }) =>
    summarizeOffboardRun(
      seatIds.map((seatId): SeatOffboardRunRow => {
        if (!known.includes(seatId)) {
          return { seatId, ok: false, code: "not-a-seat", reason: OFFBOARD_REFUSAL_REASON["not-a-seat"] };
        }
        if (action === "now" && seatId !== "idle") {
          return { seatId, title: seatId, ok: false, code: "working", reason: OFFBOARD_REFUSAL_REASON.working, pastWindow: false };
        }
        return { seatId, title: seatId, ok: true, action, outcome: action === "now" ? "closed" : "asked", pastWindow: seatId === "idle" };
      }),
    ),
  );
  const status = vi.fn<OverseerOffboard["status"]>(async (_canvasName, seatIds) =>
    seatIds.map((seatId): SeatOffboardStatus =>
      seatId === "idle"
        ? { seatId, now: { allowed: true }, idleMinutes: 75, pastWindow: true, preferred: "now", workMinutes: 95, sessionTokens: 240_000, worthCutting: true }
        : { seatId, now: { allowed: false, code: "working", reason: OFFBOARD_REFUSAL_REASON.working }, idleMinutes: null, pastWindow: false, preferred: "ask", workMinutes: 4, worthCutting: false }),
  );
  // As main does it: apply, check, save only what passes.
  const patchRules = vi.fn<OverseerOffboard["patchRules"]>((patch) => {
    const next = applyOffboardRulesPatch(rules, patch);
    const message = offboardRulesProblem(next);
    if (message !== undefined) return { ok: false, message };
    rules = next;
    return { ok: true, rules };
  });
  const offboard: OverseerOffboard = { run, status, readRules: () => rules, patchRules };
  return { offboard, run, status, patchRules, rules: () => rules };
};

const ok = (operation: Parameters<typeof decodeOverseerArgs>[0], args: unknown) =>
  Result.isSuccess(decodeOverseerArgs(operation, args));

describe("offboard arg schemas", () => {
  it("takes one to two hundred seats, an action and a mode", () => {
    expect(ok("agent.offboard", { nodeIds: ["a"] })).toBe(true);
    expect(ok("agent.offboard", { canvas: "work", nodeIds: ["a", "b"], action: "ask", mode: "rest" })).toBe(true);
    expect(ok("agent.offboard", { nodeIds: ["a"], mode: "continue" })).toBe(true);
    expect(ok("agent.offboard", { nodeIds: ["a", "b"], action: "now" })).toBe(true);
    const many = (count: number) => Array.from({ length: count }, (_, index) => `n${index}`);
    expect(ok("agent.offboard", { nodeIds: many(200) })).toBe(true);
    expect(ok("agent.offboard", { nodeIds: many(201) })).toBe(false);
    expect(ok("agent.offboard-status", { nodeIds: many(200) })).toBe(true);
    expect(ok("agent.offboard-status", { nodeIds: many(201) })).toBe(false);
    expect(ok("agent.offboard-status", { nodeIds: [] })).toBe(false);
  });

  it("refuses no seats, a mode with now, and unknown words", () => {
    expect(ok("agent.offboard", {})).toBe(false);
    expect(ok("agent.offboard", { nodeIds: [] })).toBe(false);
    expect(ok("agent.offboard", { nodeIds: ["a"], action: "now", mode: "continue" })).toBe(false);
    expect(ok("agent.offboard", { nodeIds: ["a"], action: "now", mode: "rest" })).toBe(false);
    expect(ok("agent.offboard", { nodeIds: ["a"], action: "later" })).toBe(false);
    expect(ok("agent.offboard", { nodeIds: ["a"], mode: "pause" })).toBe(false);
    expect(ok("agent.offboard", { nodeIds: ["a"], text: "my own wording" })).toBe(false);
    expect(ok("agent.offboard-status", { nodeIds: ["a"], action: "now" })).toBe(false);
  });

  it("takes the rules patch as the rules' own schema: the cache window, and one per harness", () => {
    expect(ok("agent.offboard-configure", { cacheWindowMinutes: 30 })).toBe(true);
    expect(ok("agent.offboard-configure", { harness: { claude: { cacheWindowMinutes: 300 }, codex: null } })).toBe(true);
    for (const minutes of [0, -5, 1.5, "120", 7 * 24 * 60 + 1]) {
      expect(ok("agent.offboard-configure", { cacheWindowMinutes: minutes })).toBe(false);
    }
    expect(ok("agent.offboard-configure", { cacheWindowMinutes: 60, other: true })).toBe(false);
    expect(ok("agent.offboard-configure", { harness: { claude: { instruction: "x" } } })).toBe(false);
  });

  it("refuses the retired rules: the auto offboard, the idle nudge and worth", () => {
    expect(ok("agent.offboard-configure", { auto: { minutes: 180 } })).toBe(false);
    expect(ok("agent.offboard-configure", { nudge: { enabled: true } })).toBe(false);
    expect(ok("agent.offboard-configure", { worth: { workMinutes: 45 } })).toBe(false);
    expect(ok("agent.offboard-configure", { harness: { claude: { worth: { tokens: 500_000 } } } })).toBe(false);
  });

  it("classifies the reads and the mutations", () => {
    expect(isOverseerMutation("agent.offboard-rules")).toBe(false);
    expect(isOverseerMutation("agent.offboard-status")).toBe(false);
    expect(isOverseerMutation("agent.offboard")).toBe(true);
    expect(isOverseerMutation("agent.offboard-configure")).toBe(true);
  });
});

describe("agent.offboard", () => {
  it("makes one call as the overseer, ask by default, and returns main's result unchanged", async () => {
    const { offboard, run } = fakeOffboard();
    const outcome = await executeOverseerOffboard(
      caller,
      { operation: "agent.offboard", args: { nodeIds: ["busy", "idle", "ghost"] } },
      offboard,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      { canvasName: "factory", seatIds: ["busy", "idle", "ghost"], action: "ask" },
      "overseer",
    );
    expect(outcome).toEqual({ ok: true, data: await run.mock.results[0]!.value });
    expect(outcome).toMatchObject({
      ok: true,
      data: {
        results: [
          { seatId: "busy", ok: true, action: "ask", outcome: "asked", pastWindow: false },
          { seatId: "idle", ok: true, outcome: "asked", pastWindow: true },
          { seatId: "ghost", ok: false, code: "not-a-seat", reason: "Junto could not find that seat." },
        ],
        closed: 0,
        asked: 2,
        refused: 1,
      },
    });
  });

  it("carries the asked canvas, action and mode, and adds nothing of its own", async () => {
    const { offboard, run } = fakeOffboard();
    await executeOverseerOffboard(caller, { operation: "agent.offboard", args: { canvas: "work", nodeIds: ["idle"], mode: "rest" } }, offboard);
    await executeOverseerOffboard(caller, { operation: "agent.offboard", args: { nodeIds: ["idle"], action: "now" } }, offboard);
    expect(run.mock.calls.map(([input]) => input)).toEqual([
      { canvasName: "work", seatIds: ["idle"], action: "ask", mode: "rest" },
      { canvasName: "factory", seatIds: ["idle"], action: "now" },
    ]);
    // No wording of its own: the ask text stays main's.
    expect(JSON.stringify(run.mock.calls)).not.toContain(composeOffboardAsk("continue").slice(0, 30));
  });

  it("passes the caller's own seat through like any other", async () => {
    const { offboard, run } = fakeOffboard();
    const asked = await executeOverseerOffboard(caller, { operation: "agent.offboard", args: { nodeIds: ["boss"] } }, offboard);
    expect(asked).toMatchObject({ ok: true, data: { results: [{ seatId: "boss", ok: true, outcome: "asked" }], refused: 0 } });
    const now = await executeOverseerOffboard(caller, { operation: "agent.offboard", args: { nodeIds: ["boss"], action: "now" } }, offboard);
    expect(now).toMatchObject({ ok: true, data: { results: [{ seatId: "boss", ok: false, code: "working" }], refused: 1 } });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("answers an operation error in fixed words when the one call fails, with no invented rows", async () => {
    const { offboard } = fakeOffboard();
    const failing: OverseerOffboard = { ...offboard, run: () => Promise.reject(new Error("ENOENT /private/path")) };
    const failed = await executeOverseerOffboard(caller, { operation: "agent.offboard", args: { nodeIds: ["idle"] } }, failing);
    expect(failed).toEqual({ ok: false, error: { type: "InternalError", message: OFFBOARD_FAILED } });
  });

  it("returns the status of each seat unchanged", async () => {
    const { offboard, status } = fakeOffboard();
    const outcome = await executeOverseerOffboard(
      caller,
      { operation: "agent.offboard-status", args: { canvas: "work", nodeIds: ["idle", "busy"] } },
      offboard,
    );
    expect(status).toHaveBeenCalledWith("work", ["idle", "busy"]);
    expect(outcome).toEqual({
      ok: true,
      data: [
        { seatId: "idle", now: { allowed: true }, idleMinutes: 75, pastWindow: true, preferred: "now", workMinutes: 95, sessionTokens: 240_000, worthCutting: true },
        { seatId: "busy", now: { allowed: false, code: "working", reason: OFFBOARD_REFUSAL_REASON.working }, idleMinutes: null, pastWindow: false, preferred: "ask", workMinutes: 4, worthCutting: false },
      ],
    });
  });
});

describe("offboard rules", () => {
  it("reads the installation rules and what they come to per harness", async () => {
    const { offboard } = fakeOffboard();
    const outcome = await executeOverseerOffboard(caller, { operation: "agent.offboard-rules" }, offboard);
    expect(outcome).toMatchObject({
      ok: true,
      data: { rules: defaultOffboardRules(), effective: { claude: { cacheWindowMinutes: 60, worth: OFFBOARD_WORTH } } },
    });
  });

  it("applies a patch, saves it, and answers in the same form", async () => {
    const { offboard, patchRules, rules } = fakeOffboard();
    const outcome = await executeOverseerOffboard(
      caller,
      {
        operation: "agent.offboard-configure",
        args: { cacheWindowMinutes: 90, harness: { claude: { cacheWindowMinutes: 50 } } },
      },
      offboard,
    );
    const expected: OffboardRules = { cacheWindowMinutes: 90, harness: { claude: { cacheWindowMinutes: 50 } } };
    expect(patchRules).toHaveBeenCalledTimes(1);
    expect(rules()).toEqual(expected);
    expect(outcome).toMatchObject({
      ok: true,
      data: {
        rules: expected,
        effective: { claude: { cacheWindowMinutes: 50, worth: OFFBOARD_WORTH }, codex: { cacheWindowMinutes: 90, worth: OFFBOARD_WORTH } },
      },
    });

    // null removes the override.
    await executeOverseerOffboard(caller, { operation: "agent.offboard-configure", args: { harness: { claude: null } } }, offboard);
    expect(rules()).not.toHaveProperty("harness");
  });

  it("refuses a window out of range, in the rules' own words, and saves nothing", async () => {
    const { offboard, rules } = fakeOffboard();
    const direct = offboardRulesProblem({ cacheWindowMinutes: 60, harness: { claude: { cacheWindowMinutes: 0 } } });
    expect(direct).toBe("The cache window for claude must be a whole number of minutes, from 1 to 10080.");
    const outcome = await executeOverseerOffboard(
      caller,
      { operation: "agent.offboard-configure", args: { harness: { claude: { cacheWindowMinutes: 0 } } } },
      offboard,
    );
    expect(outcome.ok).toBe(false);
    expect(rules()).toEqual(defaultOffboardRules());
  });

  it("answers Unsupported with no entry point, and fixed words when main fails", async () => {
    expect(await executeOverseerOffboard(caller, { operation: "agent.offboard-rules" }, undefined))
      .toEqual({ ok: false, error: { type: "Unsupported", message: OFFBOARD_MISSING } });
    const { offboard } = fakeOffboard();
    const failing: OverseerOffboard = {
      ...offboard,
      readRules: () => Promise.reject(new Error("sqlite: disk I/O error at /private/path")),
      patchRules: () => Promise.reject(new Error("sqlite: disk I/O error at /private/path")),
    };
    for (const request of [
      { operation: "agent.offboard-rules" } as const,
      { operation: "agent.offboard-configure", args: { cacheWindowMinutes: 180 } } as const,
    ]) {
      expect(await executeOverseerOffboard(caller, request, failing))
        .toEqual({ ok: false, error: { type: "InternalError", message: OFFBOARD_FAILED } });
    }
  });
});

describe("the product binding", () => {
  it("passes main's own answer through while the app has not wired the operation", async () => {
    setOperatorOffboard(undefined);
    const ran = await executeOverseerOffboard(
      caller,
      { operation: "agent.offboard", args: { nodeIds: ["a", "b"], action: "now" } },
      overseerOffboard,
    );
    expect(ran).toEqual({
      ok: true,
      data: {
        results: [
          { seatId: "a", ok: false, code: "failed", reason: "Junto is still starting. Try again in a moment." },
          { seatId: "b", ok: false, code: "failed", reason: "Junto is still starting. Try again in a moment." },
        ],
        closed: 0,
        asked: 0,
        refused: 2,
      },
    });
    expect(offboardRefusedAny(ran.ok ? ran.data : undefined)).toBe(true);
    expect(
      await executeOverseerOffboard(caller, { operation: "agent.offboard-status", args: { nodeIds: ["a"] } }, overseerOffboard),
    ).toMatchObject({ ok: true, data: [{ seatId: "a", now: { allowed: false, code: "failed" }, preferred: "ask" }] });
  });

  it("reaches the operation main installed, as the overseer", async () => {
    const run = vi.fn(async () => summarizeOffboardRun([]));
    setOperatorOffboard({ run, status: async () => [], tick: async () => summarizeOffboardRun([]) } as never);
    try {
      await executeOverseerOffboard(caller, { operation: "agent.offboard", args: { nodeIds: ["a"] } }, overseerOffboard);
      expect(run).toHaveBeenCalledWith({ canvasName: "factory", seatIds: ["a"], action: "ask" }, "overseer");
    } finally {
      setOperatorOffboard(undefined);
    }
  });
});

describe("offboard exit rule", () => {
  it("tells the CLI to exit non-zero only when a seat was refused", () => {
    expect(offboardRefusedAny({ results: [], closed: 0, asked: 0, refused: 0 })).toBe(false);
    expect(offboardRefusedAny({ results: [], closed: 1, asked: 0, refused: 1 })).toBe(true);
    expect(offboardRefusedAny({ rules: defaultOffboardRules() })).toBe(false);
    expect(offboardRefusedAny(undefined)).toBe(false);
  });
});
