import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open as openFile,
  opendir,
  unlink,
} from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Either, Schema } from "effect";
import { decodeCanvasDoc } from "@shared/canvas";
import { formatNodeRef } from "@shared/node-ref";
import {
  CONTROL_ROUTES,
  CONTROL_HEADERS_TIMEOUT_MS,
  CONTROL_MAX_BODY_BYTES,
  CONTROL_MAX_HEADER_BYTES,
  CONTROL_REQUEST_TIMEOUT_MS,
  CONTROL_TOKEN_HEADER,
  controlDir,
  controlErr,
  controlOk,
  controlShotsDir,
  controlSocketPath,
  controlTokenPath,
  encodeControlEnvelope,
  inspectControlJson,
  inspectEvalResult,
  CloseRequest,
  EvalRequest,
  GotoRequest,
  OpenRequest,
  ScreenshotRequest,
  type ControlEnvelope,
  type ControlErrorTag,
  type PageNodeRow,
} from "@shared/browser-control";
import {
  BROWSER_CONTROL_HANDLER_TIMEOUT_MS,
  BROWSER_CONTROL_MAX_RESPONSE_BYTES,
  BROWSER_MAX_ACTIVE_HTTP_HANDLERS,
  BROWSER_MAX_CANVAS_DIRECTORY_ENTRIES,
  BROWSER_MAX_CANVAS_SCAN_BYTES,
  BROWSER_MAX_CANVAS_SOURCE_BYTES,
  BROWSER_MAX_EVAL_RESULT_NODES,
  BROWSER_MAX_LIST_ROWS,
  BROWSER_MAX_METADATA_BYTES,
  BROWSER_MAX_REF_BYTES,
  BROWSER_MAX_SCREENSHOT_BYTES,
  BROWSER_MAX_URL_BYTES,
  isUtf8WithinLimit,
  isValidBrowserSessionId,
  utf8ByteLength,
} from "@shared/browser-limits";
import type { BrowserResult } from "./sessions";
import { BrowserSessionService } from "./sessions";
import type { PageTargetResolver } from "./page-target";

// Local control plane for agents (the browser ACI): a tiny HTTP server on a
// unix domain socket at ~/.vellum/browser/control.sock, hosted by the Electron
// main process and calling the warm-session service directly. Security model:
// filesystem (socket + token file are chmod 600 in the user's home) plus a
// bearer token on EVERY request — so a same-host process still needs read
// access to the token file. The service has no TCP transport.

// ---------------------------------------------------------------------------
// Token: regenerate if missing, always chmod 600. Constant-time compare via
// sha256 digests so neither content nor length leaks through timing.

