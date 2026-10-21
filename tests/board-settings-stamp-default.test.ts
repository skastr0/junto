import { describe, expect, it } from "vitest";
import { normalizeBoardSettings } from "../src/renderer/components/rules/board-settings";

describe("normalizeBoardSettings keeps the stamp default", () => {
  it("keeps a default above zero and drops zero, which omitted already means", () => {
    expect(normalizeBoardSettings({ stampDefault: { required: 2 } })).toEqual({ stampDefault: { required: 2 } });
    expect(normalizeBoardSettings({ stampDefault: { required: 0 } })).toBeUndefined();
    expect(normalizeBoardSettings({ instructions: " Ship ", stampDefault: { required: 1 } })).toEqual({
      instructions: "Ship",
      stampDefault: { required: 1 },
    });
  });
});

describe("normalizeBoardSettings and the admission setting", () => {
  it("passes a stored admission through unchanged, so a write that is not about it keeps a Me or approval board", () => {
    const stored = { incoming: { handling: "Triage first", admission: "approval" } } as never;
    expect(normalizeBoardSettings(stored)).toEqual({ incoming: { handling: "Triage first", admission: "approval" } });
    expect(normalizeBoardSettings({ incoming: { admission: "operator", waitMs: 900_000 } } as never)).toEqual({
      incoming: { admission: "operator", waitMs: 900_000 },
    });
  });

  it("writes none for the default, auto", () => {
    expect(normalizeBoardSettings({ incoming: { admission: "auto" } } as never)).toBeUndefined();
  });
});
