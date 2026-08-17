import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PadCard } from "../src/renderer/components/pad/PadCard";
import type { TextNode } from "../src/shared/canvas";

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