export const loadOrCreateToken = (tokenPath: string): string => {
  if (existsSync(tokenPath)) {
    chmodSync(tokenPath, 0o600);
    const token = readFileSync(tokenPath, "utf8").trim();
    if (token.length > 0) {
      return token;
    }
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return token;
};

export const tokenMatches = (presented: string | undefined, expected: string): boolean => {
  if (presented === undefined) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
};

// ---------------------------------------------------------------------------
// Page-node listing: link nodes upgraded to entity.kind "page" across every
// .canvas document. Read-only; a corrupt canvas degrades to zero rows for that
// file rather than failing the listing (canvas-ls precedent).

const readBoundedCanvasSource = async (
  path: string,
  remainingBytes: number,
): Promise<{ readonly source: string; readonly bytes: number } | undefined> => {
  const maxBytes = Math.min(BROWSER_MAX_CANVAS_SOURCE_BYTES, remainingBytes);
  if (maxBytes <= 0) return undefined;
  const admitted = await lstat(path);
  if (!admitted.isFile() || admitted.size > maxBytes) return undefined;

  const handle = await openFile(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { source: buffer.subarray(0, offset).toString("utf8"), bytes: offset };
  } finally {
    await handle.close();
  }
};

const boundedRuntimeValue = (value: number | undefined, hardLimit: number): number =>
  value !== undefined && Number.isInteger(value) && value > 0
    ? Math.min(value, hardLimit)
    : hardLimit;

export interface PageListRuntime {
  /** Tests may lower, never raise, the production directory admission ceiling. */
  readonly maxDirectoryEntries?: number;
  /** Tests may lower, never raise, the production aggregate source-byte ceiling. */
  readonly maxScanBytes?: number;
}

export const listPageNodes = async (
  canvasesDir: string,
  sessions?: BrowserSessionService,
  runtime: PageListRuntime = {},
): Promise<ReadonlyArray<PageNodeRow>> => {
  await mkdir(canvasesDir, { recursive: true });
  const maxDirectoryEntries = boundedRuntimeValue(
    runtime.maxDirectoryEntries,
    BROWSER_MAX_CANVAS_DIRECTORY_ENTRIES,
  );
  const maxScanBytes = boundedRuntimeValue(
    runtime.maxScanBytes,
    BROWSER_MAX_CANVAS_SCAN_BYTES,
  );
  const directory = await opendir(canvasesDir);
  const files: string[] = [];
  let directoryEntries = 0;
  for await (const entry of directory) {
    directoryEntries += 1;
    if (directoryEntries > maxDirectoryEntries) break;
    if (entry.isFile() && entry.name.endsWith(".canvas")) files.push(entry.name);
  }
  const rows: PageNodeRow[] = [];
  let responseBytes = utf8ByteLength(encodeControlEnvelope(controlOk([])));
  let responseNodes = 3; // envelope object + ok boolean + data array
  let scannedBytes = 0;
  for (const file of files.sort()) {
    try {
      const canvasName = file.slice(0, -".canvas".length);
      if (!isUtf8WithinLimit(canvasName, BROWSER_MAX_METADATA_BYTES)) continue;
      const admitted = await readBoundedCanvasSource(
        join(canvasesDir, file),
        maxScanBytes - scannedBytes,
      );
      if (admitted === undefined) continue;
      scannedBytes += admitted.bytes;
      const decoded = decodeCanvasDoc(JSON.parse(admitted.source));
      if (Either.isLeft(decoded)) continue;
      for (const node of decoded.right.nodes) {
        if (node.type !== "link" || node.ether?.entity?.kind !== "page") continue;
        if (
          !isUtf8WithinLimit(node.id, BROWSER_MAX_METADATA_BYTES) ||
          !isUtf8WithinLimit(node.url, BROWSER_MAX_URL_BYTES)
        ) {
          continue;
        }
        const profile = node.ether.browser?.profile;
        if (profile !== undefined && !isUtf8WithinLimit(profile, BROWSER_MAX_METADATA_BYTES)) {
          continue;
        }
        const ref = formatNodeRef({
          canvasName,
          nodeId: node.id,
        });
        if (!isUtf8WithinLimit(ref, BROWSER_MAX_REF_BYTES)) continue;
        const sessionId = sessions?.sessionIdForRef(ref) ?? null;
        if (sessionId !== null && !isValidBrowserSessionId(sessionId)) continue;
        const row: PageNodeRow = {
          ref,
          sessionId,
          canvas: canvasName,
          nodeId: node.id,
          url: node.url,
          ...(profile !== undefined ? { profile } : {}),
        };
        const rowBytes = utf8ByteLength(JSON.stringify(row)) + (rows.length === 0 ? 0 : 1);
        const rowNodes = 1 + Object.keys(row).length;
        if (
          rows.length >= BROWSER_MAX_LIST_ROWS ||
          responseBytes + rowBytes > BROWSER_CONTROL_MAX_RESPONSE_BYTES ||
          responseNodes + rowNodes > BROWSER_MAX_EVAL_RESULT_NODES
        ) {
          return rows;
        }
        rows.push(row);
        responseBytes += rowBytes;
        responseNodes += rowNodes;
      }
    } catch {
      // unreadable/corrupt canvas — skip, listing must not crash
    }
  }
  return rows;
};

// ---------------------------------------------------------------------------
// Route handlers, transport-free for tests: (route, body) → envelope.

const httpStatus = (tag: ControlErrorTag): number =>
  tag === "unauthorized"
    ? 401
    : tag === "not_found"
      ? 404
      : tag === "forbidden"
        ? 403
        : tag === "timeout"
          ? 504
          : tag === "cancelled"
            ? 408
            : tag === "resource_exhausted"
              ? 429
              : tag === "result_too_large"
                ? 413
                : tag === "unsupported_result"
                  ? 422
                  : tag === "bad_request" || tag === "invalid"
                    ? 400
                    : 500;

const fromResult = <T>(result: BrowserResult<T>): ControlEnvelope<T> =>
  result.ok ? controlOk(result.data) : controlErr(result.code, result.message);

const decodeBody =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (body: unknown): Either.Either<A, ControlEnvelope<never>> => {
    const decoded = Schema.decodeUnknownEither(schema)(body);
    return Either.isLeft(decoded)
      ? Either.left(controlErr("bad_request", String(decoded.left.message).slice(0, 400)))
      : Either.right(decoded.right);
  };

export interface ControlDeps {
  readonly sessions: BrowserSessionService;
  readonly resolvePageTarget: PageTargetResolver;
  readonly version: string;
  readonly canvasesDir: string;
  readonly shotsDir: string;
  readonly screenshotFiles?: {
    readonly ensureDirectory?: (path: string) => Promise<void>;
    readonly makePath?: (directory: string) => string;
    readonly writeExclusive?: (path: string, data: Uint8Array) => Promise<void>;
    readonly remove?: (path: string) => Promise<void>;
  };
}

const ensureScreenshotDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("screenshot directory must be a real directory");
  }
  await chmod(path, 0o700);
};

