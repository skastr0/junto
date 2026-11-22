// The wire layer's uniform struct fits the buffer it is bound to. A struct
// that outgrows its binding is a WebGPU validation error: the frame's command
// buffer is invalid and the canvas presents nothing at all (the 1x gate at
// 1f8eb41b6 shot a black canvas at every tier).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WIRE_SHADER } from "../src/window/canvas/engine/wires/shader";

/** WGSL's size and alignment for the scalar and vector types a uniform struct here uses. */
const LAYOUT: Record<string, { readonly size: number; readonly align: number }> = {
  f32: { size: 4, align: 4 },
  u32: { size: 4, align: 4 },
  vec2f: { size: 8, align: 8 },
  vec3f: { size: 12, align: 16 },
  vec4f: { size: 16, align: 16 },
};

const structSize = (source: string, name: string): number => {
  const body = new RegExp(`struct ${name} \\{([^}]*)\\}`, "u").exec(source)?.[1];
  if (body === undefined) throw new Error(`no struct ${name}`);
  let offset = 0;
  let align = 1;
  for (const [, type] of body.matchAll(/^\s*\w+\s*:\s*(\w+)\s*,/gmu)) {
    const layout = LAYOUT[type!];
    if (layout === undefined) throw new Error(`no layout for ${type!}`);
    offset = Math.ceil(offset / layout.align) * layout.align + layout.size;
    align = Math.max(align, layout.align);
  }
  return Math.ceil(offset / align) * align;
};

describe("wire uniforms", () => {
  it("fit the uniform buffer the layer binds", () => {
    const gpu = readFileSync(new URL("../src/window/canvas/engine/wires/gpu.ts", import.meta.url), "utf8");
    const floats = Number(/const UNIFORM_FLOATS = (\d+);/u.exec(gpu)?.[1]);
    expect(floats).toBeGreaterThan(0);
    expect(structSize(WIRE_SHADER, "Uniforms")).toBeLessThanOrEqual(floats * 4);
  });
});
