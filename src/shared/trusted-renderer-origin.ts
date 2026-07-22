/**
 * The renderer is a privilege boundary, not merely a location to load UI
 * assets from. Keep this module platform-neutral so both main and preload use
 * the same conservative URL grammar.
 */
export const TRUSTED_RENDERER_SCHEME = "vellum-app";
export const TRUSTED_RENDERER_HOST = "renderer";
export const TRUSTED_RENDERER_URL = `${TRUSTED_RENDERER_SCHEME}://${TRUSTED_RENDERER_HOST}/index.html`;

// electron-vite's normal development endpoint. The environment may repeat
// this value for its own launch contract, but it never gets to choose a new
// privileged origin or port.
const CANONICAL_DEVELOPMENT_RENDERER_URLS = new Set([
  "http://localhost:5173/",
  "https://localhost:5173/",
]);
const DEFAULT_DEVELOPMENT_RENDERER_URL = "http://localhost:5173/";

export interface TrustedRendererOrigin {
  readonly initialUrl: string;
  readonly allows: (candidate: string | undefined) => boolean;
}

const isFixedRendererUrl = (value: string | undefined): boolean => value === TRUSTED_RENDERER_URL;

const isCanonicalDevelopmentRendererUrl = (value: string | undefined): boolean =>
  value !== undefined && CANONICAL_DEVELOPMENT_RENDERER_URLS.has(value);

/** Parse the sole renderer authority before a BrowserWindow is created. */
export const resolveTrustedRendererOrigin = (
  isPackaged: boolean,
  configuredDevelopmentUrl?: string,
): TrustedRendererOrigin => {
  if (isPackaged) {
    return {
      initialUrl: TRUSTED_RENDERER_URL,
      allows: isFixedRendererUrl,
    };
  }

  const initialUrl = configuredDevelopmentUrl ?? DEFAULT_DEVELOPMENT_RENDERER_URL;
  if (!isCanonicalDevelopmentRendererUrl(initialUrl)) {
    throw new Error(
      "ELECTRON_RENDERER_URL must equal a fixed canonical localhost development authority",
    );
  }
  return {
    initialUrl,
    allows: (candidate) => candidate === initialUrl,
  };
};

/**
 * Preload has no main-process identity. This is only an early exposure guard;
 * main still requires the exact WebContents identity minted after load.
 */
export const isRendererPreloadCandidate = (candidate: string | undefined): boolean => {
  if (isFixedRendererUrl(candidate)) return true;
  return isCanonicalDevelopmentRendererUrl(candidate);
};
