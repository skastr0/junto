/**
 * The renderer is a privilege boundary, not merely a location to load UI
 * assets from. Keep this module platform-neutral so both main and preload use
 * the same conservative URL grammar.
 */
export const TRUSTED_RENDERER_SCHEME = "vellum-app";
export const TRUSTED_RENDERER_HOST = "renderer";
export const TRUSTED_RENDERER_URL = `${TRUSTED_RENDERER_SCHEME}://${TRUSTED_RENDERER_HOST}/index.html`;

const LOOPBACK_DEV_HOSTS = new Set(["localhost", "127.0.0.1"]);

export interface TrustedRendererOrigin {
  readonly initialUrl: string;
  readonly allows: (candidate: string | undefined) => boolean;
}

const parse = (value: string | undefined): URL | undefined => {
  if (value === undefined || value.includes("\\")) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

const isFixedRendererUrl = (value: string | undefined): boolean => value === TRUSTED_RENDERER_URL;

const isLoopbackAuthority = (url: URL): boolean => {
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !LOOPBACK_DEV_HOSTS.has(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.port === ""
  ) return false;

  const port = Number(url.port);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
};

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

  // electron-vite sets ELECTRON_RENDERER_URL as `${protocol}//${host}:${port}`
  // with no trailing slash. URL() normalizes that to a root (`…/`); accept both
  // forms as long as the result is an exact loopback root with an explicit port.
  const initial = parse(configuredDevelopmentUrl);
  const suppliedRoot =
    configuredDevelopmentUrl !== undefined && !configuredDevelopmentUrl.endsWith("/")
      ? `${configuredDevelopmentUrl}/`
      : configuredDevelopmentUrl;
  if (
    initial === undefined ||
    initial.toString() !== suppliedRoot ||
    !isLoopbackAuthority(initial) ||
    initial.pathname !== "/" ||
    initial.search !== "" ||
    initial.hash !== ""
  ) {
    throw new Error(
      "ELECTRON_RENDERER_URL must be an exact http(s) localhost or 127.0.0.1 root URL with an explicit port",
    );
  }

  const protocol = initial.protocol;
  const hostname = initial.hostname;
  const port = initial.port;
  return {
    initialUrl: initial.toString(),
    allows: (candidate) => {
      const url = parse(candidate);
      return (
        url !== undefined &&
        isLoopbackAuthority(url) &&
        url.protocol === protocol &&
        url.hostname === hostname &&
        url.port === port
      );
    },
  };
};

/**
 * Preload has no main-process identity. This is only an early exposure guard;
 * main still requires the exact WebContents identity minted after load.
 */
export const isRendererPreloadCandidate = (candidate: string | undefined): boolean => {
  if (isFixedRendererUrl(candidate)) return true;
  const url = parse(candidate);
  return url !== undefined && isLoopbackAuthority(url);
};
