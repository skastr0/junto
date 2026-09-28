import { describe, expect, it } from "vitest";
import { parseWaitFor } from "../src/cli/core/duration";

describe("parseWaitFor", () => {
  it("reads the units an operator would speak", () => {
    expect(parseWaitFor("7d")).toEqual({ ok: true, ms: 604_800_000 });
    expect(parseWaitFor("12h")).toEqual({ ok: true, ms: 43_200_000 });
    expect(parseWaitFor("90m")).toEqual({ ok: true, ms: 5_400_000 });
    expect(parseWaitFor("30s")).toEqual({ ok: true, ms: 30_000 });
    expect(parseWaitFor("1w")).toEqual({ ok: true, ms: 604_800_000 });
    expect(parseWaitFor(" 1.5H ")).toEqual({ ok: true, ms: 5_400_000 });
  });

  it("treats a bare value as milliseconds", () => {
    expect(parseWaitFor(2_500)).toEqual({ ok: true, ms: 2_500 });
    expect(parseWaitFor("2500")).toEqual({ ok: true, ms: 2_500 });
    expect(parseWaitFor("2500ms")).toEqual({ ok: true, ms: 2_500 });
    expect(parseWaitFor(0)).toEqual({ ok: true, ms: 0 });
  });

  it("rejects what it cannot read back unambiguously", () => {
    for (const value of ["", "soon", "1d12h", "-5", "7 days", "d7", Number.NaN, -1]) {
      expect(parseWaitFor(value as string | number).ok).toBe(false);
    }
  });
});
