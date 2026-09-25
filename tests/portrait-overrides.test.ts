import { describe, expect, it } from "vitest";
import { isPortraitSeatId, normalizePortraitOverride } from "../src/shared/portrait-overrides";

describe("portrait override normalizer", () => {
  it("keeps known well-shaped fields and drops the rest", () => {
    expect(
      normalizePortraitOverride({
        shape: "toast",
        eyes: "x".repeat(25),
        blush: "yes",
        temperament: 0.4,
        hat: "top",
      }),
    ).toEqual({ shape: "toast", temperament: 0.4 });
    expect(normalizePortraitOverride({ temperament: 2 })).toBeNull();
    expect(normalizePortraitOverride({})).toBeNull();
    expect(normalizePortraitOverride([])).toBeNull();
    expect(normalizePortraitOverride("toast")).toBeNull();
  });

  it("admits node ids as seat ids", () => {
    expect(isPortraitSeatId("8a6b0c1e-1111-4222-a333-444455556666")).toBe(true);
    expect(isPortraitSeatId(" ")).toBe(false);
    expect(isPortraitSeatId("x".repeat(1025))).toBe(false);
    expect(isPortraitSeatId(7)).toBe(false);
  });
});
