import type { FileHandle } from "node:fs/promises";
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

/**
 * A file a viewer reads in pieces, whoever serves it: the core opens it and
 * answers `read` from the offset. Nothing buffers the whole file, so a large
 * PDF or video costs one chunk per frame of the stream.
 */
export type FileBytesReader = {
  readonly size: number;
  readonly read: (offset: number, length: number) => Promise<Uint8Array>;
  readonly close: () => Promise<void>;
};

/** A file opened here, read in pieces: the one shape a viewer streams from. */
export const readerOfHandle = (handle: FileHandle, size: number): FileBytesReader => ({
  size,
  read: async (offset, length) => {
    const buffer = Buffer.alloc(Math.max(1, Math.min(Math.trunc(length), STREAM_HIGH_WATER)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
  },
  close: async () => {
    await handle.close();
  },
});

export type FileBytesResolver = (
  node: string,
  path: FilePath,
) => Promise<FilesResult<FileBytesReader>>;

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
  unreachable: 503,
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
    const reader = found.value;
    const size = reader.size;
    const range = parseByteRangeHeader(request.headers.get("range"), size);
    if (range.kind === "unsatisfiable") {
      await reader.close();
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
    if (request.method === "HEAD" || size === 0) {
      await reader.close();
      return new Response(null, { status, headers: response });
    }
    // Chunks pulled from the reader the check opened; it closes when the stream ends or fails.
    const stream = Readable.from((async function* (): AsyncGenerator<Uint8Array> {
      let position = start;
      try {
        while (position <= end) {
          const chunk = await reader.read(position, Math.min(STREAM_HIGH_WATER, end - position + 1));
          if (chunk.byteLength === 0) return;
          position += chunk.byteLength;
          yield chunk;
        }
      } finally {
        await reader.close();
      }
    })());
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status, headers: response });
  };

export const installFileProtocol = (target: Protocol, bytes: FileBytesResolver): void => {
  if (target.isProtocolHandled(FILE_PROTOCOL_SCHEME)) throw new Error("file protocol already has a handler");
  target.handle(FILE_PROTOCOL_SCHEME, createFileProtocolHandler(bytes));
};
