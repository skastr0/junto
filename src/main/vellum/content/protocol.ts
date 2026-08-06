import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { Protocol } from "electron";
import type { ContentAvailability, ContentRef } from "@shared/content";
import {
  CONTENT_PROTOCOL_SCHEME,
  CONTENT_REASON_HEADER,
  CONTENT_SHA256_HEADER,
  CONTENT_STATE_HEADER,
  parseContentObjectUrl,
} from "@shared/content-url";
import { parseByteRangeHeader } from "./range";

const STREAM_HIGH_WATER = 64 * 1024;

export type ContentOpenResult =
  | {
      readonly state: "verified";
      readonly path: string;
      readonly byteLength: number;
      readonly mediaType: string;
    }
  | Extract<
      ContentAvailability,
      { state: "missing" | "corrupt" | "unavailable" }
    >;

export type ContentOpenResolver = (
  ref: ContentRef,
) => Promise<ContentOpenResult>;

const safeReason = (reason: string): string =>
  reason.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 512);

/**
 * Content is intentionally loaded by the app renderer, which lives on a
 * different origin (dev: loopback Vite; packaged: vellum-command-app://). CORP must
 * allow cross-origin embedding, and CORS headers must allow fetch HEAD probes
 * from ContentMedia.
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Expose-Headers": [
    "Accept-Ranges",
    "Content-Length",
    "Content-Range",
    "Content-Type",
    CONTENT_STATE_HEADER,
    CONTENT_REASON_HEADER,
    CONTENT_SHA256_HEADER,
  ].join(", "),
  "Cross-Origin-Resource-Policy": "cross-origin",
} as const;

const baseHeaders = (extra: Record<string, string>): Headers =>
  new Headers({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...CORS_HEADERS,
    ...extra,
  });

const stateResponse = (
  status: number,
  state: "missing" | "corrupt" | "unavailable" | "invalid",
  reason: string,
  method: string,
): Response => {
  const bodyText = `${state}: ${reason}\n`;
  const body = new TextEncoder().encode(bodyText);
  return new Response(method === "HEAD" ? null : body, {
    status,
    headers: baseHeaders({
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(body.byteLength),
      [CONTENT_STATE_HEADER]: state,
      [CONTENT_REASON_HEADER]: safeReason(reason),
    }),
  });
};

const corsPreflightResponse = (): Response =>
  new Response(null, {
    status: 204,
    headers: baseHeaders({
      "Access-Control-Max-Age": "86400",
      "Content-Length": "0",
    }),
  });

const streamBody = (
  path: string,
  start: number,
  end: number,
): ReadableStream<Uint8Array> => {
  const nodeStream = createReadStream(path, {
    start,
    end,
    highWaterMark: STREAM_HIGH_WATER,
  });
  // Electron protocol.handle accepts Web ReadableStream; never buffer the file.
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
};

/**
 * Privileged scheme registration entry for the content protocol.
 * Must be registered in the same `registerSchemesAsPrivileged` call as other
 * app schemes (Electron allows only one such call before ready).
 */
export const CONTENT_PROTOCOL_SCHEME_REGISTRATION = {
  scheme: CONTENT_PROTOCOL_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    bypassCSP: false,
    allowServiceWorkers: false,
    // Renderer (vellum-command-app / Vite loopback) is a different origin; HEAD probes
    // and element loads need CORS participation on this scheme.
    corsEnabled: true,
    stream: true,
    codeCache: false,
    allowExtensions: false,
  },
} as const;

/**
 * Pure request handler: parse ContentRef from URL, resolve open, stream with
 * optional Range. Injectable resolver keeps tests free of Electron/SQLite.
 */
export const createContentProtocolHandler = (
  open: ContentOpenResolver,
): ((request: Request) => Promise<Response>) => {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return corsPreflightResponse();
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return stateResponse(405, "invalid", "method not allowed", request.method);
    }

    const ref = parseContentObjectUrl(request.url);
    if (ref === undefined) {
      return stateResponse(
        400,
        "invalid",
        "content URL is not a valid ContentRef",
        request.method,
      );
    }

    let opened: ContentOpenResult;
    try {
      opened = await open(ref);
    } catch (error) {
      return stateResponse(
        503,
        "unavailable",
        error instanceof Error ? error.message : "content open failed",
        request.method,
      );
    }

    if (opened.state !== "verified") {
      const status =
        opened.state === "missing" ? 404 : opened.state === "corrupt" ? 409 : 503;
      return stateResponse(
        status,
        opened.state,
        opened.reason,
        request.method,
      );
    }

    const size = opened.byteLength;
    const range = parseByteRangeHeader(
      request.headers.get("range"),
      size,
    );

    if (range.kind === "unsatisfiable") {
      return new Response(request.method === "HEAD" ? null : "range not satisfiable\n", {
        status: 416,
        headers: baseHeaders({
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Range": `bytes */${size}`,
          [CONTENT_STATE_HEADER]: "verified",
          [CONTENT_SHA256_HEADER]: ref.sha256,
          [CONTENT_REASON_HEADER]: "range not satisfiable",
        }),
      });
    }

    const start = range.kind === "full" ? 0 : range.start;
    const end = range.kind === "full" ? Math.max(0, size - 1) : range.end;
    const length = size === 0 ? 0 : end - start + 1;
    const status = range.kind === "partial" ? 206 : 200;

    const headers = baseHeaders({
      "Accept-Ranges": "bytes",
      "Content-Type": opened.mediaType,
      "Content-Length": String(length),
      [CONTENT_STATE_HEADER]: "verified",
      [CONTENT_SHA256_HEADER]: ref.sha256,
    });
    if (range.kind === "partial") {
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    }

    if (request.method === "HEAD" || size === 0) {
      return new Response(null, { status, headers });
    }

    return new Response(streamBody(opened.path, start, end), {
      status,
      headers,
    });
  };
};

export const installContentProtocol = (
  target: Protocol,
  open: ContentOpenResolver,
): void => {
  if (target.isProtocolHandled(CONTENT_PROTOCOL_SCHEME)) {
    throw new Error("content protocol already has a handler");
  }
  const handler = createContentProtocolHandler(open);
  target.handle(CONTENT_PROTOCOL_SCHEME, handler);
  if (!target.isProtocolHandled(CONTENT_PROTOCOL_SCHEME)) {
    throw new Error("content protocol handler was not installed");
  }
};
