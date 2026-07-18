import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { BrowserWindow, Protocol, Session, WebContents } from "electron";

export const TRUSTED_RENDERER_SCHEME = "vellum-app";
export const TRUSTED_RENDERER_HOST = "renderer";
export const TRUSTED_RENDERER_URL = `${TRUSTED_RENDERER_SCHEME}://${TRUSTED_RENDERER_HOST}/index.html`;

const MIME_TYPES = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const ENCODED_SEPARATOR = /%(?:2f|5c)/iu;
const RECURSIVE_ENCODING = /%[0-9a-f]{2}/iu;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:/iu;

const fixedHeaders = (contentType: string, contentLength: number): Headers =>
  new Headers({
    "Cache-Control": "no-store",
    "Content-Length": String(contentLength),
    "Content-Type": contentType,
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });

const fixedError = (status: number, method: string): Response => {
  const contents = new TextEncoder().encode("request rejected\n");
  return new Response(method === "HEAD" ? null : contents, {
    status,
    headers: fixedHeaders("text/plain; charset=utf-8", contents.byteLength),
  });
};

const isDescendant = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot.length > 0 &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
};

const requestPath = (requestUrl: string): string | undefined => {
  if (requestUrl.includes("\\")) return undefined;

  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }

  if (
    url.protocol !== `${TRUSTED_RENDERER_SCHEME}:` ||
    url.hostname !== TRUSTED_RENDERER_HOST ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    ENCODED_SEPARATOR.test(url.pathname)
  ) {
    return undefined;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }

  if (decodedPath === "/") decodedPath = "/index.html";
  if (
    !decodedPath.startsWith("/") ||
    decodedPath.includes("\\") ||
    decodedPath.includes("//") ||
    CONTROL_CHARACTER.test(decodedPath) ||
    RECURSIVE_ENCODING.test(decodedPath)
  ) {
    return undefined;
  }

  const segments = decodedPath.slice(1).split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return undefined;
  }

  const relativePath = segments.join("/");
  if (isAbsolute(relativePath) || WINDOWS_ABSOLUTE_PATH.test(relativePath)) {
    return undefined;
  }
  return relativePath;
};

export const registerTrustedRendererScheme = (registry: Protocol): void => {
  registry.registerSchemesAsPrivileged([
    {
      scheme: TRUSTED_RENDERER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: false,
        allowServiceWorkers: false,
        corsEnabled: false,
        stream: false,
        codeCache: false,
        allowExtensions: false,
      },
    },
  ]);
};

export const createTrustedRendererHandler = async (
  rendererRoot: string,
): Promise<(request: Request) => Promise<Response>> => {
  const canonicalRoot = await realpath(rendererRoot);
  const rootInfo = await lstat(canonicalRoot);
  if (!rootInfo.isDirectory()) throw new Error("trusted renderer root is not a directory");

  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return fixedError(405, request.method);
    }

    const relativePath = requestPath(request.url);
    if (relativePath === undefined) return fixedError(400, request.method);

    const mimeType = MIME_TYPES.get(extname(relativePath).toLowerCase());
    if (mimeType === undefined) return fixedError(415, request.method);

    const lexicalPath = resolve(canonicalRoot, relativePath);
    if (!isDescendant(canonicalRoot, lexicalPath)) {
      return fixedError(403, request.method);
    }

    try {
      const canonicalFile = await realpath(lexicalPath);
      if (!isDescendant(canonicalRoot, canonicalFile)) {
        return fixedError(403, request.method);
      }
      const fileInfo = await lstat(canonicalFile);
      if (!fileInfo.isFile()) return fixedError(404, request.method);

      const contents = await readFile(canonicalFile);
      const body = new Uint8Array(contents);
      return new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers: fixedHeaders(mimeType, body.byteLength),
      });
    } catch {
      return fixedError(404, request.method);
    }
  };
};

export const installTrustedRendererProtocol = async (
  target: Protocol,
  rendererRoot: string,
): Promise<void> => {
  if (target.isProtocolHandled(TRUSTED_RENDERER_SCHEME)) {
    throw new Error("trusted renderer protocol already has a handler");
  }
  const handler = await createTrustedRendererHandler(rendererRoot);
  target.handle(TRUSTED_RENDERER_SCHEME, handler);
  if (!target.isProtocolHandled(TRUSTED_RENDERER_SCHEME)) {
    throw new Error("trusted renderer protocol handler was not installed");
  }
};

const sameAuthority = (candidate: string | undefined, allowed: string): boolean => {
  if (candidate === undefined || candidate.includes("\\")) return false;
  try {
    const actual = new URL(candidate);
    const expected = new URL(allowed);
    return (
      actual.protocol === expected.protocol &&
      actual.hostname === expected.hostname &&
      actual.port === expected.port &&
      actual.username === "" &&
      actual.password === ""
    );
  } catch {
    return false;
  }
};

const trustedClipboardRequest = (
  webContents: WebContents | null,
  permission: string,
  requestingUrl: string | undefined,
  isMainFrame: boolean,
  getTrustedWindow: () => BrowserWindow | undefined,
  developmentRendererUrl: string | undefined,
): boolean => {
  const mainWindow = getTrustedWindow();
  return (
    permission === "clipboard-sanitized-write" &&
    webContents !== null &&
    mainWindow !== undefined &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed() &&
    webContents === mainWindow.webContents &&
    isMainFrame &&
    (sameAuthority(requestingUrl, TRUSTED_RENDERER_URL) ||
      (developmentRendererUrl !== undefined &&
        sameAuthority(requestingUrl, developmentRendererUrl)))
  );
};

export const installTrustedRendererPermissionPolicy = (
  target: Session,
  getTrustedWindow: () => BrowserWindow | undefined,
  developmentRendererUrl?: string,
): void => {
  target.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      trustedClipboardRequest(
        webContents,
        permission,
        details.requestingUrl ?? requestingOrigin,
        details.isMainFrame,
        getTrustedWindow,
        developmentRendererUrl,
      ),
  );
  target.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      trustedClipboardRequest(
        webContents,
        permission,
        details.requestingUrl,
        details.isMainFrame,
        getTrustedWindow,
        developmentRendererUrl,
      ),
    );
  });
};
