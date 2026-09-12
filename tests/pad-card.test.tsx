import { Result, Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PadCard } from "../src/renderer/components/pad/PadCard";
import { PadSvg } from "../src/renderer/components/pad/PadSvg";
import type { TextNode } from "../src/shared/canvas";
import {
  applyPatch,
  applyPatches,
  emptyPad,
  PadPatch,
  type PadError,
  type Pad as PadValue,
} from "../src/shared/pad";
import { padSvgPalette, padToSvg } from "../src/shared/pad-project";

const padNode = (over: Partial<TextNode> = {}): TextNode => ({
  id: "pad-1",
  type: "text",
  text: "shared page",
  x: 0,
  y: 0,
  width: 240,
  height: 120,
  ether: { entity: { kind: "pad" } },
  ...over,
});

describe("PadCard", () => {
  it("renders the empty-state icon when the pad has no shapes", () => {
    const html = renderToStaticMarkup(<PadCard node={padNode()} />);
    expect(html).toContain('data-testid="pad-card"');
    expect(html).toContain('data-testid="pad-card-empty"');
    expect(html).toContain("0 shapes");
    expect(html).toContain("shared page");
  });

  it("shows glance counts from ether", () => {
    const html = renderToStaticMarkup(
      <PadCard
        node={padNode({
          ether: {
            entity: { kind: "pad" },
            pad: { revision: 3, shapeCount: 2, unreadPinCount: 1 },
          },
        })}
      />,
    );
    expect(html).toContain("2 shapes");
    expect(html).toContain("1 new");
  });
});

describe("PadSvg", () => {
  it("renders geometry without injecting hostile fill markup", () => {
    const fill =
      `"></rect><image href="x-invalid:" onerror="window.pwned=42"></image><rect fill="`;
    const decoded = Schema.decodeUnknownSync(PadPatch)({
      op: "upsert",
      layer: "shape",
      shape: {
        id: "xss",
        type: "box",
        x: 0,
        y: 0,
        w: 10,
        h: 10,
        z: 0,
        fill,
      },
    });
    const result = applyPatch(emptyPad(), decoded);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) throw new Error((result.failure as PadError).message);
    const pad: PadValue = result.success;
    const html = renderToStaticMarkup(<PadSvg pad={pad} theme="dark" />);
    expect(html).toContain("<svg");
    expect(html).toContain("<rect");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<image");
    expect(html).toContain(`fill="${padSvgPalette("dark").fill}"`);
    expect(html).not.toContain(fill);
  });

  it("matches padToSvg layer tags and paint for both themes", () => {
    const decode = Schema.decodeUnknownSync(PadPatch);
    const result = applyPatches(emptyPad(), [
      decode({
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
          fill: "#445566",
        },
      }),
      decode({
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
      decode({
        op: "upsert",
        layer: "ink",
        ink: {
          id: "k1",
          z: 0,
          color: "#abcdef",
          width: 2,
          points: [
            { x: 8, y: 70 },
            { x: 24, y: 80 },
          ],
        },
      }),
      decode({
        op: "pin.upsert",
        pin: { id: "p1", x: 20, y: 40, mentions: [] },
      }),
    ]);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) throw new Error(result.failure.message);
    const pad = result.success;
    for (const theme of ["dark", "bright"] as const) {
      const html = renderToStaticMarkup(<PadSvg pad={pad} theme={theme} />);
      const svg = padToSvg(pad, theme);
      expect(html).toContain("<ellipse");
      expect(svg).toContain("<ellipse");
      expect(html).toContain('fill="#445566"');
      expect(svg).toContain('fill="#445566"');
      expect(html).toContain('stroke="#abcdef"');
      expect(svg).toContain('stroke="#abcdef"');
      expect(html).toContain(">inbox<");
      expect(svg).toContain(">inbox<");
      expect(html).toContain("<circle");
      expect(svg).toContain("<circle");
      const pal = padSvgPalette(theme);
      expect(html).toContain(`stroke="${pal.green}"`);
      expect(svg).toContain(`stroke="${pal.green}"`);
    }
  });
});
