import {
  asNodeId,
  frameContains,
  nodesOf,
  regionName,
  regionStack,
  type Placed,
} from "@shared/model";

/** One region on a node's path: its name, and its colour when it has one. */
export type RegionStep = { readonly id: string; readonly name: string; readonly color?: string };

/**
 * A node's containing regions, outermost to innermost, each with its own
 * colour, from the one membership predicate (regionStack). Empty for a node
 * inside no region.
 */
export const regionTrail = (canvas: Placed, nodeId: string): ReadonlyArray<RegionStep> =>
  regionStack(canvas, asNodeId(nodeId)).map((region) => ({
    id: region.id,
    name: regionName(region),
    ...(region.color ? { color: region.color } : {}),
  }));

/** The trail as the operator reads it in one string ("Junto / PTY / mail"). */
export const trailPath = (trail: ReadonlyArray<RegionStep>): string => trail.map((step) => step.name).join(" / ");

/**
 * A node's region path as the operator reads it, outermost to innermost
 * ("Junto / PTY / mail"), from the one membership predicate (regionStack).
 * Every containing region appears, an unnamed one by its placeholder. A node
 * inside no region has no path.
 */
export const regionPath = (canvas: Placed, nodeId: string): string | undefined => {
  const stack = regionStack(canvas, asNodeId(nodeId));
  return stack.length > 0 ? stack.map(regionName).join(" / ") : undefined;
};

/**
 * What a trail or a path is made of: each node's id and rectangle, and for a
 * region its label and colour. Two canvases with the same fingerprint derive
 * the same trails and paths, so the maps below can be kept across the Canvas
 * objects that wrap the same rows — every consumer used to rebuild them per
 * mount, and on a factory board that was the modal's open cost.
 */
const derivedKeyOf = (canvas: Placed): string => {
  const parts: string[] = [];
  for (const node of canvas.nodes.values()) {
    parts.push(
      node.kind === "region"
        ? `${node.id}:${node.x}:${node.y}:${node.width}:${node.height}:${node.label ?? ""}:${node.color ?? ""}`
        : `${node.id}:${node.x}:${node.y}:${node.width}:${node.height}`,
    );
  }
  return parts.join("|");
};

type Derived = {
  readonly trails: ReadonlyMap<string, ReadonlyArray<RegionStep>>;
  readonly paths: ReadonlyMap<string, string>;
};

// A few canvas versions is plenty: the open canvas's maps are hit by every
// consumer, and a switch back finds its entry still warm.
const DERIVED_CACHE_LIMIT = 8;
const derivedCache = new Map<string, Derived>();

/**
 * Every node's region trail and path in one pass. The regions sort once —
 * outermost first, the order regionStack gives each node — and each node's
 * stack is the sorted list filtered by containment, which is the same stack
 * regionStack returns. Nodes inside no region have no entry in either map.
 */
const derivedOf = (canvas: Placed): Derived => {
  const key = derivedKeyOf(canvas);
  const hit = derivedCache.get(key);
  if (hit !== undefined) {
    derivedCache.delete(key);
    derivedCache.set(key, hit);
    return hit;
  }
  const regions = nodesOf(canvas, "region")
    .slice()
    .sort((a, b) => b.width * b.height - a.width * a.height || a.id.localeCompare(b.id));
  const trails = new Map<string, ReadonlyArray<RegionStep>>();
  const paths = new Map<string, string>();
  for (const node of canvas.nodes.values()) {
    const stack = regions.filter((region) => region.id !== node.id && frameContains(region, node));
    if (stack.length === 0) continue;
    trails.set(
      node.id,
      stack.map((region) => ({
        id: region.id,
        name: regionName(region),
        ...(region.color ? { color: region.color } : {}),
      })),
    );
    paths.set(node.id, stack.map(regionName).join(" / "));
  }
  const derived: Derived = { trails, paths };
  derivedCache.set(key, derived);
  if (derivedCache.size > DERIVED_CACHE_LIMIT) {
    const oldest = derivedCache.keys().next().value;
    if (oldest !== undefined) derivedCache.delete(oldest);
  }
  return derived;
};

/** Every node's region trail; nodes inside no region have no entry. Build once per canvas change. */
export const regionTrails = (canvas: Placed): ReadonlyMap<string, ReadonlyArray<RegionStep>> =>
  derivedOf(canvas).trails;

/** Every node's region path; nodes inside no region have no entry. Build once per canvas change. */
export const regionPaths = (canvas: Placed): ReadonlyMap<string, string> => derivedOf(canvas).paths;
