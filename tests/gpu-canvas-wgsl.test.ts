// The quad shader must not use a WGSL reserved word as a name: Chromium
// reports "Invalid ShaderModule" and every draw is then an invalid command
// buffer, which no unit test that only counts frames can see. `meta` and
// `from` each cost a switch-on run; this holds the list.

import { describe, expect, it } from "vitest";
import { QUAD_SHADER, WGSL_RESERVED } from "../src/window/canvas/engine/renderer";

const identifiers = (source: string): ReadonlySet<string> => {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/\/\/[^\n]*/gu, " ");
  return new Set([...code.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/gu)].map((match) => match[1]!));
};

describe("the quad shader's names", () => {
  it("never uses a WGSL reserved word", () => {
    const reserved = new Set(WGSL_RESERVED.split(" "));
    const used = [...identifiers(QUAD_SHADER)].filter((name) => reserved.has(name)).sort();
    expect(used).toEqual([]);
  });

  it("projects board points with the contract's camera, not its inverse", () => {
    // The operator saw cards drawn off-screen on 2026-11-14 because this line
    // was (world - camera) * zoom while pickAt used board * zoom + camera.
    expect(QUAD_SHADER).toContain("let screen = world * u.camera.z + u.camera.xy;");
    expect(QUAD_SHADER).not.toContain("world - u.camera.xy");
  });

  it("holds a seat rule at 1 at near and mid, with far and floor only at far and overview", () => {
    // The operator saw rings and portraits 1.75x at near: the shader applied
    // the far scale at every tier but overview.
    expect(QUAD_SHADER).not.toContain("select(far, floorScale, tierBit == 8u)");
    expect(QUAD_SHADER).toContain("if (tierBit == 4u)");
  });

  it("binds every table the pipeline layout gives it", () => {
    for (const binding of ["order", "quads", "owners", "styles", "shadowMeta", "shadowLayers"]) {
      expect(QUAD_SHADER).toContain(`var<storage, read> ${binding}`);
    }
    expect(QUAD_SHADER).toContain("@group(0) @binding(9)");
  });
});
