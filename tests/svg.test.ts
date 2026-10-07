import { describe, expect, it } from "vitest";
import type { Canvas, Node, Wire } from "../src/shared/model";
import { renderCanvasSvg as renderCanvasSvgWithContext } from "../src/shared/svg";
import { canvasOf, note, region, seat, taskBoard, wire } from "./support/model-nodes";

/** The picture of these nodes and wires, with no work and no actors beside them. */
const renderCanvasSvg = (nodes: ReadonlyArray<Node>, wires: ReadonlyArray<Wire> = []): string => {
  const canvas: Canvas = canvasOf(nodes, wires);
  return renderCanvasSvgWithContext(canvas, {
    canvasName: canvas.name,
    resolveActorRef: () => undefined,
    itemsOf: () => [],
  });
};

const nodes = [
  region("g1", { x: 0, y: 0, width: 400, height: 200 }, { label: "instruments" }),
  note("n1", "prism", { x: 20, y: 40, width: 180, height: 70 }),
  taskBoard("n2", { x: 240, y: 40, width: 180, height: 70, name: "tower" as never }),
];
const wires = [wire("e1", "n1", "n2", "contributes")];

describe("renderCanvasSvg", () => {
  it("produces a well-formed svg element", () => {
    const svg = renderCanvasSvg(nodes, wires);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toContain("viewBox=");
  });

  it("is deterministic", () => {
    expect(renderCanvasSvg(nodes, wires)).toBe(renderCanvasSvg(nodes, wires));
  });

  it("renders each node title and the region label", () => {
    const svg = renderCanvasSvg(nodes, wires);
    expect(svg).toContain(">prism<");
    expect(svg).toContain(">tower<");
    expect(svg).toContain("INSTRUMENTS");
  });

  it("heads a card by its kind, and leaves a note to say what it is itself", () => {
    const svg = renderCanvasSvg(nodes, wires);
    expect(svg).toContain(">TASK<");
    expect(svg).not.toContain(">NOTE<");
    expect(svg).not.toContain(">REGION<");
  });

  it("draws the wire", () => {
    expect(renderCanvasSvg(nodes, wires)).toContain("<line");
  });

  it("paints in stacking order, regions behind everything", () => {
    const svg = renderCanvasSvg(nodes, wires);
    expect(svg.indexOf("INSTRUMENTS")).toBeLessThan(svg.indexOf(">prism<"));
    expect(svg.indexOf(">prism<")).toBeLessThan(svg.indexOf(">tower<"));
  });

  it("renders an agent messages wire as an amber collaboration link", () => {
    const svg = renderCanvasSvg(
      [
        seat("a1", { x: 0, y: 0, width: 120, height: 48, label: "Alpha" }),
        seat("a2", { x: 200, y: 0, width: 120, height: 48, label: "Beta" }),
      ],
      [wire("a2a", "a1", "a2", "messages")],
    );
    expect(svg).toContain('stroke="#e8a33d"');
    expect(svg).toContain(">Alpha<");
  });

  it("escapes special characters in titles", () => {
    const svg = renderCanvasSvg([note("x", "a & b <c>", { x: 0, y: 0, width: 100, height: 40 })]);
    expect(svg).toContain("a &amp; b &lt;c&gt;");
    expect(svg).not.toContain("a & b <c>");
  });
});
