import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  Pad,
  PadPatch,
  applyPatch,
  applyPatches,
  emptyPad,
  type PadError,
  type Pad as PadValue,
} from "../src/shared/pad";

const decodePatch = (patch: unknown): PadPatch =>
  Schema.decodeUnknownSync(PadPatch)(patch);

const contentRef = {
  sha256: "a".repeat(64),
  byteLength: 4,
  mediaType: "image/png",
} as const;

const box = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: "box",
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  z: 0,
  ...over,
});

const upsertShape = (id: string, over: Record<string, unknown> = {}) =>
  decodePatch({ op: "upsert", layer: "shape", shape: box(id, over) });

const upsertEdge = (
  id: string,
  from: string,
  to: string,
  over: Record<string, unknown> = {},
) =>
  decodePatch({
    op: "upsert",
    layer: "edge",
    edge: { id, from, to, ...over },
  });

const upsertImage = (id: string, over: Record<string, unknown> = {}) =>
  decodePatch({
    op: "upsert",
    layer: "image",
    image: { id, x: 0, y: 0, w: 8, h: 8, z: 0, ref: contentRef, ...over },
  });

const upsertInk = (
  id: string,
  points: ReadonlyArray<{ x: number; y: number }>,
  over: Record<string, unknown> = {},
) =>
  decodePatch({
    op: "upsert",
    layer: "ink",
    ink: { id, z: 0, color: "#111111", width: 2, points, ...over },
  });

const twoPoints = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
] as const;

const expectOk = (result: Result.Result<PadValue, PadError>): PadValue => {
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isFailure(result)) {
    throw new Error(result.failure.message);
  }
  return result.success;
};

const expectFail = (
  result: Result.Result<PadValue, PadError>,
  code?: PadError["_tag"] extends string ? PadError["code"] : never,
): PadError => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isSuccess(result)) {
    throw new Error("expected pad patch to be refused");
  }
  if (code !== undefined) {
    expect(result.failure.code).toBe(code);
  }
  return result.failure;
};

