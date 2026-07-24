import type { CanvasDoc, CanvasNode, GroupNode } from "./canvas";
import { deriveExecutionGraph, type GlyphView } from "./execution-graph";

// Derived state. Never persisted — recomputed from the document so the
// .canvas file cannot go incoherent.
//
// blockedClosure / blockedEdgeIds are thin wrappers over deriveExecutionGraph.
// Callers with a live GlyphView should prefer deriveExecutionGraph directly
// so glyph-bound criteria can resolve; without a view, criteria edges that
// need glyph data stay non-generating (relates); tasks/requests criteria
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

// The single membership predicate (I9): a node is a region member only when
// its FULL bounding rect lies inside the region's rect — a node partially
// overlapping a region is out. Promoted from the kernel's stricter rule
// (formerly duplicated center-point rules in kernel/cycle.ts and
// renderer/lib/geometry.ts); every membership consumer — kernel pulse
// delivery, region rollups, digest, a2a-work, and renderer displays — derives
// from this one function. Renderer keeps a separate, explicitly non-membership
// helper for drag-hold interaction (center-point, includes nested regions).
const isFullyContained = (group: GroupNode, node: CanvasNode): boolean =>
  node.x >= group.x &&
  node.y >= group.y &&
  node.x + node.width <= group.x + group.width &&
  node.y + node.height <= group.y + group.height;

// Named geography: membership is full-rect containment inside the group
// rect. Groups never contain groups (flat, POC rule).
export const groupMembers = (doc: CanvasDoc): ReadonlyMap<string, ReadonlyArray<string>> => {
  const groups = doc.nodes.filter(isGroup);
  const members = new Map<string, string[]>();
  for (const group of groups) {
    members.set(
      group.id,
      doc.nodes
        .filter((node) => node.id !== group.id && !isGroup(node) && isFullyContained(group, node))
        .map((node) => node.id),
    );
  }
  return members;
};