const writeScreenshotExclusive = async (path: string, data: Uint8Array): Promise<void> => {
  const handle = await openFile(path, "wx", 0o600);
  let complete = false;
  try {
    await handle.writeFile(data);
    await handle.chmod(0o600);
    complete = true;
  } finally {
    await handle.close();
    if (!complete) await unlink(path).catch(() => undefined);
  }
};

const removeScreenshot = async (path: string): Promise<void> => {
  await unlink(path);
};

export const makeControlHandlers = (deps: ControlDeps) => {
  const screenshotFiles = {
    ensureDirectory: deps.screenshotFiles?.ensureDirectory ?? ensureScreenshotDirectory,
    makePath:
      deps.screenshotFiles?.makePath ??
      ((directory: string) => join(directory, `${randomBytes(24).toString("hex")}.png`)),
    writeExclusive: deps.screenshotFiles?.writeExclusive ?? writeScreenshotExclusive,
    remove: deps.screenshotFiles?.remove ?? removeScreenshot,
  };
  const withBody =
    <A, I>(
      schema: Schema.Schema<A, I>,
      keys: ReadonlyArray<string>,
      run: (input: A, signal?: AbortSignal) => Promise<ControlEnvelope<unknown>>,
    ) =>
    async (body: unknown, signal?: AbortSignal): Promise<ControlEnvelope<unknown>> => {
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !keys.includes(key))
      ) {
        return controlErr("bad_request", "request contains unknown or invalid fields");
      }
      const decoded = decodeBody(schema)(body);
      return Either.isLeft(decoded) ? decoded.left : run(decoded.right, signal);
    };

  const handlers: Record<
    string,
    (body: unknown, signal?: AbortSignal) => Promise<ControlEnvelope<unknown>>
  > = {
    "GET /doctor": async () => {
      const listed = deps.sessions.list();
      return controlOk({
        status: "ok" as const,
        pid: process.pid,
        version: deps.version,
        sessions: listed.ok ? listed.data.length : 0,
      });
    },

    "GET /profiles": async () => {
      const result = await deps.sessions.listProfiles();
      return result.ok ? controlOk(result.data.slice(0, BROWSER_MAX_LIST_ROWS)) : fromResult(result);
    },

    "GET /sessions": async () => {
      const result = deps.sessions.list();
      return result.ok ? controlOk(result.data.slice(0, BROWSER_MAX_LIST_ROWS)) : fromResult(result);
    },

    "GET /pages": async () => controlOk(await listPageNodes(deps.canvasesDir, deps.sessions)),

    "POST /open": withBody(OpenRequest, ["ref"], async (input, signal) => {
      const target = await deps.resolvePageTarget(input.ref);
      return target.ok
        ? fromResult(await deps.sessions.open(target.data, signal))
        : controlErr(target.code, target.message);
    }),

    "POST /goto": withBody(GotoRequest, ["sessionId", "url"], async (input, signal) =>
      fromResult(deps.sessions.goto(input.sessionId, input.url, signal)),
    ),

    "POST /eval": withBody(EvalRequest, ["sessionId", "code"], async (input, signal) => {
      const result = await deps.sessions.eval(input.sessionId, input.code, signal);
      if (!result.ok) return fromResult(result);
      const inspected = inspectEvalResult(result.data.result);
      return inspected.ok
        ? controlOk({ result: result.data.result })
        : { ok: false, error: inspected.error };
    }),

    "POST /screenshot": withBody(ScreenshotRequest, ["sessionId"], async (input, signal) => {
      const shot = await deps.sessions.screenshot(input.sessionId, signal);
      if (!shot.ok) return fromResult(shot);
      if (shot.data.png.byteLength > BROWSER_MAX_SCREENSHOT_BYTES) {
        return controlErr(
          "result_too_large",
          `screenshot exceeds ${BROWSER_MAX_SCREENSHOT_BYTES} bytes`,
        );
      }
      const current = deps.sessions.state(input.sessionId);
      if (!current.ok) return fromResult(current);
      if (signal?.aborted) return controlErr("cancelled", "screenshot request was cancelled");

      const resolvedShotsDir = resolve(deps.shotsDir);
      const path = resolve(screenshotFiles.makePath(resolvedShotsDir));
      if (dirname(path) !== resolvedShotsDir || !path.endsWith(".png")) {
        return controlErr("invalid", "screenshot destination escaped the server shots directory");
      }
      let wrote = false;
      try {
        await screenshotFiles.ensureDirectory(resolvedShotsDir);
        const writable = deps.sessions.state(input.sessionId);
        if (!writable.ok) return fromResult(writable);
        if (signal?.aborted) return controlErr("cancelled", "screenshot request was cancelled");
        await screenshotFiles.writeExclusive(path, shot.data.png);
        wrote = true;
        const stillCurrent = deps.sessions.state(input.sessionId);
        if (signal?.aborted || !stillCurrent.ok) {
          await screenshotFiles.remove(path);
          wrote = false;
          return signal?.aborted
            ? controlErr("cancelled", "screenshot request was cancelled")
            : fromResult(stillCurrent);
        }
      } catch (error) {
        if (wrote) await screenshotFiles.remove(path).catch(() => undefined);
        return controlErr("failed", error instanceof Error ? error.message : String(error));
      }
      return controlOk({ path, bytes: shot.data.png.byteLength });
    }),

    "POST /close": withBody(CloseRequest, ["sessionId"], async (input) =>
      fromResult(deps.sessions.close(input.sessionId)),
    ),
  };

  return handlers;
};

