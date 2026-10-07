// Pure region spawn-default resolution. Create-time stamp source only —
// never a live binding parent. Geometry membership matches the product law:
// a point is inside a region if it lies within the region's axis-aligned rect;
// when regions nest, the smallest-area (innermost) region wins.
// Defaults bags are bag-atomic per kind: the innermost region that defines
// `defaults.page` supplies the whole bag — no field merge.
// Paths are host-keyed: innermost region with a non-empty path for that host.

import type { Canvas, Region, RegionDefaults, RegionPageDefaults } from "./model";
type RegionPaths = Readonly<Record<string, string>>;
import { regionStack } from "./model/canvas";

/** Regions containing a creation point, using the shared rectangle rule. */
export const groupsContainingPoint = (canvas: Canvas | undefined, x: number, y: number): ReadonlyArray<Region> =>
  canvas ? regionStack(canvas, { x, y, width: 0, height: 0 }) : [];

export const findInnermostGroup = (canvas: Canvas | undefined, x: number, y: number, pred: (region: Region) => boolean): Region | undefined =>
  groupsContainingPoint(canvas, x, y).filter(pred).at(-1);

/** Innermost containing region, regardless of defaults. */
export const findContainingRegion = (
  doc: Canvas | undefined,
  x: number,
  y: number,
): Region | undefined => findInnermostGroup(doc, x, y, () => true);

/** True when the region bag has a non-empty page url, profile, or host. */
const regionHasPageSpawnFields = (group: Region): boolean => {
  const page = group.defaults?.page;
  if (!page) return false;
  const url = page.url?.trim() ?? "";
  const profile = page.profile?.trim() ?? "";
  const host = page.host?.trim() ?? "";
  return url.length > 0 || profile.length > 0 || host.length > 0;
};

/** True when the region bag has at least one non-empty host→path entry. */
const regionHasPaths = (group: Region): boolean => {
  const paths = group.defaults?.paths;
  if (!paths) return false;
  for (const [host, path] of Object.entries(paths)) {
    if (host.trim() && path.trim()) return true;
  }
  return false;
};

/** True when the region bag defines a non-empty path for the given host id. */
const regionHasPathForHost = (group: Region, hostId: string): boolean => {
  const host = hostId.trim();
  if (!host) return false;
  const path = group.defaults?.paths?.[host]?.trim() ?? "";
  return path.length > 0;
};

/**
 * Bag-atomic page spawn defaults from the innermost region that defines them.
 * Returns undefined when url, profile, and host are all unset on every containing bag.
 */
export const resolvePageSpawnDefaults = (
  doc: Canvas | undefined,
  x: number,
  y: number,
): RegionPageDefaults | undefined => {
  const region = findInnermostGroup(doc, x, y, regionHasPageSpawnFields);
  const page = region?.defaults?.page;
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
  doc: Canvas | undefined,
  x: number,
  y: number,
  hostId: string,
): string | undefined => {
  const host = hostId.trim();
  if (!host) return undefined;
  const region = findInnermostGroup(doc, x, y, (g) => regionHasPathForHost(g, host));
  const path = region?.defaults?.paths?.[host]?.trim();
  return path || undefined;
};

/** Collapse blank host/path entries. Returns undefined when nothing remains. */
export const stripEmptyRegionPaths = (
  paths: RegionPaths | undefined,
): RegionPaths | undefined => {
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
  doc: Canvas | undefined,
  x: number,
  y: number,
): RegionDefaults | undefined => {
  const region = findInnermostGroup(doc, x, y, (g) => {
    const d = g.defaults;
    if (!d) return false;
    return regionHasPageSpawnFields(g) || regionHasPaths(g);
  });
  return stripEmptyRegionDefaults(region?.defaults);
};

/** Collapse empty strings / empty nested bags so the model stays sparse. */
export const stripEmptyRegionDefaults = (
  defaults: RegionDefaults | undefined,
): RegionDefaults | undefined => {
  if (!defaults) return undefined;
  const pageUrl = defaults.page?.url?.trim();
  const pageProfile = defaults.page?.profile?.trim();
  const pageHost = defaults.page?.host?.trim();
  let page: RegionPageDefaults | undefined;
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
