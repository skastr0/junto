import { describe, expect, it } from "vitest";
import { inSrgb, type Oklch } from "../src/shared/theme/oklch";
import * as primitives from "../src/shared/theme/primitives";

// One name is one colour on every screen. A token outside sRGB is drawn two
// ways: CSS shows it in full on a wide-colour screen, and every consumer of
// the hex projection (ring art, xterm, the canvas) shows it clamped. Bright
// amber, the main colour, was one of three that did.

const isOklch = (value: unknown): value is Oklch =>
  typeof value === "object" && value !== null && "l" in value && "c" in value && "h" in value;

const colours = (name: string, value: unknown): Array<[string, Oklch]> => {
  if (isOklch(value)) return [[name, value]];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, inner]) => colours(`${name}.${key}`, inner));
};

describe("theme primitives stay inside sRGB", () => {
  const all = Object.entries(primitives).flatMap(([name, value]) => colours(name, value));

  it("finds the primitives", () => {
    expect(all.length).toBeGreaterThan(60);
  });

  it("has no colour a hex consumer would clamp", () => {
    expect(all.filter(([, colour]) => !inSrgb(colour)).map(([name]) => name)).toEqual([]);
  });
});
