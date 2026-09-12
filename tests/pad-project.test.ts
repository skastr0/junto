import { DOMParser } from "@xmldom/xmldom";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  PadPatch,
  applyPatches,
  emptyPad,
  type Pad,
  type PadError,
} from "../src/shared/pad";
import { lookHereBounds, strokePath } from "../src/shared/pad-geom";
import {
  LOOK_HERE_MARGIN,
  isPadPaintLiteral,
  padInkStroke,
  padLookHere,
  padShapeFill,
  padShapeStroke,
  padSvgPalette,
  padToDigest,
  padToFocused,
  padToSvg,
  resolvePadPaint,
} from "../src/shared/pad-project";
import type { PadShape } from "../src/shared/pad";

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

  it("contains the ink polyline path", () => {
    const pad = page();
    const ink = pad.inks[0]!;
    const svg = padToSvg(pad, "dark");
    expect(svg).toContain(`d="${strokePath(ink.points, ink.width)}"`);
    expect(svg).toContain(`stroke="${ink.color}"`);
    expect(svg).toContain(`stroke-width="${ink.width}"`);
    expect(padToDigest(pad)).not.toContain("8,70");
    expect(padToDigest(pad)).toContain("points=3");
  });

  it("frames a thumbnail without a fixed pixel size", () => {
    const framed = padToSvg(page(), "dark", { framed: true, padding: 16 });
    const open = framed.slice(0, framed.indexOf(">"));
    expect(open).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(open).toContain("viewBox=");
    expect(open).not.toContain("width=");
    expect(open).not.toContain("height=");
  });
});

const XSS_BREAKOUT =
  `"></rect><image href="x-invalid:" onerror="window.pwned=42"></image><rect fill="`;
const XSS_ONLOAD = `" onload="window.pwned=1`;

const HOSTILE_PAINT = [
  XSS_BREAKOUT,
  XSS_ONLOAD,
  `" onerror="window.pwned=7`,
  `<script>window.pwned=1</script>`,
  "javascript:alert(1)",
  "url(#x)",
  "URL(https://example.invalid)",
  "url\\28 x \\29",
  "var(--color-ink)",
  "rgb(0,0,0)",
  "red",
  " #fff",
  "#fff\n",
  "#gggggg",
  "#ffffffff0",
] as const;

const VALID_PAINT = ["none", "#f00", "#f00a", "#445566", "#445566aa", "#ABC", "#ABCDEF"] as const;

const shapeWith = (
  type: PadShape["type"],
  field: "fill" | "stroke",
  value: string,
): Pad =>
  expectOk(
    applyPatches(emptyPad(), [
      decodePatch({
        op: "upsert",
        layer: "shape",
        shape: {
          id: "s1",
          type,
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          z: 0,
          [field]: value,
        },
      }),
    ]),
  );

