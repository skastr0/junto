import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  PadPatch,
  applyPatches,
  emptyPad,
  type Pad,
  type PadError,
} from "../src/shared/pad";
import { lookHereBounds } from "../src/shared/pad-geom";
import {
  LOOK_HERE_MARGIN,
  padLookHere,
  padToDigest,
  padToFocused,
  padToSvg,
} from "../src/shared/pad-project";

const decodePatch = (patch: unknown): PadPatch =>
  Schema.decodeUnknownSync(PadPatch)(patch);

const contentRef = {
  sha256: "ab".repeat(32),
  byteLength: 8,
  mediaType: "image/png",
  displayName: "shot",
} as const;

const expectOk = (result: Result.Result<Pad, PadError>): Pad => {
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
};

const page = (): Pad =>
  expectOk(
    applyPatches(emptyPad(), [
      decodePatch({
        op: "upsert",
        layer: "image",
        image: { id: "img1", x: 0, y: 0, w: 200, h: 24, z: 0, ref: contentRef },
      }),
      decodePatch({
        op: "upsert",
        layer: "shape",
        shape: {
          id: "box1",
          type: "box",
          x: 8,
          y: 32,
          w: 40,
          h: 20,
          z: 0,
          text: "inbox",
          status: "active",
        },
      }),
      decodePatch({
        op: "upsert",
        layer: "shape",
        shape: {
          id: "ell1",
          type: "ellipse",
          x: 80,
          y: 32,
          w: 20,
          h: 20,
          z: 1,
          status: "done",
        },
      }),
      decodePatch({
        op: "upsert",
        layer: "edge",
        edge: {
          id: "e1",
          from: "box1",
          to: "ell1",
          fromSide: "right",
          toSide: "left",
          label: "to",
        },
      }),
      decodePatch({
        op: "upsert",
        layer: "ink",
        ink: {
          id: "k1",
          z: 0,
          color: "#445566",
          width: 2,
          points: [
            { x: 8, y: 70 },
            { x: 24, y: 80 },
            { x: 40, y: 70 },
          ],
        },
      }),
      decodePatch({
        op: "pin.upsert",
        pin: {
          id: "p1",
          x: 20,
          y: 40,
          mentions: ["agent-1"],
          bounds: { w: 40, h: 20 },
        },
      }),
      decodePatch({
        op: "pin.reply",
        pinId: "p1",
        post: {
          postId: "post-1",
          author: { kind: "operator", label: "operator" },
          parts: [{ kind: "text", text: "look here" }],
        },
      }),
    ]),
  );

const EMPTY_DIGEST = [
  "pad :: revision=0",
  "images :: 0",
  "shapes :: 0",
  "edges :: 0",
  "inks :: 0",
  "pins :: 0",
].join("\n");

const PAGE_DIGEST = [
  "pad :: revision=7",
  "images :: 1",
  '  img1 :: 0,0 200x24 sha=abababab name="shot" image/png',
  "shapes :: 2",
  '  box1 :: box 8,32 40x20 text="inbox" status=active',
  "  ell1 :: ellipse 80,32 20x20 status=done",
  "edges :: 1",
  '  e1 :: box1/right -> ell1/left label="to"',
  "inks :: 1",
  "  k1 :: width=2 color=#445566 points=3",
  "pins :: 1",
  "  p1 :: 20,40 bounds=40x20 mentions=agent-1 posts=1",
].join("\n");

describe("padToDigest", () => {
  it("matches the empty and populated goldens", () => {
    expect(padToDigest(emptyPad())).toBe(EMPTY_DIGEST);
    expect(padToDigest(page())).toBe(PAGE_DIGEST);
  });

  it("is deterministic and never dumps ink points", () => {
    const pad = page();
    expect(padToDigest(pad)).toBe(padToDigest(pad));
    expect(padToDigest(pad)).not.toContain("8,70");
    expect(padToDigest(pad)).toContain("points=3");
  });
});

