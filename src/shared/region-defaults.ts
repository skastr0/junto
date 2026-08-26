// Pure region spawn-default resolution. Create-time stamp source only —
// never a live binding parent. Geometry membership matches the product law:
// a point is inside a region if it lies within the region's axis-aligned rect;
// when regions nest, the smallest-area (innermost) region wins.
// Defaults bags are bag-atomic per kind: the innermost region that defines
// `defaults.page` supplies the whole bag — no field merge.
// Paths are host-keyed: innermost region with a non-empty path for that host.

import type {
  CanvasDoc,
  CanvasNode,
  EtherRegionDefaults,
  EtherRegionPageDefaults,
  EtherRegionPaths,
  GroupNode,
} from "./canvas";

const isGroupNode = (node: CanvasNode): node is GroupNode => node.type === "group";

/** True when (x, y) lies inside the group's rectangle (inclusive edges). */
export const pointInGroup = (group: GroupNode, x: number, y: number): boolean =>
  x >= group.x &&
  x <= group.x + group.width &&
  y >= group.y &&
  y <= group.y + group.height;

/** All group nodes whose rect contains the point, document order. */
export const groupsContainingPoint = (
  doc: CanvasDoc,
  x: number,
  y: number,
): ReadonlyArray<GroupNode> => doc.nodes.filter(isGroupNode).filter((g) => pointInGroup(g, x, y));

const area = (g: GroupNode): number => g.width * g.height;

/**
 * Innermost (smallest-area) group containing the point that satisfies `pred`.
 * Ties break by document order (first wins only if areas equal — rare).
 */
export const findInnermostGroup = (
  doc: CanvasDoc,
  x: number,
  y: number,
  pred: (group: GroupNode) => boolean,
): GroupNode | undefined => {
  let best: GroupNode | undefined;
  for (const group of groupsContainingPoint(doc, x, y)) {
    if (!pred(group)) continue;
    if (!best || area(group) < area(best)) best = group;
  }
  return best;
};

/** Innermost containing region, regardless of defaults. */
export const findContainingRegion = (
  doc: CanvasDoc,
  x: number,
  y: number,
): GroupNode | undefined => findInnermostGroup(doc, x, y, () => true);

/** True when the region bag has a non-empty page url, profile, or host. */
const regionHasPageSpawnFields = (group: GroupNode): boolean => {
  const page = group.ether?.region?.defaults?.page;
  if (!page) return false;
  const url = page.url?.trim() ?? "";
  const profile = page.profile?.trim() ?? "";
  const host = page.host?.trim() ?? "";
  return url.length > 0 || profile.length > 0 || host.length > 0;
};

/** True when the region bag has at least one non-empty host→path entry. */
const regionHasPaths = (group: GroupNode): boolean => {
  const paths = group.ether?.region?.defaults?.paths;
  if (!paths) return false;
  for (const [host, path] of Object.entries(paths)) {
    if (host.trim() && path.trim()) return true;
  }
  return false;
};

/** True when the region bag defines a non-empty path for the given host id. */
const regionHasPathForHost = (group: GroupNode, hostId: string): boolean => {
  const host = hostId.trim();
  if (!host) return false;
  const path = group.ether?.region?.defaults?.paths?.[host]?.trim() ?? "";
  return path.length > 0;
};

/**
 * Bag-atomic page spawn defaults from the innermost region that defines them.
 * Returns undefined when url, profile, and host are all unset on every containing bag.
 */
export const resolvePageSpawnDefaults = (
  doc: CanvasDoc,
  x: number,
  y: number,
): EtherRegionPageDefaults | undefined => {
  const region = findInnermostGroup(doc, x, y, regionHasPageSpawnFields);
  const page = region?.ether?.region?.defaults?.page;
  if (!page) return undefined;
  const url = page.url?.trim();
  const profile = page.profile?.trim();
  const host = page.host?.trim();
  if (!url && !profile && !host) return undefined;
  return {
    ...(url ? { url } : {}),
    ...(profile ? { profile } : {}),
    ...(host ? { host } : {}),
  };
};

/**
 * Host-keyed actor cwd from the innermost containing region that defines a
 * path for `hostId`. Walks outward when an inner region has paths for other
 * hosts only. Create-time stamp for agent/terminal launch.cwd.
 */
export const resolveRegionCwd = (
  doc: CanvasDoc,
  x: number,
  y: number,
  hostId: string,
): string | undefined => {
  const host = hostId.trim();
  if (!host) return undefined;
  const region = findInnermostGroup(doc, x, y, (g) => regionHasPathForHost(g, host));
  const path = region?.ether?.region?.defaults?.paths?.[host]?.trim();
  return path || undefined;
};

/** Collapse blank host/path entries. Returns undefined when nothing remains. */
export const stripEmptyRegionPaths = (
  paths: EtherRegionPaths | undefined,
): EtherRegionPaths | undefined => {
  if (!paths) return undefined;
  const next: Record<string, string> = {};
  for (const [rawHost, rawPath] of Object.entries(paths)) {
    const host = rawHost.trim();
    const path = rawPath.trim();
    if (!host || !path) continue;
    next[host] = path;
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

/** Full defaults bag on the innermost region that has a non-empty defaults bag. */
export const resolveRegionDefaults = (
  doc: CanvasDoc,
  x: number,
  y: number,
): EtherRegionDefaults | undefined => {
  const region = findInnermostGroup(doc, x, y, (g) => {
    const d = g.ether?.region?.defaults;
    if (!d) return false;
    return regionHasPageSpawnFields(g) || regionHasPaths(g);
  });
  return stripEmptyRegionDefaults(region?.ether?.region?.defaults);
};

/** Collapse empty strings / empty nested bags so the document stays sparse. */
export const stripEmptyRegionDefaults = (
  defaults: EtherRegionDefaults | undefined,
): EtherRegionDefaults | undefined => {
  if (!defaults) return undefined;
  const pageUrl = defaults.page?.url?.trim();
  const pageProfile = defaults.page?.profile?.trim();
  const pageHost = defaults.page?.host?.trim();
  let page: EtherRegionPageDefaults | undefined;
  if (pageUrl || pageProfile || pageHost) {
    page = {
      ...(pageUrl ? { url: pageUrl } : {}),
      ...(pageProfile ? { profile: pageProfile } : {}),
      ...(pageHost ? { host: pageHost } : {}),
    };
  }
  const paths = stripEmptyRegionPaths(defaults.paths);
  if (!page && !paths) return undefined;
  return {
    ...(page ? { page } : {}),
    ...(paths ? { paths } : {}),
  };
};