/**
 * Full request dispatch (auth → route → handler), transport-free so tests
 * exercise exactly what the socket serves.
 */
export const dispatchControlRequest = async (
  handlers: ReturnType<typeof makeControlHandlers>,
  token: string,
  request: {
    readonly method: string;
    readonly path: string;
    readonly token: string | undefined;
    readonly body: unknown;
  },
  signal?: AbortSignal,
): Promise<{ status: number; envelope: ControlEnvelope<unknown> }> => {
  if (!tokenMatches(request.token, token)) {
    return { status: 401, envelope: controlErr("unauthorized", "missing or invalid token") };
  }
  const handler = handlers[`${request.method} ${request.path}`];
  if (!handler) {
    return {
      status: 404,
      envelope: controlErr("bad_request", `unknown route ${request.method} ${request.path}`),
    };
  }
  const envelope = await handler(request.body, signal);
  return { status: envelope.ok ? 200 : httpStatus(envelope.error._tag), envelope };
};

// ---------------------------------------------------------------------------
// HTTP hosting

type BodyReadResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly status: 400 | 408 | 413; readonly message: string };

const readBoundedBody = (req: IncomingMessage): Promise<BodyReadResult> =>
  new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const settle = (result: BodyReadResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
      resolveBody(result);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > CONTROL_MAX_BODY_BYTES) {
        req.pause();
        settle({
          ok: false,
          status: 413,
          message: `request body exceeds ${CONTROL_MAX_BODY_BYTES} bytes`,
        });
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        settle({ ok: true, body: undefined });
        return;
      }
      try {
        settle({ ok: true, body: JSON.parse(raw) });
      } catch {
        settle({ ok: false, status: 400, message: "body is not valid JSON" });
      }
    };
    const onAborted = (): void =>
      settle({ ok: false, status: 400, message: "request body was aborted" });
    const onError = (): void =>
      settle({ ok: false, status: 400, message: "request body could not be read" });
    const timer = setTimeout(() => {
      req.pause();
      settle({
        ok: false,
        status: 408,
        message: `request body was not received within ${CONTROL_REQUEST_TIMEOUT_MS}ms`,
      });
    }, CONTROL_REQUEST_TIMEOUT_MS);

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
  });

const bearerToken = (req: IncomingMessage): string | undefined => {
  const header = req.headers[CONTROL_TOKEN_HEADER];
  if (typeof header === "string" && header.length > 0) return header;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  return undefined;
};

export interface BrowserControlServer {
  readonly socketPath: string;
  close(): void;
}

