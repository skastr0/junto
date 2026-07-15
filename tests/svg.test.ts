import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { renderCanvasSvg } from "../src/shared/svg";

const doc: CanvasDoc = {
  nodes: [
    { id: "g1", type: "group", x: 0, y: 0, width: 400, height: 200, label: "instruments" },
    {
      id: "n1",
      type: "text",
      x: 20,
      y: 40,
      width: 180,
      height: 70,
      text: "prism",
      ether: {
        entity: { kind: "task" },
        tasks: { items: [{ id: "i1", text: "ship", done: false }] },
      },
    },
    {
      id: "n2",
      type: "text",
      x: 240,
      y: 40,
      width: 180,
      height: 70,
      text: "tower",
      ether: { entity: { kind: "project", name: "tower" } },
    },
  ],
  edges: [
    { id: "e1", fromNode: "n1", toNode: "n2", ether: { criteria: { mode: "tasks" } } },
  ],
};

describe("renderCanvasSvg", () => {
  it("produces a well-formed svg element", () => {
    const svg = renderCanvasSvg(doc);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toContain("viewBox=");
  });

  it("is deterministic", () => {
    expect(renderCanvasSvg(doc)).toBe(renderCanvasSvg(doc));
  });

  it("renders each node title and the group label", () => {
    const svg = renderCanvasSvg(doc);
    expect(svg).toContain(">prism<");
    expect(svg).toContain(">tower<");
    expect(svg).toContain("INSTRUMENTS");
  });

  it("draws the edge", () => {
    expect(renderCanvasSvg(doc)).toContain("<line");
  });

  it("escapes special characters in titles", () => {
    const svg = renderCanvasSvg({
      nodes: [{ id: "x", type: "text", x: 0, y: 0, width: 100, height: 40, text: "a & b <c>" }],
      edges: [],
    });
    expect(svg).toContain("a &amp; b &lt;c&gt;");
    expect(svg).not.toContain("a & b <c>");
  });
});
