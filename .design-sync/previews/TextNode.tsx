import { CanvasStage, TextNode } from "@skastr0/vellum";

const textNode = (
  id: string,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  selected = false,
) => ({
  id,
  type: "text",
  position: { x, y },
  width,
  height,
  selected,
  data: {
    node: { id, type: "text", text, x, y, width, height },
    blocked: false,
  },
});

const nodeTypes = { text: TextNode };

export const FreeNote = () => (
  <CanvasStage
    height={300}
    nodeTypes={nodeTypes}
    nodes={[
      textNode(
        "n1",
        "Stage the release build on the workshop mini, then let the fleet soak it overnight before promoting.",
        0,
        0,
        280,
        140,
      ),
    ]}
  />
);

export const Selected = () => (
  <CanvasStage
    height={300}
    nodeTypes={nodeTypes}
    nodes={[
      textNode("n1", "Blocked: waiting on the license server fix.", 0, 0, 240, 110, true),
    ]}
  />
);

export const TwoNotes = () => (
  <CanvasStage
    height={340}
    nodeTypes={nodeTypes}
    nodes={[
      textNode("n1", "Canvas is the source of truth — the board only projects it.", 0, 0, 250, 120),
      textNode("n2", "Ship notes → digest every morning.", 310, 60, 210, 100),
    ]}
  />
);
