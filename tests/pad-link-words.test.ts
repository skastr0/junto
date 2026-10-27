import { describe, expect, it } from "vitest";
import { mentionLink } from "../src/shared/mention";
import { padLinkWords, padShapeText, padToFocused } from "../src/shared/pad-project";
import type { NodeId } from "../src/shared/physics/schema";
import type { ItemId } from "../src/shared/work-ids";

const shelf = "artifacts-shelf" as NodeId;
const plan = "01M5ZBT64KHP4JGH67RV1YCS6B" as ItemId;
const link = mentionLink({ kind: "artifact", nodeId: shelf, artifactId: plan }, "[[Launch plan]]", "factory");

describe("links in pad text", () => {
  it("draws an artifact link as the title it was written with", () => {
    expect(padLinkWords(`See ${link} first`)).toBe("See Launch plan first");
  });

  it("draws the current title when the reader knows it", () => {
    const titleOf = (target: { readonly nodeId: NodeId; readonly item?: ItemId }) =>
      target.nodeId === shelf && target.item === plan ? "Launch plan v2" : undefined;
    expect(padLinkWords(`See ${link} first`, titleOf)).toBe("See Launch plan v2 first");
  });

  it("keeps a seat mention's own words and plain text as it is", () => {
    const seat = mentionLink({ kind: "seat", nodeId: "agent-a" as NodeId }, "@product-feed", "factory");
    expect(padLinkWords(`ask ${seat}`)).toBe("ask @product-feed");
    expect(padLinkWords("[[not a link]] and [x](https://example.com)")).toBe("[[not a link]] and [x](https://example.com)");
  });

  it("reaches shape words and the focus list", () => {
    const shape = { id: "s1", type: "rect", x: 0, y: 0, w: 120, h: 60, z: 0, text: `Read ${link}` } as const;
    expect(padShapeText(shape as never)).toBe("Read Launch plan");
    const focused = padToFocused({
      revision: 0,
      images: [],
      shapes: [shape as never],
      edges: [{ id: "e1", from: { shape: "s1" }, to: { shape: "s1" }, z: 1, label: link } as never],
      inks: [],
    });
    expect(focused.find((item) => item.id === "s1")?.text).toBe("Read Launch plan");
  });
});
