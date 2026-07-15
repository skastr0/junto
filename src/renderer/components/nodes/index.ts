import type { NodeTypes } from "@xyflow/react";
import { TextNode } from "./TextNode";
import { FileNode } from "./FileNode";
import { LinkNode } from "./LinkNode";
import { GroupNode } from "./GroupNode";
import { RegionCard } from "./lod/RegionCard";
import { TitleChip } from "./lod/TitleChip";
import { ClusterBubble } from "./lod/ClusterBubble";

// Stable module-level map — RF warns if nodeTypes is recreated per render. The
// `region-card` / `title-chip` / `cluster-bubble` types are the render-time
// LOD projection; only ever present when the viewport is zoomed out past a
// tier boundary, never in the document.
export const nodeTypes: NodeTypes = {
  text: TextNode,
  file: FileNode,
  link: LinkNode,
  group: GroupNode,
  "region-card": RegionCard as NodeTypes[string],
  "title-chip": TitleChip as NodeTypes[string],
  "cluster-bubble": ClusterBubble as NodeTypes[string],
};
