import { CanvasStage, GroupNode, TextNode } from "@skastr0/vellum";

// Region membership is always derived from geometry at interaction time
// (never stored), so "members" here are just ordinary text nodes positioned
// inside the region's rectangle — exactly how the real canvas composes it.

const nodeTypes = { group: GroupNode, text: TextNode };

const groupNode = (
  id: string,
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
  opts: {
    readonly selected?: boolean;
    readonly color?: string;
    readonly ether?: Record<string, unknown>;
  } = {},
) => ({
  id,
  type: "group",
  position: { x, y },
  width,
  height,
  zIndex: 0,
  selected: opts.selected ?? false,
  data: {
    node: {
      id,
      type: "group" as const,
      label,
      color: opts.color,
      x,
      y,
      width,
      height,
      ether: opts.ether,
    },
    blocked: false,
  },
});

const textNode = (
  id: string,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
) => ({
  id,
  type: "text",
  position: { x, y },
  width,
  height,
  zIndex: 2,
  data: {
    node: { id, type: "text" as const, text, x, y, width, height },
    blocked: false,
  },
});

export const Default = () => (
  <CanvasStage
    height={300}
    nodeTypes={nodeTypes}
    nodes={[groupNode("g1", "workshop staging", 0, 0, 360, 200)]}
  />
);

export const Selected = () => (
  <CanvasStage
    height={340}
    nodeTypes={nodeTypes}
    nodes={[
      groupNode("g1", "release gate", 0, 0, 380, 220, {
        selected: true,
        ether: {
          region: {
            hold: true,
            instruction: "Pulse every agent inside when the release gate opens.",
            defaults: { paths: { "remote-a": "~/Projects/vellum" } },
          },
        },
      }),
    ]}
  />
);

export const WithMembers = () => (
  <CanvasStage
    height={340}
    nodeTypes={nodeTypes}
    nodes={[
      groupNode("g1", "fleet — remote-a", 0, 0, 420, 260, { color: "6" }),
      textNode(
        "t1",
        "Nightly sync runs at 02:00 — do not schedule builds inside this window.",
        30,
        50,
        220,
        90,
      ),
      textNode("t2", "3 agents seated", 30, 160, 160, 60),
    ]}
  />
);
