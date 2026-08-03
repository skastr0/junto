import { CanvasStage, FileNode } from "@skastr0/vellum";

const nodeTypes = { file: FileNode };

const fileNode = (
  id: string,
  file: string,
  x: number,
  y: number,
  width: number,
  height: number,
  opts: { readonly subpath?: string; readonly selected?: boolean; readonly blocked?: boolean } = {},
) => ({
  id,
  type: "file",
  position: { x, y },
  width,
  height,
  selected: opts.selected ?? false,
  data: {
    node: {
      id,
      type: "file" as const,
      file,
      subpath: opts.subpath,
      x,
      y,
      width,
      height,
    },
    blocked: opts.blocked ?? false,
  },
});

export const Default = () => (
  <CanvasStage
    height={260}
    nodeTypes={nodeTypes}
    nodes={[fileNode("n1", "docs/factory-physics-map.md", 0, 0, 220, 96)]}
  />
);

export const WithSubpath = () => (
  <CanvasStage
    height={260}
    nodeTypes={nodeTypes}
    nodes={[
      fileNode("n1", "canvases/workshop.canvas", 0, 0, 220, 112, {
        subpath: "nodes/agent-claude-1",
      }),
    ]}
  />
);

export const Selected = () => (
  <CanvasStage
    height={260}
    nodeTypes={nodeTypes}
    nodes={[fileNode("n1", "src/shared/canvas.ts", 0, 0, 220, 96, { selected: true })]}
  />
);
