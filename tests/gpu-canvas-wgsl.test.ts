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

  it("binds every table the pipeline layout gives it", () => {
    for (const binding of ["order", "quads", "owners", "styles", "shadowMeta", "shadowLayers"]) {
      expect(QUAD_SHADER).toContain(`var<storage, read> ${binding}`);
    }
    expect(QUAD_SHADER).toContain("@group(0) @binding(9)");
  });
});
