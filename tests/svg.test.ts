import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { renderCanvasSvg as renderCanvasSvgWithContext } from "../src/shared/svg";
import { executionContextForDoc } from "./helpers/actor-ref-fixtures";

const renderCanvasSvg = (doc: CanvasDoc): string =>
  renderCanvasSvgWithContext(doc, executionContextForDoc(doc));

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
        tasks: {
          items: [
            {
              id: "i1",
              state: "submitted",
              history: [
                {
                  messageId: "m1",
                  role: "user",
                  parts: [{ kind: "text", text: "ship" }],
                  taskId: "i1",
                },
              ],
            },
          ],
        },
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
    { id: "e1", fromNode: "n1", toNode: "n2", ether: { stops: { mode: "tasks" } } },
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

  it("renders an unmasked actor↔actor edge as an amber collaboration link", () => {
    const svg = renderCanvasSvg({
      nodes: [
        { id: "a1", type: "text", x: 0, y: 0, width: 120, height: 48, text: "Alpha", ether: { entity: { kind: "agent" } } },
        { id: "a2", type: "text", x: 200, y: 0, width: 120, height: 48, text: "Beta", ether: { entity: { kind: "agent" } } },
      ],
      edges: [{ id: "a2a", fromNode: "a1", toNode: "a2" }],
    });
    expect(svg).toContain('stroke="#E8A33D"');
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
