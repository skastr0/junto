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

  it("takes text alpha from the coverage channel, not the white red channel", () => {
    // The atlas is white coverage over transparent, unpremultiplied: r is 1
    // inside edge texels, so using it made every antialiased glyph edge opaque.
    expect(QUAD_SHADER).toContain("alpha = tex.a * ink.a * outer;");
    expect(QUAD_SHADER).not.toContain("alpha = tex.r * ink.a * outer;");
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

  it("turns a sprite quad's offset, not only a disc's sweep", () => {
    // A ring's spin cell is a sprite (kind 2, shape rect). The operator saw
    // every moving ring frozen on 2026-11-14 because the turn was handled
    // only inside the disc branch below, in the fragment shader.
    const vertex = QUAD_SHADER.slice(0, QUAD_SHADER.indexOf("@fragment fn fs"));
    expect(vertex).toContain("if (q.motion == 1u) {");
    expect(vertex).toContain("offset = vec2f(offset.x * turnCos - offset.y * turnSin");
    // Counter-clockwise runs the same lap backwards (animation-direction: reverse).
    expect(vertex).toContain("if ((q.motionFlags & 1u) != 0u) { turn = 1.0 - turn; }");
    expect(vertex).toContain("if (q.motion == 9u) {");
    expect(vertex).toContain("center = vec2f(center.x + dx, center.y);");
  });

  it("breathes a fading turn (glint) and keeps the disc sweep's fade", () => {
    const fragment = QUAD_SHADER.slice(QUAD_SHADER.indexOf("@fragment fn fs"));
    expect(fragment).toContain("if (q.motion == 1u) {");
    expect(fragment).toContain("motionAlpha = 0.5 - 0.5 * cos(phaseOfQuad(q) * PI2);");
    expect(fragment).toContain("motionAlpha = motionAlpha * (0.22 + 0.78 * sweep * sweep);");
  });
});
