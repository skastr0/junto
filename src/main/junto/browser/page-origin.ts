/**
 * What a page target's url is allowed to be, and the guard that holds a guest
 * to the origin its target named. Pure: no session, no Electron value, so the
 * core's overseer page plane can take the guard without the session service.
 */
import { BROWSER_MAX_URL_BYTES, isUtf8WithinLimit } from "@shared/browser-limits";

/** A page's top-level navigation is admitted only within its target's origin. */
export type BrowserGuestTopLevelGuard = (url: string) => boolean;

/** An exact http(s) url within the byte limit, or undefined for anything else. */
export const exactBrowserUrl = (url: string): string | undefined => {
  if (!isUtf8WithinLimit(url, BROWSER_MAX_URL_BYTES)) return undefined;
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
};

/** The origin of an exact browser url, or undefined when the url is not one. */
export const exactBrowserOrigin = (url: string): string | undefined => {
  const exactUrl = exactBrowserUrl(url);
  return exactUrl === undefined ? undefined : new URL(exactUrl).origin;
};

/** A guest may only take itself to the origin its page target named. */
export const pageOriginGuard = (pageUrl: string): BrowserGuestTopLevelGuard => {
  const origin = exactBrowserOrigin(pageUrl);
  return (url) => origin !== undefined && exactBrowserOrigin(url) === origin;
};
