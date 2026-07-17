import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, isAbsolute, resolve, sep } from "node:path";
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
  CloseRequest,
  EvalRequest,
  GotoRequest,
  OpenRequest,
  ScreenshotRequest,
  type ControlEnvelope,
  type ControlErrorTag,
  type PageNodeRow,
} from "@shared/browser-control";
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

export const listPageNodes = async (
  canvasesDir: string,
  sessions?: BrowserSessionService,
): Promise<ReadonlyArray<PageNodeRow>> => {
  await mkdir(canvasesDir, { recursive: true });
  const files = (await readdir(canvasesDir)).filter((f) => f.endsWith(".canvas"));
  const rows: PageNodeRow[] = [];
  for (const file of files.sort()) {
    try {
      const decoded = decodeCanvasDoc(JSON.parse(await readFile(join(canvasesDir, file), "utf8")));
      if (Either.isLeft(decoded)) continue;
      for (const node of decoded.right.nodes) {
        if (node.type !== "link" || node.ether?.entity?.kind !== "page") continue;
        const ref = formatNodeRef({
          canvasName: file.slice(0, -".canvas".length),
          nodeId: node.id,
        });
        rows.push({
          ref,
          sessionId: sessions?.sessionIdForRef(ref) ?? null,
          canvas: file.slice(0, -".canvas".length),
          nodeId: node.id,
          url: node.url,
          ...(node.ether.browser?.profile !== undefined
            ? { profile: node.ether.browser.profile }
            : {}),
        });
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
    readonly ensureDirectory: (path: string) => Promise<void>;
    readonly write: (path: string, data: Uint8Array) => Promise<void>;
  };
}

export const makeControlHandlers = (deps: ControlDeps) => {
  const screenshotFiles = deps.screenshotFiles ?? {
    ensureDirectory: async (path: string) => {
      await mkdir(path, { recursive: true });
    },
    write: async (path: string, data: Uint8Array) => {
      await writeFile(path, data);
    },
  };
  const withBody =
    <A, I>(
      schema: Schema.Schema<A, I>,
      keys: ReadonlyArray<string>,
      run: (input: A) => Promise<ControlEnvelope<unknown>>,
    ) =>
    async (body: unknown): Promise<ControlEnvelope<unknown>> => {
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !keys.includes(key))
      ) {
        return controlErr("bad_request", "request contains unknown or invalid fields");
      }
      const decoded = decodeBody(schema)(body);
      return Either.isLeft(decoded) ? decoded.left : run(decoded.right);
    };

  const handlers: Record<string, (body: unknown) => Promise<ControlEnvelope<unknown>>> = {
    "GET /doctor": async () => {
      const listed = deps.sessions.list();
      return controlOk({
        status: "ok" as const,
        pid: process.pid,
        version: deps.version,
        sessions: listed.ok ? listed.data.length : 0,
      });
    },

    "GET /profiles": async () => fromResult(await deps.sessions.listProfiles()),

    "GET /sessions": async () => fromResult(deps.sessions.list()),

    "GET /pages": async () => controlOk(await listPageNodes(deps.canvasesDir, deps.sessions)),

    "POST /open": withBody(OpenRequest, ["ref"], async (input) => {
      const target = await deps.resolvePageTarget(input.ref);
      return target.ok
        ? fromResult(await deps.sessions.open(target.data))
        : controlErr(target.code, target.message);
    }),

    "POST /goto": withBody(GotoRequest, ["sessionId", "url"], async (input) =>
      fromResult(deps.sessions.goto(input.sessionId, input.url)),
    ),

    "POST /eval": withBody(EvalRequest, ["sessionId", "code"], async (input) => {
      const result = await deps.sessions.eval(input.sessionId, input.code);
      // executeJavaScript can resolve to undefined — normalize to null so the
      // JSON envelope keeps an explicit `result` key.
      return result.ok ? controlOk({ result: result.data.result ?? null }) : fromResult(result);
    }),

    "POST /screenshot": withBody(ScreenshotRequest, ["sessionId", "path"], async (input) => {
      if (input.path !== undefined && !isAbsolute(input.path)) {
        return controlErr("invalid", `screenshot path must be absolute: ${input.path}`);
      }
      const shot = await deps.sessions.screenshot(input.sessionId);
      if (!shot.ok) return fromResult(shot);
      const current = deps.sessions.state(input.sessionId);
      if (!current.ok) return fromResult(current);
      const path =
        input.path ?? join(deps.shotsDir, `${input.sessionId}-${Date.now()}.png`);
      // Injected test generators are caller-owned seams, so confine even the
      // sessionId-derived default rather than assuming UUID syntax here.
      // Explicit `input.path` is a deliberate absolute override (checked
      // above) and is exempt; only the nodeId-derived default is confined.
      if (input.path === undefined) {
        const resolvedShotsDir = resolve(deps.shotsDir);
        const resolvedPath = resolve(path);
        if (resolvedPath !== resolvedShotsDir && !resolvedPath.startsWith(resolvedShotsDir + sep)) {
          return controlErr("invalid", "sessionId produces an unsafe default screenshot path");
        }
      }
      try {
        await screenshotFiles.ensureDirectory(dirname(path));
        const writable = deps.sessions.state(input.sessionId);
        if (!writable.ok) return fromResult(writable);
        await screenshotFiles.write(path, shot.data.png);
      } catch (error) {
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
  const envelope = await handler(request.body);
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
  mkdirSync(controlShotsDir(home), { recursive: true, mode: 0o700 });
  chmodSync(controlShotsDir(home), 0o700);

  const token = loadOrCreateToken(controlTokenPath(home));
  const handlers = makeControlHandlers({
    sessions: options.sessions,
    resolvePageTarget: options.resolvePageTarget,
    version: options.version,
    canvasesDir: join(home, ".vellum", "canvases"),
    shotsDir: controlShotsDir(home),
  });

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
          const body = JSON.stringify(envelope);
          res.writeHead(status, {
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

        try {
          const url = new URL(req.url ?? "/", "http://control.local");
          const method = req.method ?? "GET";
          if (handlers[`${method} ${url.pathname}`] === undefined) {
            respond(
              404,
              controlErr("bad_request", `unknown route ${method} ${url.pathname}`),
              true,
            );
            return;
          }

          const declaredLength = parseContentLength(req);
          if (!declaredLength.ok) {
            respond(400, controlErr("bad_request", "invalid Content-Length header"), true);
            return;
          }
          if (
            declaredLength.value !== undefined &&
            declaredLength.value > CONTROL_MAX_BODY_BYTES
          ) {
            respond(
              413,
              controlErr("bad_request", `request body exceeds ${CONTROL_MAX_BODY_BYTES} bytes`),
              true,
            );
            return;
          }

          const body = await readBoundedBody(req);
          if (!body.ok) {
            respond(body.status, controlErr("bad_request", body.message), true);
            return;
          }
          const { status, envelope } = await dispatchControlRequest(handlers, token, {
            method,
            path: url.pathname,
            token: presentedToken,
            body: body.body,
          });
          respond(status, envelope);
        } catch (error) {
          respond(
            500,
            controlErr("failed", error instanceof Error ? error.message : String(error)),
          );
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
    const body = JSON.stringify(envelope);
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
