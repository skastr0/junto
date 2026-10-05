import type { CanvasDoc } from "@shared/canvas";
import { regionDisplayName, regionStack } from "@shared/graph";

/**
 * A node's region path as the operator reads it, outermost to innermost
 * ("Junto / PTY / mail"), from the one membership predicate (regionStack).
 * Every containing region appears, an unnamed one by its placeholder. A node
 * inside no region has no path.
 */
export const regionPath = (doc: CanvasDoc, nodeId: string): string | undefined => {
  const stack = regionStack(doc, nodeId);
  return stack.length > 0 ? stack.map(regionDisplayName).join(" / ") : undefined;
};

/** Every node's region path; nodes inside no region have no entry. Build once per doc revision. */
export const regionPaths = (doc: CanvasDoc): ReadonlyMap<string, string> => {
  const paths = new Map<string, string>();
  for (const node of doc.nodes) {
    const path = regionPath(doc, node.id);
    if (path !== undefined) paths.set(node.id, path);
  }
  return paths;
};
