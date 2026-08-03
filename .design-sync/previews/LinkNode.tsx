import { CanvasStage, LinkNode } from "@skastr0/vellum";

// The `isPage` upgrade path (ether.entity.kind "page" + ether.browser) mounts
// browser/PageCard, which is excluded scope (deep app coupling — see
// .design-sync/NOTES.md). This preview stays on the plain-link branch only.

const nodeTypes = { link: LinkNode };

const linkNode = (
  id: string,
  url: string,
  x: number,
  y: number,
  width: number,
  height: number,
  opts: { readonly selected?: boolean; readonly blocked?: boolean } = {},
) => ({
  id,
  type: "link",
  position: { x, y },
  width,
  height,
  selected: opts.selected ?? false,
  data: {
    node: { id, type: "link" as const, url, x, y, width, height },
    blocked: opts.blocked ?? false,
  },
});

export const Default = () => (
  <CanvasStage
    height={260}
    nodeTypes={nodeTypes}
    nodes={[linkNode("n1", "https://vellum.command/releases", 0, 0, 220, 96)]}
  />
);

export const DeepPath = () => (
  <CanvasStage
    height={260}
    nodeTypes={nodeTypes}
    nodes={[linkNode("n1", "https://github.com/skastr0/vellum/pull/482/files", 0, 0, 220, 96)]}
  />
);

export const Selected = () => (
  <CanvasStage
    height={260}
    nodeTypes={nodeTypes}
    nodes={[
      linkNode("n1", "https://status.vellum.command/remote-a", 0, 0, 220, 96, {
        selected: true,
      }),
    ]}
  />
);
