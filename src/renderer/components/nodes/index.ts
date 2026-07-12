import type { NodeTypes } from "@xyflow/react";
import { TextNode } from "./TextNode";
import { FileNode } from "./FileNode";
import { LinkNode } from "./LinkNode";
import { GroupNode } from "./GroupNode";

// Stable module-level map — RF warns if nodeTypes is recreated per render.
export const nodeTypes: NodeTypes = {
  text: TextNode,
  file: FileNode,
  link: LinkNode,
  group: GroupNode,
};
