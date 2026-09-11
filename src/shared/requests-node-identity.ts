import type { CanvasNode } from "./canvas";

/**
 * One Requests-node identity projection for every product surface. The node
 * text is a mechanical mirror (identity + pending count + briefs, rewritten on
 * every work op), so display never reads it: the authored `ether.requests.name`
 * is the only identity, and the kind name is the fallback.
 */
const GENERIC_REQUESTS_NAMES = new Set(["request", "requests"]);

const normalizeName = (value: string | undefined): string | undefined => {
  const name = value?.replace(/\s+/g, " ").trim();
  return name ? name : undefined;
};

/**
 * Stable display name for a requests sink. Unnamed nodes read as the kind
 * ("requests") — identity is stable across work ops and restarts; activity
 * lives in the glance count chip, never in the title.
 */
export const requestsNodeName = (node: CanvasNode | undefined): string => {
  const name = normalizeName(node?.ether?.requests?.name);
  if (name && !GENERIC_REQUESTS_NAMES.has(name.toLowerCase())) return name;
  return "requests";
};
