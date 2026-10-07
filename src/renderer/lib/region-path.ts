import type { CanvasDoc } from "@shared/canvas";
import { regionDisplayName, regionStack } from "@shared/graph";

/** One region on a node's path: its name, and its colour when it has one. */
export type RegionStep = { readonly id: string; readonly name: string; readonly color?: string };

/**
 * A node's containing regions, outermost to innermost, each with its own
 * colour, from the one membership predicate (regionStack). Empty for a node
 * inside no region.
 */
export const regionTrail = (doc: CanvasDoc, nodeId: string): ReadonlyArray<RegionStep> =>
  regionStack(doc, nodeId).map((group) => ({
    id: group.id,
    name: regionDisplayName(group),
    ...(group.color ? { color: group.color } : {}),
  }));

/** The trail as the operator reads it in one string ("Junto / PTY / mail"). */
export const trailPath = (trail: ReadonlyArray<RegionStep>): string => trail.map((step) => step.name).join(" / ");

/** Every node's region trail; nodes inside no region have no entry. Build once per doc revision. */
export const regionTrails = (doc: CanvasDoc): ReadonlyMap<string, ReadonlyArray<RegionStep>> => {
  const trails = new Map<string, ReadonlyArray<RegionStep>>();
  for (const node of doc.nodes) {
    const trail = regionTrail(doc, node.id);
    if (trail.length > 0) trails.set(node.id, trail);
  }
  return trails;
};

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
