import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { Protocol } from "electron";
import type { FilePath, FilesError, FilesResult } from "@shared/files";
import { FILE_PROTOCOL_SCHEME, fileMime, parseFileUrl } from "@shared/file-url";
import { parseByteRangeHeader } from "../content/range";

/**
 * `junto-file://<nodeId>/<relpath>`: a file's bytes under a Files node, for
 * the PDF, image and media viewers, with single byte ranges (pdf.js reads a
 * large PDF in pieces). Served only for a node a window has opened, on this
 * machine, inside its root after `realpath` (`FilesService.bytes`). Types
 * come from `fileMime`, so HTML and scripts under a root go out as
 * `application/octet-stream`, `nosniff`. Responses name no path.
 */

const STREAM_HIGH_WATER = 64 * 1024;

export type FileBytesResolver = (
  node: string,
  path: FilePath,
) => Promise<FilesResult<{ readonly real: string; readonly size: number }>>;

/** Same privileges as the content scheme: fetch with Range from the app's own origin. */
export const FILE_PROTOCOL_SCHEME_REGISTRATION = {
  scheme: FILE_PROTOCOL_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    bypassCSP: false,
    allowServiceWorkers: false,
    corsEnabled: true,
    stream: true,
    codeCache: false,
    allowExtensions: false,
  },
} as const;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type",
  "Cross-Origin-Resource-Policy": "cross-origin",
} as const;

const headers = (extra: Record<string, string>): Headers =>
  new Headers({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    ...CORS_HEADERS,
    ...extra,
  });

const STATUS_OF: Record<FilesError, number> = {
  "no-node": 404,
  elsewhere: 404,
  "root-missing": 404,
  "not-found": 404,
  "invalid-path": 400,
  "outside-root": 403,
  denied: 403,
  "is-dir": 400,
  "not-dir": 400,
  exists: 409,
  stale: 409,
  "too-large": 413,
  failed: 500,
};

const refusal = (status: number, reason: string, method: string): Response => {
  const body = new TextEncoder().encode(`${reason}\n`);
  return new Response(method === "HEAD" ? null : body, {
    status,
    headers: headers({ "Content-Type": "text/plain; charset=utf-8", "Content-Length": String(body.byteLength) }),
  });
};

export const createFileProtocolHandler = (bytes: FileBytesResolver) =>
  async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: headers({ "Access-Control-Max-Age": "86400", "Content-Length": "0" }) });
    }
    if (request.method !== "GET" && request.method !== "HEAD") return refusal(405, "method not allowed", request.method);
    const target = parseFileUrl(request.url);
    if (target === undefined) return refusal(400, "invalid-path", request.method);
    let found: Awaited<ReturnType<FileBytesResolver>>;
    try {
      found = await bytes(target.node, target.path);
    } catch (cause) {
      console.error("[files] protocol read failed", cause);
      return refusal(500, "failed", request.method);
    }
    if (!found.ok) return refusal(STATUS_OF[found.error], found.error, request.method);
    const { real, size } = found.value;
    const range = parseByteRangeHeader(request.headers.get("range"), size);
    if (range.kind === "unsatisfiable") {
      return new Response(null, { status: 416, headers: headers({ "Content-Range": `bytes */${String(size)}` }) });
    }
    const start = range.kind === "full" ? 0 : range.start;
    const end = range.kind === "full" ? Math.max(0, size - 1) : range.end;
    const length = size === 0 ? 0 : end - start + 1;
    const response = headers({
      "Accept-Ranges": "bytes",
      "Content-Type": fileMime(target.path),
      "Content-Length": String(length),
    });
    if (range.kind === "partial") response.set("Content-Range", `bytes ${String(start)}-${String(end)}/${String(size)}`);
    const status = range.kind === "partial" ? 206 : 200;
    if (request.method === "HEAD" || size === 0) return new Response(null, { status, headers: response });
    const stream = createReadStream(real, { start, end, highWaterMark: STREAM_HIGH_WATER });
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status, headers: response });
  };

export const installFileProtocol = (target: Protocol, bytes: FileBytesResolver): void => {
  if (target.isProtocolHandled(FILE_PROTOCOL_SCHEME)) throw new Error("file protocol already has a handler");
  target.handle(FILE_PROTOCOL_SCHEME, createFileProtocolHandler(bytes));
};