export interface BrowserControlRuntime {
  readonly chmodSocket: (path: string, mode: number) => void;
  /** Tests may lower, never raise, the production admission ceiling. */
  readonly maxActiveHandlers?: number;
  /** Tests may lower, never raise, the production handler deadline. */
  readonly handlerTimeoutMs?: number;
}

const defaultControlRuntime: BrowserControlRuntime = {
  chmodSocket: chmodSync,
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
  });

const unlinkSocket = (socketPath: string): void => {
  if (existsSync(socketPath)) unlinkSync(socketPath);
};

const listenOnSocket = (server: Server, socketPath: string): Promise<void> =>
  new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen({ path: socketPath, readableAll: false, writableAll: false }, () => {
      server.off("error", onError);
      resolveListen();
    });
  });

const parseContentLength = (
  req: IncomingMessage,
): { readonly ok: true; readonly value: number | undefined } | { readonly ok: false } => {
  const header = req.headers["content-length"];
  if (header === undefined) return { ok: true, value: undefined };
  if (Array.isArray(header) || !/^(0|[1-9][0-9]*)$/.test(header)) return { ok: false };
  const value = Number(header);
  return Number.isSafeInteger(value) ? { ok: true, value } : { ok: false };
};

/**
 * Start the owner-local control plane. Idempotent per app run; call close() on
 * quit. Startup resolves only after the Unix socket has owner-only permissions.
 */
