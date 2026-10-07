import { memo } from "react";
import type { NodeTypes } from "@xyflow/react";
import { sameCard } from "../../lib/flow-identity";
import { TextNode } from "./TextNode";
import { FileNode } from "./FileNode";
import { LinkNode } from "./LinkNode";
import { GroupNode } from "./GroupNode";

// Stable module-level map — RF warns if nodeTypes is recreated per render.
// Each card is remembered against its own id, selection and facts: React Flow
// renders a node's wrapper whenever it moves, measures or re-adopts the node,
// and none of that reaches a card, which reads its node from the store.
export const nodeTypes: NodeTypes = {
  text: memo(TextNode, sameCard),
  file: memo(FileNode, sameCard),
  link: memo(LinkNode, sameCard),
  group: memo(GroupNode, sameCard),
};
