import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  PadPatch,
  applyPatches,
  emptyPad,
  type Pad,
  type PadError,
  type PadShape,
} from "../src/shared/pad";
import {
  anchorPoint,
  boundsOf,
  contentBounds,
  hitTest,
  identityCamera,
  routeEdge,
  sceneToView,
  strokePath,
  viewToScene,
} from "../src/shared/pad-geom";

const decodePatch = (patch: unknown): PadPatch =>
  Schema.decodeUnknownSync(PadPatch)(patch);

const contentRef = {
  sha256: "a".repeat(64),
  byteLength: 4,
  mediaType: "image/png",
} as const;

const expectOk = (result: Result.Result<Pad, PadError>): Pad => {
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
};

const box = (
  id: string,
  x: number,
  y: number,
  w = 10,
  h = 10,
  over: Record<string, unknown> = {},
) => ({
  id,
  type: "box",
  x,
  y,
  w,
  h,
  z: 0,
  ...over,
});

const fixture = (): Pad =>
  expectOk(
    applyPatches(emptyPad(), [
      decodePatch({
        op: "upsert",
        layer: "image",
        image: { id: "img", x: 0, y: 0, w: 40, h: 40, z: 0, ref: contentRef },
      }),
      decodePatch({
        op: "upsert",
        layer: "shape",
        shape: box("a", 10, 10, 20, 20),
      }),
      decodePatch({
        op: "upsert",
        layer: "shape",
        shape: box("b", 80, 10, 10, 10),
      }),
      decodePatch({
        op: "upsert",
        layer: "edge",
        edge: { id: "e1", from: "a", to: "b", fromSide: "right", toSide: "left" },
      }),
      decodePatch({
        op: "upsert",
        layer: "ink",
        ink: {
          id: "k1",
          z: 0,
          color: "#111111",
          width: 4,
          points: [
            { x: 0, y: 50 },
            { x: 40, y: 50 },
          ],
        },
      }),
      decodePatch({
        op: "pin.upsert",
        pin: { id: "p1", x: 100, y: 100, mentions: [] },
      }),
    ]),
  );

describe("pad camera", () => {
  it("inverts view and scene through the camera", () => {
    const camera = { x: 12, y: -4, zoom: 2 };
    const view = { x: 10, y: 20 };
    const scene = viewToScene(camera, view);
    expect(scene).toEqual({ x: 17, y: 6 });
    expect(sceneToView(camera, scene)).toEqual(view);
    expect(viewToScene(identityCamera, view)).toEqual(view);
  });
});

describe("pad bounds", () => {
  it("returns AABB for shapes, ink, pins, and edges", () => {
    const pad = fixture();
    expect(boundsOf(pad.shapes[0]!)).toEqual({ x: 10, y: 10, w: 20, h: 20 });
    expect(boundsOf(pad.images[0]!)).toEqual({ x: 0, y: 0, w: 40, h: 40 });
    expect(boundsOf(pad.inks[0]!)).toEqual({ x: -2, y: 48, w: 44, h: 4 });
    expect(boundsOf(pad.pins[0]!)).toEqual({ x: 92, y: 92, w: 16, h: 16 });
    expect(boundsOf(pad, "e1")).toEqual(boundsOf(pad, pad.edges[0]!.id));
    expect(boundsOf(pad, "missing")).toBeUndefined();
    const pinWithCrop = expectOk(
      applyPatches(emptyPad(), [
        decodePatch({
          op: "pin.upsert",
          pin: { id: "p2", x: 10, y: 10, mentions: [], bounds: { w: 40, h: 20 } },
        }),
      ]),
    );
    expect(boundsOf(pinWithCrop.pins[0]!)).toEqual({ x: -10, y: 0, w: 40, h: 20 });
  });

  it("unions content bounds and treats empty as a zero rect", () => {
    expect(contentBounds(emptyPad())).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    const pad = fixture();
    const union = contentBounds(pad);
    expect(union.x).toBeLessThanOrEqual(0);
    expect(union.y).toBeLessThanOrEqual(0);
    expect(union.x + union.w).toBeGreaterThanOrEqual(108);
    expect(union.y + union.h).toBeGreaterThanOrEqual(108);
  });
});

