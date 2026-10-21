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
  it("no longer writes admission: a node saved with one comes back without it", () => {
    const stored = { incoming: { handling: "Triage first", admission: "approval" } } as never;
    expect(normalizeBoardSettings(stored)).toEqual({ incoming: { handling: "Triage first" } });
    expect(normalizeBoardSettings({ incoming: { admission: "operator" } } as never)).toBeUndefined();
  });
});