const inkWith = (color: string): Pad =>
  expectOk(
    applyPatches(emptyPad(), [
      decodePatch({
        op: "upsert",
        layer: "ink",
        ink: {
          id: "k1",
          z: 0,
          color,
          width: 2,
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      }),
    ]),
  );

const svgHasBreakout = (svg: string): boolean =>
  /<(?:image|script|foreignObject)\b/i.test(svg) ||
  /\son(?:error|load)\s*=/i.test(svg);

describe("resolvePadPaint", () => {
  it("accepts exact none and hex literals and rejects everything else", () => {
    for (const value of VALID_PAINT) {
      expect(isPadPaintLiteral(value)).toBe(true);
      expect(resolvePadPaint(value, "#111111")).toBe(value);
    }
    expect(resolvePadPaint(undefined, "#111111")).toBe("#111111");
    for (const value of HOSTILE_PAINT) {
      expect(isPadPaintLiteral(value)).toBe(false);
      expect(resolvePadPaint(value, "#111111")).toBe("#111111");
    }
  });
});

describe("padToSvg paint safety", () => {
  const types = ["box", "ellipse", "triangle", "label"] as const;
  const fields = ["fill", "stroke"] as const;
  const themes = ["dark", "bright"] as const;

  it("does not emit markup or event handlers from hostile fill, stroke, or ink", () => {
    for (const theme of themes) {
      const pal = padSvgPalette(theme);
      for (const type of types) {
        for (const field of fields) {
          for (const value of HOSTILE_PAINT) {
            const pad = shapeWith(type, field, value);
            const svg = padToSvg(pad, theme);
            expect(svgHasBreakout(svg)).toBe(false);
            expect(svg).not.toContain(value);
            const shape = pad.shapes[0]!;
            const expected =
              field === "fill"
                ? padShapeFill(shape, pal)
                : padShapeStroke(shape, pal);
            expect(svg).toContain(`${field}="${expected}"`);
            expect(expected === pal.fill || expected === pal.stroke).toBe(true);
          }
        }
      }
      for (const value of HOSTILE_PAINT) {
        const pad = inkWith(value);
        const svg = padToSvg(pad, theme);
        expect(svgHasBreakout(svg)).toBe(false);
        expect(svg).not.toContain(value);
        expect(svg).toContain(`stroke="${padInkStroke(value, pal)}"`);
        expect(padInkStroke(value, pal)).toBe(pal.text);
      }
    }
  });

  it("preserves supported hex and none on fill, stroke, and ink", () => {
    for (const value of VALID_PAINT) {
      for (const type of types) {
        const fillPad = shapeWith(type, "fill", value);
        const strokePad = shapeWith(type, "stroke", value);
        expect(padToSvg(fillPad, "dark")).toContain(`fill="${value}"`);
        expect(padToSvg(strokePad, "dark")).toContain(`stroke="${value}"`);
      }
      const pad = inkWith(value);
      expect(padToSvg(pad, "dark")).toContain(`stroke="${value}"`);
    }
  });

  it("keeps hostile strings in IR while rendering defaults", () => {
    const pad = shapeWith("box", "fill", XSS_BREAKOUT);
    expect(pad.shapes[0]?.fill).toBe(XSS_BREAKOUT);
    const svg = padToSvg(pad, "dark");
    expect(svgHasBreakout(svg)).toBe(false);
    expect(svg).toContain(`fill="${padSvgPalette("dark").fill}"`);
  });

  it("escapes quotes in text, labels, and hrefs", () => {
    const pad = expectOk(
      applyPatches(emptyPad(), [
        decodePatch({
          op: "upsert",
          layer: "shape",
          shape: {
            id: "box1",
            type: "box",
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            z: 0,
            text: `say "hi" & <go>`,
          },
        }),
        decodePatch({
          op: "upsert",
          layer: "shape",
          shape: {
            id: "box2",
            type: "box",
            x: 20,
            y: 0,
            w: 10,
            h: 10,
            z: 0,
          },
        }),
        decodePatch({
          op: "upsert",
          layer: "edge",
          edge: {
            id: "e1",
            from: "box1",
            to: "box2",
            label: `a"b`,
          },
        }),
      ]),
    );
    const svg = padToSvg(pad, "dark", { hrefs: { img1: `content:"x"` } });
    expect(svg).toContain("say &quot;hi&quot; &amp; &lt;go&gt;");
    expect(svg).toContain(">a&quot;b<");
    const linked = padToSvg(
      expectOk(
        applyPatches(emptyPad(), [
          decodePatch({
            op: "upsert",
            layer: "image",
            image: {
              id: "img1",
              x: 0,
              y: 0,
              w: 8,
              h: 8,
              z: 0,
              ref: contentRef,
            },
          }),
        ]),
      ),
      "dark",
      { hrefs: { img1: `vellum-command-content:x" onerror="1` } },
    );
    expect(linked).toContain('href="vellum-command-content:x&quot; onerror=&quot;1"');
    expect(linked).not.toMatch(/\sonerror="/i);
  });

  it("does not create extra elements when the svg is parsed as markup", () => {
    const pad = shapeWith("box", "fill", XSS_BREAKOUT);
    const svg = padToSvg(pad, "dark");
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(doc.getElementsByTagName("image")).toHaveLength(0);
    expect(doc.getElementsByTagName("script")).toHaveLength(0);
    expect(doc.getElementsByTagName("rect").length).toBeGreaterThan(0);
    const attr = (el: { getAttribute(name: string): string | null } | null, name: string) =>
      el?.getAttribute(name) || null;
    const withHandler = doc.getElementsByTagName("*");
    for (let i = 0; i < withHandler.length; i += 1) {
      const el = withHandler.item(i);
      expect(attr(el, "onerror")).toBeNull();
      expect(attr(el, "onload")).toBeNull();
    }

    const control = `<svg xmlns="http://www.w3.org/2000/svg"><rect fill=""></rect><image href="x-invalid:" onerror="window.pwned=42"></image></svg>`;
    const controlDoc = new DOMParser().parseFromString(control, "image/svg+xml");
    expect(controlDoc.getElementsByTagName("image")).toHaveLength(1);
    expect(controlDoc.getElementsByTagName("image")[0]?.getAttribute("onerror")).toBe(
      "window.pwned=42",
    );
  });

  it("keeps look-here svg equally safe", () => {
    const pad = expectOk(
      applyPatches(shapeWith("box", "fill", XSS_BREAKOUT), [
        decodePatch({
          op: "pin.upsert",
          pin: { id: "p1", x: 4, y: 4, mentions: [], bounds: { w: 10, h: 10 } },
        }),
      ]),
    );
    const result = padLookHere(pad, "p1");
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) throw new Error(result.failure.message);
    expect(svgHasBreakout(result.success.svg)).toBe(false);
    expect(result.success.svg).not.toContain("onerror=");
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
