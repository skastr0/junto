// A short host label for pages, with a scheme-strip fallback for malformed URLs.
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
};

/** An address as its host and the last step of its path: "effect.website/…/docs". */
export const hostAndTail = (url: string): string => {
  try {
    const parsed = new URL(url);
    const steps = parsed.pathname.split("/").filter(Boolean);
    if (steps.length === 0) return parsed.host;
    return steps.length === 1 ? `${parsed.host}/${steps[0]}` : `${parsed.host}/…/${steps.at(-1)}`;
  } catch {
    return url;
  }
};

/** The folders a path sits in, the nearest last: what a file leaf line names, its start giving way. */
export const pathTail = (path: string): string => {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : path;
};
