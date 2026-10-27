import { Result } from "effect";
import { expect, it } from "vitest";
import { applyPatches, asPadElementId, emptyPad, type PadShape } from "../src/shared/pad";
import {
  PAD_FILL_SWATCHES,
  PAD_STENCIL_IDS,
  PAD_STROKE_SWATCHES,
  imageRow,
  restyleShape,
  stencilPatches,
} from "../src/renderer/components/pad/pad-stencils";
import { isPadPaintLiteral } from "../src/shared/pad-project";

const counter = () => {
  let n = 0;
  return (prefix: string) => asPadElementId(`${prefix}-${++n}`);
};

const box: PadShape = { id: asPadElementId("s"), type: "box", x: 0, y: 0, w: 10, h: 10, z: 0 };

it("every stencil applies to an empty pad as one valid batch", () => {
  for (const id of PAD_STENCIL_IDS) {
    const { patches, ids } = stencilPatches(id, { x: 100, y: 100 }, 0, counter());
    const applied = applyPatches(emptyPad(), patches);
    expect(Result.isSuccess(applied), id).toBe(true);
    if (Result.isSuccess(applied)) {
      expect(applied.success.shapes.length + applied.success.edges.length).toBe(ids.length);
    }
  }
});

it("a stencil centers on the point and stacks from the given z", () => {
  const { patches } = stencilPatches("flow", { x: 0, y: 0 }, 5, counter());
  const shapes = patches.flatMap((patch) =>
    patch.op === "upsert" && patch.layer === "shape" ? [patch.shape] : []);
  expect(shapes.map((shape) => [shape.x, shape.y, shape.z])).toEqual([[-180, -32, 5], [40, -32, 6]]);
  const edge = patches.find((patch) => patch.op === "upsert" && patch.layer === "edge");
  expect(edge).toMatchObject({ edge: { from: shapes[0]!.id, to: shapes[1]!.id } });
});

it("every swatch is paint the renderer accepts", () => {
  for (const swatch of [...PAD_FILL_SWATCHES, ...PAD_STROKE_SWATCHES]) {
    expect(isPadPaintLiteral(swatch.value), swatch.id).toBe(true);
  }
});

it("restyle sets fields, drops cleared ones, and stores no status as absent", () => {
  const styled = restyleShape(box, { fill: "#e8a33d2e", status: "done", text: "  Ship  " });
  expect(styled).toMatchObject({ fill: "#e8a33d2e", status: "done", text: "Ship" });
  const cleared = restyleShape(styled, { fill: undefined, status: "none", text: " " });
  expect(cleared).toEqual(box);
  expect("stroke" in restyleShape(box, { fill: "#fff" })).toBe(false);
});

it("several images land in one centered row", () => {
  expect(imageRow(3, { x: 0, y: 0 }, { w: 100, h: 50 }, 10)).toEqual([
    { x: -160, y: -25, w: 100, h: 50 },
    { x: -50, y: -25, w: 100, h: 50 },
    { x: 60, y: -25, w: 100, h: 50 },
  ]);
});