describe("pad applyPatch", () => {
  it("refuses ids that are not unique within the pad", () => {
    const pad = expectOk(applyPatch(emptyPad(), upsertShape("n1")));
    expectFail(applyPatch(pad, upsertEdge("n1", "n1", "n1")), "layer_mismatch");
    expectFail(applyPatch(pad, upsertImage("n1")), "layer_mismatch");
    expectFail(applyPatch(pad, upsertInk("n1", twoPoints)), "layer_mismatch");
    expectFail(
      applyPatch(
        pad,
        decodePatch({
          op: "pin.upsert",
          pin: { id: "n1", x: 1, y: 1, mentions: [] },
        }),
      ),
      "layer_mismatch",
    );
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(Pad)({
          revision: 0,
          images: [],
          shapes: [box("dup"), { ...box("dup"), type: "label" }],
          edges: [],
          inks: [],
          pins: [],
        }),
      ),
    ).toBe(true);
  });

  it("refuses zero size", () => {
    expect(() => upsertShape("s1", { w: 0 })).toThrow();
    expect(() => upsertShape("s1", { h: 0 })).toThrow();
    expect(() => upsertImage("i1", { w: 0 })).toThrow();
    expect(() => upsertImage("i1", { h: -1 })).toThrow();
    expect(
      Result.isFailure(
        applyPatch(
          emptyPad(),
          { op: "upsert", layer: "shape", shape: box("s1", { w: 0 }) } as never,
        ),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        applyPatch(emptyPad(), {
          op: "pin.upsert",
          pin: { id: "p1", x: 0, y: 0, mentions: [], bounds: { w: 0, h: 4 } },
        } as never),
      ),
    ).toBe(true);
  });

  it("refuses a dangling edge", () => {
    const pad = expectOk(applyPatch(emptyPad(), upsertShape("a")));
    expectFail(applyPatch(pad, upsertEdge("e1", "a", "missing")), "dangling_edge");
    expectFail(applyPatch(emptyPad(), upsertEdge("e1", "a", "b")), "dangling_edge");
    const connected = expectOk(
      applyPatches(emptyPad(), [
        upsertShape("a"),
        upsertShape("b"),
        upsertEdge("e1", "a", "b"),
      ]),
    );
    expect(connected.edges).toHaveLength(1);
  });

  it("deletes a shape and its edges in the same application", () => {
    const pad = expectOk(
      applyPatches(emptyPad(), [
        upsertShape("a"),
        upsertShape("b"),
        upsertShape("c"),
        upsertEdge("ab", "a", "b"),
        upsertEdge("bc", "b", "c"),
      ]),
    );
    const next = expectOk(applyPatch(pad, decodePatch({ op: "delete", id: "b" })));
    expect(next.shapes.map((shape) => shape.id)).toEqual(["a", "c"]);
    expect(next.edges).toEqual([]);
    expect(next.revision).toBe(pad.revision + 1);
  });

  it("refuses empty ink", () => {
    expect(() => upsertInk("k1", [])).toThrow();
    expect(() => upsertInk("k1", [{ x: 0, y: 0 }])).toThrow();
    expect(
      Result.isFailure(
        applyPatch(
          emptyPad(),
          {
            op: "upsert",
            layer: "ink",
            ink: { id: "k1", z: 0, color: "#000", width: 1, points: [] },
          } as never,
        ),
      ),
    ).toBe(true);
    const drawn = expectOk(applyPatch(emptyPad(), upsertInk("k1", twoPoints)));
    expect(drawn.inks).toHaveLength(1);
  });

  it("treats upsert as idempotent create-or-replace by id", () => {
    const first = expectOk(applyPatch(emptyPad(), upsertShape("s1", { text: "one" })));
    const second = expectOk(
      applyPatch(first, upsertShape("s1", { text: "one" })),
    );
    expect(second.shapes).toHaveLength(1);
    expect(second.shapes[0]?.text).toBe("one");
    const replaced = expectOk(
      applyPatch(second, upsertShape("s1", { text: "two", w: 20, h: 20 })),
    );
    expect(replaced.shapes).toHaveLength(1);
    expect(replaced.shapes[0]?.text).toBe("two");
    expect(replaced.shapes[0]?.w).toBe(20);
  });

  it("increments revision on each accepted patch and not on refusal", () => {
    expect(emptyPad().revision).toBe(0);
    const one = expectOk(applyPatch(emptyPad(), upsertShape("a")));
    expect(one.revision).toBe(1);
    const two = expectOk(applyPatch(one, upsertShape("b")));
    expect(two.revision).toBe(2);
    expectFail(applyPatch(two, upsertEdge("e1", "a", "missing")), "dangling_edge");
    expect(two.revision).toBe(2);
    const three = expectOk(
      applyPatches(two, [upsertEdge("e1", "a", "b"), decodePatch({ op: "z", id: "a", z: 3 })]),
    );
    expect(three.revision).toBe(4);
    const refused = applyPatches(two, [
      upsertEdge("e1", "a", "b"),
      upsertEdge("bad", "a", "ghost"),
    ]);
    expectFail(refused, "dangling_edge");
    expect(two.shapes).toHaveLength(2);
    expect(two.edges).toHaveLength(0);
  });

  it("cannot change layer type via upsert of a different layer onto the same id", () => {
    const pad = expectOk(applyPatch(emptyPad(), upsertShape("x")));
    expectFail(applyPatch(pad, upsertInk("x", twoPoints)), "layer_mismatch");
    expectFail(applyPatch(pad, upsertImage("x")), "layer_mismatch");
    expectFail(applyPatch(pad, upsertEdge("x", "x", "x")), "layer_mismatch");
    const same = expectOk(applyPatch(pad, upsertShape("x", { type: "ellipse" })));
    expect(same.shapes).toHaveLength(1);
    expect(same.shapes[0]?.type).toBe("ellipse");
    expect(same.inks).toHaveLength(0);
  });

  it("pin.upsert updates the shell and keeps posts", () => {
    const pinned = expectOk(
      applyPatch(
        emptyPad(),
        decodePatch({
          op: "pin.upsert",
          pin: { id: "p1", x: 2, y: 3, mentions: ["agent-1"] },
        }),
      ),
    );
    const replied = expectOk(
      applyPatch(
        pinned,
        decodePatch({
          op: "pin.reply",
          pinId: "p1",
          post: {
            postId: "post-1",
            author: { kind: "operator", label: "operator" },
            parts: [{ kind: "text", text: "look here" }],
          },
        }),
      ),
    );
    expect(replied.pins[0]?.posts).toHaveLength(1);
    const moved = expectOk(
      applyPatch(
        replied,
        decodePatch({
          op: "pin.upsert",
          pin: { id: "p1", x: 9, y: 9, mentions: [] },
        }),
      ),
    );
    expect(moved.pins).toHaveLength(1);
    expect(moved.pins[0]?.x).toBe(9);
    expect(moved.pins[0]?.mentions).toEqual([]);
    expect(moved.pins[0]?.posts).toHaveLength(1);
    expect(moved.pins[0]?.posts[0]?.postId).toBe("post-1");
  });
});
