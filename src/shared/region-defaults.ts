// Pure region spawn-default resolution. Create-time stamp source only —
// never a live binding parent. Geometry membership matches the product law:
// a point is inside a region if it lies within the region's axis-aligned rect;
// when regions nest, the smallest-area (innermost) region wins.
// Defaults bags are bag-atomic per kind: the innermost region that defines
// `defaults.herdr` (or `defaults.page`) supplies the whole bag — no field merge.

import type {
  CanvasDoc,
  CanvasNode,
  EtherRegionDefaults,
  EtherRegionHerdrDefaults,
  EtherRegionPageDefaults,
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

/** True when the region bag has a non-empty herdr host string. */
const regionHasHerdrHost = (group: GroupNode): boolean => {
  const host = group.ether?.region?.defaults?.herdr?.host;
  return typeof host === "string" && host.trim().length > 0;
};

/** True when the region bag has a non-empty page url, profile, or host. */
const regionHasPageSpawnFields = (group: GroupNode): boolean => {
  const page = group.ether?.region?.defaults?.page;
  if (!page) return false;
  const url = page.url?.trim() ?? "";
  const profile = page.profile?.trim() ?? "";
  const host = page.host?.trim() ?? "";
  return url.length > 0 || profile.length > 0 || host.length > 0;
};

/**
 * Bag-atomic herdr spawn defaults from the innermost region that defines them.
 * Returns undefined when no containing region has a herdr defaults bag.
 * Does not invent hosts/workspaces; callers fail-loud at bind time.
 */
export const resolveHerdrSpawnDefaults = (
  doc: CanvasDoc,
  x: number,
  y: number,
): EtherRegionHerdrDefaults | undefined => {
  const region = findInnermostGroup(doc, x, y, regionHasHerdrHost);
  const herdr = region?.ether?.region?.defaults?.herdr;
  if (!herdr?.host?.trim()) return undefined;
  const host = herdr.host.trim();
  const workspaceId = herdr.workspaceId?.trim();
  const tabId = herdr.tabId?.trim();
  return {
    host,
    // Preserve explicit null (default unnamed session) vs absent.
    ...(herdr.session !== undefined ? { session: herdr.session } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(tabId ? { tabId } : {}),
  };
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

/** Full defaults bag on the innermost region that has a non-empty defaults bag. */
export const resolveRegionDefaults = (
  doc: CanvasDoc,
  x: number,
  y: number,
): EtherRegionDefaults | undefined => {
  const region = findInnermostGroup(doc, x, y, (g) => {
    const d = g.ether?.region?.defaults;
    if (!d) return false;
    return regionHasHerdrHost(g) || regionHasPageSpawnFields(g);
  });
  return stripEmptyRegionDefaults(region?.ether?.region?.defaults);
};

/** Collapse empty strings / empty nested bags so the document stays sparse. */
export const stripEmptyRegionDefaults = (
  defaults: EtherRegionDefaults | undefined,
): EtherRegionDefaults | undefined => {
  if (!defaults) return undefined;
  const herdrHost = defaults.herdr?.host?.trim();
  const herdrWorkspace = defaults.herdr?.workspaceId?.trim();
  const herdrTab = defaults.herdr?.tabId?.trim();
  let herdr: EtherRegionHerdrDefaults | undefined;
  if (herdrHost) {
    herdr = {
      host: herdrHost,
      ...(defaults.herdr?.session !== undefined ? { session: defaults.herdr.session } : {}),
      ...(herdrWorkspace ? { workspaceId: herdrWorkspace } : {}),
      ...(herdrTab ? { tabId: herdrTab } : {}),
    };
  }
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
  if (!herdr && !page) return undefined;
  return {
    ...(herdr ? { herdr } : {}),
    ...(page ? { page } : {}),
  };
};
