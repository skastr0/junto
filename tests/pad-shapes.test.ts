import { Result } from "effect";
import { describe, expect, test } from "vitest";
import { applyPatch, decodePad, decodePadShape, emptyPad, type PadShape } from "../src/shared/pad";
import { anchorPoint, cylinderPaths, hitTest } from "../src/shared/pad-geom";
import { padToDigest, padToSvg } from "../src/shared/pad-project";

const SEAT = "junto://canvas/factory?node=agent-01M46TAATD7VE4ZQA4VRKMX3MP";

const shape = (fields: Record<string, unknown>): Record<string, unknown> => ({
  id: "s1",
  type: "box",
  x: 0,
  y: 0,
  w: 100,
  h: 60,
  z: 0,
  ...fields,
});

const decodes = (fields: Record<string, unknown>): boolean => Result.isSuccess(decodePadShape(shape(fields)));

describe("pad shape kinds", () => {
  test("a diamond and a cylinder decode like any shape, with text and status", () => {
    expect(decodes({ type: "diamond", text: "ship?", status: "active" })).toBe(true);
    expect(decodes({ type: "cylinder", text: "junto.db", fill: "#223344" })).toBe(true);
  });

  test("a card carries a canonical mention href and an optional label", () => {
    expect(decodes({ type: "card", href: SEAT })).toBe(true);
    expect(decodes({ type: "card", href: SEAT, label: "product-lead" })).toBe(true);
    expect(decodes({ type: "card", href: `${SEAT}&item=01M5YBKD8W8D7GGKXKPA4GE2GA` })).toBe(true);
  });

  test("a card without a link, or with one that is not a mention, is refused", () => {
    expect(decodes({ type: "card" })).toBe(false);
    expect(decodes({ type: "card", href: "https://example.com" })).toBe(false);
    expect(decodes({ type: "card", href: "junto://canvas/factory" })).toBe(false);
  });

  test("a card draws its own words and colour, so it takes no text, fill, stroke or status", () => {
    expect(decodes({ type: "card", href: SEAT, text: "x" })).toBe(false);
    expect(decodes({ type: "card", href: SEAT, fill: "#000000" })).toBe(false);
    expect(decodes({ type: "card", href: SEAT, stroke: "#000000" })).toBe(false);
    expect(decodes({ type: "card", href: SEAT, status: "done" })).toBe(false);
  });

  test("only a card carries an href or a label, and a label stays under 200 characters", () => {
    expect(decodes({ type: "box", href: SEAT })).toBe(false);
    expect(decodes({ type: "box", label: "x" })).toBe(false);
    expect(decodes({ type: "card", href: SEAT, label: "x".repeat(200) })).toBe(true);
    expect(decodes({ type: "card", href: SEAT, label: "x".repeat(201) })).toBe(false);
    expect(decodes({ type: "card", href: SEAT, label: "" })).toBe(false);
  });

  test("a body written before the new kinds decodes unchanged", () => {
    const old = { revision: 3, images: [], shapes: [shape({ text: "a" }), shape({ id: "s2", type: "triangle" })], edges: [], inks: [] };
    expect(Result.isSuccess(decodePad(old))).toBe(true);
  });

  test("an edge binds a card like any shape, through the ordinary upsert", () => {
    const card = decodePadShape(shape({ id: "c", type: "card", href: SEAT, label: "lead" }));
    const box = decodePadShape(shape({ id: "b", x: 300 }));
    if (Result.isFailure(card) || Result.isFailure(box)) throw new Error("decode");
    let pad = emptyPad();
    for (const patch of [
      { op: "upsert", layer: "shape", shape: card.success },
      { op: "upsert", layer: "shape", shape: box.success },
      { op: "upsert", layer: "edge", edge: { id: "e", from: "b", to: "c" } },
    ] as const) {
      const next = applyPatch(pad, patch as never);
      if (Result.isFailure(next)) throw new Error(next.failure.message);
      pad = next.success;
    }
    expect(pad.edges).toHaveLength(1);
    expect(padToDigest(pad)).toContain(`href=${SEAT}`);
    expect(padToDigest(pad)).toContain('label="lead"');
    expect(padToSvg(pad)).toContain("lead");
  });

  test("a diamond is hit inside its corners, not in its box's corners", () => {
    const diamond = decodePadShape(shape({ type: "diamond" }));
    if (Result.isFailure(diamond)) throw new Error("decode");
    const pad = { ...emptyPad(), shapes: [diamond.success] };
    expect(hitTest(pad, { x: 50, y: 30 })?.id).toBe("s1");
    expect(hitTest(pad, { x: 4, y: 4 })).toBeUndefined();
    expect(anchorPoint(diamond.success as PadShape, "right")).toEqual({ x: 100, y: 30 });
  });

  test("a cylinder's rim never takes more than a quarter of its height", () => {
    const flat = cylinderPaths(shape({ type: "cylinder", h: 12 }) as PadShape);
    expect(flat.rim).toContain(" 50 3 ");
  });
});
