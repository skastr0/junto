import { Result, Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PadCard } from "../src/renderer/components/pad/PadCard";
import { PadSvg } from "../src/renderer/components/pad/PadSvg";
import type { TextNode } from "../src/shared/canvas";
import {
  applyPatch,
  emptyPad,
  PadPatch,
  type PadError,
  type Pad as PadValue,
} from "../src/shared/pad";
import { padSvgPalette } from "../src/shared/pad-project";

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
});