export const startBrowserControlServer = async (
  options: {
    readonly sessions: BrowserSessionService;
    readonly resolvePageTarget: PageTargetResolver;
    readonly version: string;
    readonly home?: string;
  },
  runtime: BrowserControlRuntime = defaultControlRuntime,
): Promise<BrowserControlServer> => {
  const home = options.home ?? homedir();
  const dir = controlDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  await ensureScreenshotDirectory(controlShotsDir(home));

  const token = loadOrCreateToken(controlTokenPath(home));
  const handlers = makeControlHandlers({
    sessions: options.sessions,
    resolvePageTarget: options.resolvePageTarget,
    version: options.version,
    canvasesDir: join(home, ".vellum", "canvases"),
    shotsDir: controlShotsDir(home),
  });
  const maxActiveHandlers = boundedRuntimeValue(
    runtime.maxActiveHandlers,
    BROWSER_MAX_ACTIVE_HTTP_HANDLERS,
  );
  const handlerTimeoutMs = boundedRuntimeValue(
    runtime.handlerTimeoutMs,
    BROWSER_CONTROL_HANDLER_TIMEOUT_MS,
  );
  let activeHandlers = 0;

  const server: Server = createServer(
    { maxHeaderSize: CONTROL_MAX_HEADER_BYTES },
    (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const respond = (
          status: number,
          envelope: ControlEnvelope<unknown>,
          closeConnection = false,
        ): void => {
          if (res.headersSent || res.destroyed) return;
          const inspected = inspectControlJson(envelope, BROWSER_CONTROL_MAX_RESPONSE_BYTES);
          const safeEnvelope: ControlEnvelope<unknown> = inspected.ok
            ? envelope
            : { ok: false, error: inspected.error };
          const safeStatus = inspected.ok ? status : httpStatus(inspected.error._tag);
          const body = inspected.ok ? inspected.encoded : encodeControlEnvelope(safeEnvelope);
          res.writeHead(safeStatus, {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
            ...(closeConnection ? { connection: "close" } : {}),
          });
          if (closeConnection) {
            res.once("finish", () => req.socket.destroy());
          }
          res.end(body);
        };

        const presentedToken = bearerToken(req);
        if (!tokenMatches(presentedToken, token)) {
          respond(401, controlErr("unauthorized", "missing or invalid token"), true);
          return;
        }

        let url: URL;
        try {
          url = new URL(req.url ?? "/", "http://control.local");
        } catch {
          respond(400, controlErr("bad_request", "request target is malformed"), true);
          return;
        }
        const method = req.method ?? "GET";
        if (handlers[`${method} ${url.pathname}`] === undefined) {
          respond(
            404,
            controlErr("bad_request", `unknown route ${method} ${url.pathname}`),
            true,
          );
          return;
        }
        if (activeHandlers >= maxActiveHandlers) {
          respond(
            429,
            controlErr(
              "resource_exhausted",
              `active browser handler capacity reached (${maxActiveHandlers})`,
            ),
            true,
          );
          return;
        }

        activeHandlers += 1;
        const controller = new AbortController();
        let deadlineExpired = false;
        const abortDisconnected = (): void => {
          if (!res.writableEnded && !controller.signal.aborted) controller.abort();
        };
        req.once("aborted", abortDisconnected);
        res.once("close", abortDisconnected);
        const deadline = setTimeout(() => {
          deadlineExpired = true;
          if (!controller.signal.aborted) controller.abort();
        }, handlerTimeoutMs);
        let releaseHandlerOnExit = true;

        try {
          const operation = (async (): Promise<{
            readonly status: number;
            readonly envelope: ControlEnvelope<unknown>;
            readonly closeConnection?: boolean;
          }> => {
            const declaredLength = parseContentLength(req);
            if (!declaredLength.ok) {
              return {
                status: 400,
                envelope: controlErr("bad_request", "invalid Content-Length header"),
                closeConnection: true,
              };
            }
            if (
              declaredLength.value !== undefined &&
              declaredLength.value > CONTROL_MAX_BODY_BYTES
            ) {
              return {
                status: 413,
                envelope: controlErr(
                  "bad_request",
                  `request body exceeds ${CONTROL_MAX_BODY_BYTES} bytes`,
                ),
                closeConnection: true,
              };
            }

            const body = await readBoundedBody(req);
            if (!body.ok) {
              return {
                status: body.status,
                envelope: controlErr("bad_request", body.message),
                closeConnection: true,
              };
            }
            return dispatchControlRequest(
              handlers,
              token,
              {
                method,
                path: url.pathname,
                token: presentedToken,
                body: body.body,
              },
              controller.signal,
            );
          })().catch((error: unknown) => ({
            status: 500,
            envelope: controlErr(
              "failed",
              error instanceof Error ? error.message : String(error),
            ),
            closeConnection: false,
          }));

          const aborted = new Promise<{ readonly aborted: true }>((resolveAbort) => {
            if (controller.signal.aborted) {
              resolveAbort({ aborted: true });
              return;
            }
            controller.signal.addEventListener(
              "abort",
              () => resolveAbort({ aborted: true }),
              { once: true },
            );
          });
          const outcome = await Promise.race([
            operation.then((reply) => ({ aborted: false as const, reply })),
            aborted,
          ]);
          if (outcome.aborted) {
            releaseHandlerOnExit = false;
            void operation.then(() => {
              activeHandlers -= 1;
            });
            if (deadlineExpired) {
              respond(
                504,
                controlErr("timeout", `browser control handler exceeded ${handlerTimeoutMs}ms`),
                true,
              );
            }
            return;
          }
          respond(
            outcome.reply.status,
            outcome.reply.envelope,
            outcome.reply.closeConnection ?? false,
          );
        } finally {
          clearTimeout(deadline);
          req.off("aborted", abortDisconnected);
          res.off("close", abortDisconnected);
          if (releaseHandlerOnExit) activeHandlers -= 1;
        }
      })();
    },
  );
  server.headersTimeout = CONTROL_HEADERS_TIMEOUT_MS;
  server.requestTimeout = CONTROL_REQUEST_TIMEOUT_MS;
  server.on("clientError", (error: Error & { code?: string }, socket) => {
    if (!socket.writable) return;
    const status =
      error.code === "HPE_HEADER_OVERFLOW"
        ? 431
        : error.code === "ERR_HTTP_REQUEST_TIMEOUT"
          ? 408
          : 400;
    const envelope = controlErr(
      "bad_request",
      status === 431 ? "request headers exceed the admission limit" : "malformed request",
    );
    const body = encodeControlEnvelope(envelope);
    socket.end(
      `HTTP/1.1 ${status} ${status === 431 ? "Request Header Fields Too Large" : "Bad Request"}\r\n` +
        "Content-Type: application/json\r\n" +
        "Connection: close\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  });

  // Stale socket from a crashed run blocks listen — remove before binding.
  const socketPath = controlSocketPath(home);
  unlinkSocket(socketPath);
  await listenOnSocket(server, socketPath);
  try {
    runtime.chmodSocket(socketPath, 0o600);
  } catch (error) {
    await closeServer(server);
    unlinkSocket(socketPath);
    throw error;
  }
  server.on("error", (error) => {
    console.error("[browser-control] server error:", error);
  });

  return {
    socketPath,
    close: () => {
      server.close();
      try {
        unlinkSocket(socketPath);
      } catch {
        // socket file may already be gone
      }
    },
  };
};
