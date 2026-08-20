import { describe, expect, it } from "vitest";
import { parseHoldFor, toTasksUpdateArgs } from "../src/cli/core/duration";

describe("parseHoldFor", () => {
  it("reads the units an operator would speak", () => {
    expect(parseHoldFor("7d")).toEqual({ ok: true, ms: 604_800_000 });
    expect(parseHoldFor("12h")).toEqual({ ok: true, ms: 43_200_000 });
    expect(parseHoldFor("90m")).toEqual({ ok: true, ms: 5_400_000 });
    expect(parseHoldFor("30s")).toEqual({ ok: true, ms: 30_000 });
    expect(parseHoldFor("1w")).toEqual({ ok: true, ms: 604_800_000 });
    expect(parseHoldFor(" 1.5H ")).toEqual({ ok: true, ms: 5_400_000 });
  });

  it("treats a bare value as milliseconds", () => {
    expect(parseHoldFor(2_500)).toEqual({ ok: true, ms: 2_500 });
    expect(parseHoldFor("2500")).toEqual({ ok: true, ms: 2_500 });
    expect(parseHoldFor("2500ms")).toEqual({ ok: true, ms: 2_500 });
    expect(parseHoldFor(0)).toEqual({ ok: true, ms: 0 });
  });

  it("rejects what it cannot read back unambiguously", () => {
    for (const value of ["", "soon", "1d12h", "-5", "7 days", "d7", Number.NaN, -1]) {
      expect(parseHoldFor(value as string | number).ok).toBe(false);
    }
  });
});

describe("toTasksUpdateArgs", () => {
  it("lowers holdFor onto the wire field and leaves the rest alone", () => {
    const lowered = toTasksUpdateArgs({
      target: "n7",
      task: "t1",
      state: "completed",
      next: "n8",
      holdFor: "7d",
    });
    expect(lowered).toEqual({
      ok: true,
      args: {
        target: "n7",
        task: "t1",
        state: "completed",
        next: "n8",
        holdForMs: 604_800_000,
      },
    });
  });

  it("passes an update with no hold through untouched", () => {
    const lowered = toTasksUpdateArgs({
      target: "n7",
      task: "t1",
      state: "working",
    });
    expect(lowered).toEqual({
      ok: true,
      args: { target: "n7", task: "t1", state: "working" },
    });
  });

  it("reports the bad duration instead of guessing one", () => {
    const lowered = toTasksUpdateArgs({
      target: "n7",
      task: "t1",
      state: "completed",
      holdFor: "a while",
    });
    expect(lowered.ok).toBe(false);
  });
});
