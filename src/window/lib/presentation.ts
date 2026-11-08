// A short host label for pages, with a scheme-strip fallback for malformed URLs.
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
};