describe("pad hitTest", () => {
  it("returns the topmost layer then z", () => {
    const pad = fixture();
    expect(hitTest(pad, { x: 100, y: 100 }, 0)).toEqual({ id: "p1", layer: "pin" });
    expect(hitTest(pad, { x: 20, y: 50 }, 0)).toEqual({ id: "k1", layer: "ink" });
    expect(hitTest(pad, { x: 15, y: 15 }, 0)).toEqual({ id: "a", layer: "shape" });
    expect(hitTest(pad, { x: 2, y: 2 }, 0)).toEqual({ id: "img", layer: "image" });
    expect(hitTest(pad, { x: 200, y: 200 }, 0)).toBeUndefined();
  });

  it("prefers higher z inside a layer and later same-z", () => {
    const pad = expectOk(
      applyPatches(emptyPad(), [
        decodePatch({
          op: "upsert",
          layer: "shape",
          shape: box("low", 0, 0, 20, 20, { z: 1 }),
        }),
        decodePatch({
          op: "upsert",
          layer: "shape",
          shape: box("high", 0, 0, 20, 20, { z: 4 }),
        }),
      ]),
    );
    expect(hitTest(pad, { x: 5, y: 5 }, 0)).toEqual({ id: "high", layer: "shape" });
    const tied = expectOk(
      applyPatches(emptyPad(), [
        decodePatch({
          op: "upsert",
          layer: "shape",
          shape: box("first", 0, 0, 20, 20, { z: 1 }),
        }),
        decodePatch({
          op: "upsert",
          layer: "shape",
          shape: box("second", 0, 0, 20, 20, { z: 1 }),
        }),
      ]),
    );
    expect(hitTest(tied, { x: 5, y: 5 }, 0)).toEqual({ id: "second", layer: "shape" });
  });

  it("hits ink by distance to the polyline", () => {
    const pad = fixture();
    expect(hitTest(pad, { x: 20, y: 51.5 }, 0)?.id).toBe("k1");
    expect(hitTest(pad, { x: 20, y: 54 }, 0)).toBeUndefined();
    expect(hitTest(pad, { x: 20, y: 54 }, 2)?.id).toBe("k1");
  });

  it("expands AABB hits by slop", () => {
    const pad = expectOk(
      applyPatches(emptyPad(), [
        decodePatch({
          op: "upsert",
          layer: "shape",
          shape: box("solo", 0, 0, 10, 10),
        }),
      ]),
    );
    expect(hitTest(pad, { x: 11, y: 5 }, 0)).toBeUndefined();
    expect(hitTest(pad, { x: 11, y: 5 }, 1)).toEqual({ id: "solo", layer: "shape" });
  });

  it("hits ellipses and triangles by their geometry", () => {
    const pad = expectOk(
      applyPatches(emptyPad(), [
        decodePatch({
          op: "upsert",
          layer: "shape",
          shape: { id: "ell", type: "ellipse", x: 0, y: 0, w: 20, h: 10, z: 0 },
        }),
        decodePatch({
          op: "upsert",
          layer: "shape",
          shape: { id: "tri", type: "triangle", x: 40, y: 0, w: 20, h: 20, z: 0 },
        }),
      ]),
    );
    expect(hitTest(pad, { x: 10, y: 5 }, 0)?.id).toBe("ell");
    expect(hitTest(pad, { x: 1, y: 1 }, 0)).toBeUndefined();
    expect(hitTest(pad, { x: 50, y: 15 }, 0)?.id).toBe("tri");
    expect(hitTest(pad, { x: 41, y: 1 }, 0)).toBeUndefined();
  });

  it("hits an edge along the routed polyline with slop", () => {
    const pad = fixture();
    const from = pad.shapes[0]!;
    const to = pad.shapes[1]!;
    const points = routeEdge(from, to, "right", "left");
    const mid = points[Math.floor(points.length / 2)]!;
    expect(hitTest(pad, mid, 2)?.id).toBe("e1");
  });
});

describe("pad anchors and routes", () => {
  it("anchors each side at the AABB midpoint", () => {
    const shape = box("s", 0, 0, 10, 20) as PadShape;
    expect(anchorPoint(shape, "top")).toEqual({ x: 5, y: 0 });
    expect(anchorPoint(shape, "right")).toEqual({ x: 10, y: 10 });
    expect(anchorPoint(shape, "bottom")).toEqual({ x: 5, y: 20 });
    expect(anchorPoint(shape, "left")).toEqual({ x: 0, y: 10 });
  });

  it("routes an orthogonal polyline between sides", () => {
    const from = box("a", 0, 0, 10, 10) as PadShape;
    const to = box("b", 40, 0, 10, 10) as PadShape;
    const points = routeEdge(from, to, "right", "left");
    expect(points[0]).toEqual({ x: 10, y: 5 });
    expect(points[points.length - 1]).toEqual({ x: 40, y: 5 });
    expect(points.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1]!;
      const next = points[i]!;
      expect(prev.x === next.x || prev.y === next.y).toBe(true);
    }
  });

  it("emits a v1 polyline path d", () => {
    expect(strokePath([], 2)).toBe("");
    expect(
      strokePath(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 4 },
        ],
        2,
      ),
    ).toBe("M 0 0 L 10 0 L 10 4");
  });

  it("smooths freehand polylines with a first-party midpoint quadratic", () => {
    expect(
      strokePath(
        [
          { x: 8, y: 70 },
          { x: 24, y: 80 },
          { x: 40, y: 70 },
        ],
        2,
      ),
    ).toBe("M 8 70 Q 24 80 32 75 L 40 70");
    expect(
      strokePath(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        2,
      ),
    ).toBe("M 0 0 L 10 0");
  });
});
