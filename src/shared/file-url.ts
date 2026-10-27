import { parseFilePath, ROOT_PATH, type FilePath } from "./files";

/**
 * The bytes of a file under a Files node, for a viewer (PDF, image, media):
 * `junto-file://<nodeId>/<relpath>`, each segment percent-encoded. Main
 * serves it only for a node a window has opened (`files.open`), on this
 * machine, inside the root after `realpath`, with byte ranges
 * (`src/main/junto/files/protocol.ts`). The URL never carries the root.
 *
 * A standard scheme lower-cases its host, so main matches the node id
 * without case. `v` is an optional cache key (a stamp's mtime) a viewer adds
 * to reload after a change; main ignores its value.
 */
export const FILE_PROTOCOL_SCHEME = "junto-file" as const;

/** Node ids are `<kind>-<ulid>` (`model-factories.ts`); nothing else may stand in the host. */
const NODE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,255}$/u;

export const fileUrl = (node: string, path: FilePath, version?: number): string => {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const query = version === undefined ? "" : `?v=${encodeURIComponent(String(version))}`;
  return `${FILE_PROTOCOL_SCHEME}://${node.toLowerCase()}/${encoded}${query}`;
};

/** Node id (lower case) and relative path, or undefined for anything else. */
export const parseFileUrl = (
  url: string,
): { readonly node: string; readonly path: FilePath } | undefined => {
  if (url.includes("\\")) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${FILE_PROTOCOL_SCHEME}:`) return undefined;
  if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "" || parsed.hash !== "") return undefined;
  for (const key of parsed.searchParams.keys()) if (key !== "v") return undefined;
  const node = parsed.hostname.toLowerCase();
  if (!NODE_ID_RE.test(node)) return undefined;
  // URL parsing already collapsed any "." or ".." segment; a path that still
  // decodes to one (an encoded "%2e%2e") or to a "/" inside a segment fails parseFilePath.
  const raw = parsed.pathname.replace(/^\//u, "");
  if (raw === "") return undefined;
  let segments: string[];
  try {
    segments = raw.split("/").map(decodeURIComponent);
  } catch {
    return undefined;
  }
  if (segments.some((segment) => segment.includes("/"))) return undefined;
  const path = parseFilePath(segments.join("/"));
  return path === undefined || path === ROOT_PATH ? undefined : { node, path };
};

const MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["ico", "image/x-icon"],
  ["svg", "image/svg+xml"],
  ["mp3", "audio/mpeg"],
  ["m4a", "audio/mp4"],
  ["wav", "audio/wav"],
  ["ogg", "audio/ogg"],
  ["flac", "audio/flac"],
  ["mp4", "video/mp4"],
  ["m4v", "video/mp4"],
  ["mov", "video/quicktime"],
  ["webm", "video/webm"],
]);

/**
 * The media type main serves a file as, read off its name. Anything not
 * previewable is `application/octet-stream`, so HTML and scripts under a
 * root are never served as a document.
 */
export const fileMime = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXTENSION.get(extension) ?? "application/octet-stream";
};
