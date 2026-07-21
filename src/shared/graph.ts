import type { CanvasDoc, CanvasNode, GroupNode } from "./canvas";
import { deriveExecutionGraph, type GlyphView } from "./execution-graph";

// Derived state. Never persisted — recomputed from the document so the
// .canvas file cannot go incoherent.
//
// blockedClosure / blockedEdgeIds are thin wrappers over deriveExecutionGraph.
// Callers with a live GlyphView should prefer deriveExecutionGraph directly
// so glyph-bound criteria can resolve; without a view, criteria edges that
// need tower data stay non-generating (relates); tasks/requests criteria
// still evaluate from the document alone.

export const blockedClosure = (
  doc: CanvasDoc,
  glyphs?: GlyphView,
): ReadonlySet<string> => deriveExecutionGraph(doc, glyphs ?? new Map()).blocked;

export const blockedEdgeIds = (
  doc: CanvasDoc,
  glyphs?: GlyphView,
): ReadonlySet<string> => deriveExecutionGraph(doc, glyphs ?? new Map()).blockedEdgeIds;

export const isGroup = (node: CanvasNode): node is GroupNode => node.type === "group";

const containsCenter = (group: GroupNode, node: CanvasNode): boolean => {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  return (
    cx >= group.x && cx <= group.x + group.width && cy >= group.y && cy <= group.y + group.height
  );
};

// Named geography: membership is containment of the node's center inside the
// group rect. Groups never contain groups (flat, POC rule).
export const groupMembers = (doc: CanvasDoc): ReadonlyMap<string, ReadonlyArray<string>> => {
  const groups = doc.nodes.filter(isGroup);
  const members = new Map<string, string[]>();
  for (const group of groups) {
    members.set(
      group.id,
      doc.nodes
        .filter((node) => node.id !== group.id && !isGroup(node) && containsCenter(group, node))
        .map((node) => node.id),
    );
  }
  return members;
};