describe("padToSvg", () => {
  it("is deterministic and paints layers in contract order", () => {
    const pad = page();
    const svg = padToSvg(pad, "dark");
    expect(svg).toBe(padToSvg(pad, "dark"));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    const imageAt = svg.indexOf("shot abababab");
    const boxAt = svg.indexOf(">inbox<");
    const edgeAt = svg.indexOf("<path d=\"M ");
    const inkAt = svg.lastIndexOf("stroke=\"#445566\"");
    const pinAt = svg.lastIndexOf("<circle ");
    expect(imageAt).toBeGreaterThan(-1);
    expect(edgeAt).toBeGreaterThan(imageAt);
    expect(boxAt).toBeGreaterThan(edgeAt);
    expect(inkAt).toBeGreaterThan(boxAt);
    expect(pinAt).toBeGreaterThan(inkAt);
  });

  it("labels images with the sha prefix unless an href map is supplied", () => {
    const pad = page();
    const labeled = padToSvg(pad, "dark");
    expect(labeled).toContain("shot abababab");
    expect(labeled).not.toContain("<image ");
    expect(labeled).not.toMatch(/data:image|bytesBase64/);
    const linked = padToSvg(pad, "dark", { hrefs: { img1: "content:img1" } });
    expect(linked).toContain('<image href="content:img1"');
    expect(linked).not.toContain("shot abababab");
  });

  it("contains a golden svg snippet for the active box", () => {
    const svg = padToSvg(page(), "dark");
    expect(svg).toContain('<rect x="8" y="32" width="40" height="20"');
    expect(svg).toContain(">inbox<");
    expect(svg).toContain("<ellipse ");
    expect(svg).toContain('stroke="#445566"');
    expect(svg).toContain("<circle cx=\"20\" cy=\"40\" r=\"5\"");
  });
});

describe("padToFocused", () => {
  it("emits compact id/type/bounds/text/status rows", () => {
    const items = padToFocused(page());
    expect(items.map((item) => item.id)).toEqual([
      "img1",
      "box1",
      "ell1",
      "e1",
      "k1",
      "p1",
    ]);
    expect(items[1]).toMatchObject({
      id: "box1",
      type: "box",
      bounds: { x: 8, y: 32, w: 40, h: 20 },
      text: "inbox",
      status: "active",
    });
    expect(items[2]).toMatchObject({
      id: "ell1",
      type: "ellipse",
      status: "done",
    });
    expect(items[3]?.type).toBe("edge");
    expect(items[4]).toMatchObject({ id: "k1", type: "ink" });
    expect(items[5]).toMatchObject({ id: "p1", type: "pin", text: "look here" });
  });
});

describe("padLookHere", () => {
  it("crops around pin.bounds", () => {
    const pad = page();
    const result = padLookHere(pad, "p1");
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) throw new Error(result.failure.message);
    expect(result.success.bounds).toEqual({ x: 0, y: 30, w: 40, h: 20 });
    expect(result.success.digest.startsWith("look-here :: p1\nbounds :: 0,30 40x20\n")).toBe(
      true,
    );
    expect(result.success.svg).toContain('viewBox="0 30 40 20"');
    expect(result.success.digest).toContain("box1 ::");
    expect(result.success.digest).not.toContain("8,70");
  });

  it("crops pin ± margin when bounds are omitted", () => {
    const pad = expectOk(
      applyPatches(emptyPad(), [
        decodePatch({
          op: "pin.upsert",
          pin: { id: "p2", x: 10, y: 12, mentions: [] },
        }),
      ]),
    );
    const result = padLookHere(pad, "p2");
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) throw new Error(result.failure.message);
    expect(result.success.bounds).toEqual({
      x: 10 - LOOK_HERE_MARGIN,
      y: 12 - LOOK_HERE_MARGIN,
      w: LOOK_HERE_MARGIN * 2,
      h: LOOK_HERE_MARGIN * 2,
    });
    expect(lookHereBounds(pad.pins[0]!, LOOK_HERE_MARGIN)).toEqual(result.success.bounds);
  });

  it("refuses a missing pin", () => {
    const result = padLookHere(emptyPad(), "ghost");
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) throw new Error("expected missing pin");
    expect(result.failure.code).toBe("missing");
  });
});
