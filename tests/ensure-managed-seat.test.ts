import { describe, expect, it } from "vitest";

import {
  AUTO_RESTART_BACKOFF_MS,
  AUTO_RESTART_MAX,
  managedSeatWakeDecision,
} from "../src/main/vellum/term/ensure-managed-seat";

const base = {
  stopping: false,
  exitReason: undefined,
  budget: undefined,
  nowMs: 1_000_000,
} as const;

describe("managed-seat wake decision", () => {
  it("spawns the initial generation for a binding the host has never seen", () => {
    expect(managedSeatWakeDecision({ ...base, status: undefined })).toEqual({
      kind: "spawn",
      restart: false,
    });
  });

  it("reuses a live generation", () => {
    expect(managedSeatWakeDecision({ ...base, status: "starting" })).toEqual({
      kind: "reuse",
    });
    expect(managedSeatWakeDecision({ ...base, status: "running" })).toEqual({
      kind: "reuse",
    });
  });

  it("an explicitly stopped seat stays stopped — reopen is the restart authority", () => {
    const decision = managedSeatWakeDecision({
      ...base,
      status: "exited",
      stopping: true,
    });
    expect(decision.kind).toBe("refuse");
  });

  it("a pre-ownership spawn failure is not respawned", () => {
    for (const exitReason of ["cli-missing", "spawn_failed"] as const) {
      const decision = managedSeatWakeDecision({
        ...base,
        status: "exited",
        exitReason,
      });
      expect(decision.kind).toBe("refuse");
    }
  });

  it("an exited generation restarts automatically — mail is a demand signal", () => {
    expect(managedSeatWakeDecision({ ...base, status: "exited" })).toEqual({
      kind: "spawn",
      restart: true,
    });
  });

  it("restarts back off between attempts", () => {
    const afterFirst = {
      ...base,
      status: "exited" as const,
      budget: { restarts: 1, lastRestartAtMs: base.nowMs - 1_000 },
    };
    expect(managedSeatWakeDecision(afterFirst).kind).toBe("refuse");
    const pastBackoff = {
      ...afterFirst,
      budget: {
        restarts: 1,
        lastRestartAtMs: base.nowMs - AUTO_RESTART_BACKOFF_MS[1] - 1,
      },
    };
    expect(managedSeatWakeDecision(pastBackoff)).toEqual({
      kind: "spawn",
      restart: true,
    });
  });

  it("the budget converges: after the cap, only an operator restart remains", () => {
    const decision = managedSeatWakeDecision({
      ...base,
      status: "exited",
      budget: { restarts: AUTO_RESTART_MAX, lastRestartAtMs: 0 },
    });
    expect(decision.kind).toBe("refuse");
  });

  it("unknown remote generation state is not spawned", () => {
    expect(
      managedSeatWakeDecision({ ...base, status: "missing" }).kind,
    ).toBe("refuse");
  });
});
