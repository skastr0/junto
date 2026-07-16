import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, isAbsolute, resolve, sep } from "node:path";
import { Either, Schema } from "effect";
import { decodeCanvasDoc } from "@shared/canvas";
import {
  CONTROL_ROUTES,
  CONTROL_TCP_ENV,
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

// Local control plane for agents (the browser ACI): a tiny HTTP server on a
// unix domain socket at ~/.vellum/browser/control.sock, hosted by the Electron
// main process and calling the warm-session service directly. Security model:
// filesystem (socket + token file are chmod 600 in the user's home) plus a
// bearer token on EVERY request — so a same-host process still needs read
// access to the token file. No LAN exposure by default: a TCP bind happens
// only when VELLUM_CONTROL_TCP is set explicitly, and the token stays required.

// ---------------------------------------------------------------------------
// Token: regenerate if missing, always chmod 600. Constant-time compare via
// sha256 digests so neither content nor length leaks through timing.

export const loadOrCreateToken = (tokenPath: string): string => {
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, "utf8").trim();
    if (token.length > 0) {
      chmodSync(tokenPath, 0o600);
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

export const listPageNodes = async (canvasesDir: string): Promise<ReadonlyArray<PageNodeRow>> => {
  await mkdir(canvasesDir, { recursive: true });
  const files = (await readdir(canvasesDir)).filter((f) => f.endsWith(".canvas"));
  const rows: PageNodeRow[] = [];
  for (const file of files.sort()) {
    try {
      const decoded = decodeCanvasDoc(JSON.parse(await readFile(join(canvasesDir, file), "utf8")));
      if (Either.isLeft(decoded)) continue;
      for (const node of decoded.right.nodes) {
        if (node.type !== "link" || node.ether?.entity?.kind !== "page") continue;
        rows.push({
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
  readonly version: string;
  readonly canvasesDir: string;
  readonly shotsDir: string;
}

export const makeControlHandlers = (deps: ControlDeps) => {
  const withBody =
    <A, I>(schema: Schema.Schema<A, I>, run: (input: A) => Promise<ControlEnvelope<unknown>>) =>
    async (body: unknown): Promise<ControlEnvelope<unknown>> => {
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

    "GET /pages": async () => controlOk(await listPageNodes(deps.canvasesDir)),

    "POST /open": withBody(OpenRequest, async (input) => {
      let profile = input.profile;
      if (profile === undefined) {
        const profiles = await deps.sessions.listProfiles();
        if (!profiles.ok) return fromResult(profiles);
        profile = profiles.data.find((p) => p.default)?.id ?? profiles.data[0]?.id;
        if (profile === undefined) return controlErr("invalid", "no browser profiles configured");
      }
      return fromResult(await deps.sessions.open({ nodeId: input.nodeId, url: input.url, profile }));
    }),

    // goto = navigate an EXISTING session (profile stays bound); open creates.
    "POST /goto": withBody(GotoRequest, async (input) => {
      const state = deps.sessions.state(input.nodeId);
      if (!state.ok) return fromResult(state);
      if (state.data === null) return controlErr("not_found", `no session for ${input.nodeId}`);
      return fromResult(
        await deps.sessions.open({
          nodeId: input.nodeId,
          url: input.url,
          profile: state.data.profile,
        }),
      );
    }),

    "POST /eval": withBody(EvalRequest, async (input) => {
      const result = await deps.sessions.eval(input.nodeId, input.code);
      // executeJavaScript can resolve to undefined — normalize to null so the
      // JSON envelope keeps an explicit `result` key.
      return result.ok ? controlOk({ result: result.data.result ?? null }) : fromResult(result);
    }),

    "POST /screenshot": withBody(ScreenshotRequest, async (input) => {
      if (input.path !== undefined && !isAbsolute(input.path)) {
        return controlErr("invalid", `screenshot path must be absolute: ${input.path}`);
      }
      const shot = await deps.sessions.screenshot(input.nodeId);
      if (!shot.ok) return fromResult(shot);
      const path =
        input.path ?? join(deps.shotsDir, `${input.nodeId}-${Date.now()}.png`);
      // nodeId is caller-controlled (canvas node.id, unrestricted) and flows
      // straight into the default path — `path.join` collapses `..` segments,
      // so a nodeId like "../../etc/pwned" would otherwise escape shotsDir.
      // Explicit `input.path` is a deliberate absolute override (checked
      // above) and is exempt; only the nodeId-derived default is confined.
      if (input.path === undefined) {
        const resolvedShotsDir = resolve(deps.shotsDir);
        const resolvedPath = resolve(path);
        if (resolvedPath !== resolvedShotsDir && !resolvedPath.startsWith(resolvedShotsDir + sep)) {
          return controlErr("invalid", `nodeId produces an unsafe default screenshot path: ${input.nodeId}`);
        }
      }
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, shot.data.png);
      } catch (error) {
        return controlErr("failed", error instanceof Error ? error.message : String(error));
      }
      return controlOk({ path, bytes: shot.data.png.byteLength });
    }),

    "POST /close": withBody(CloseRequest, async (input) =>
      fromResult(deps.sessions.close(input.nodeId)),
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

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(Symbol.for("vellum.control.badJson"));
      }
    });
    req.on("error", () => resolve(undefined));
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

/**
 * Start the control plane. Idempotent per app run; call close() on quit.
 * Unix socket only by default; VELLUM_CONTROL_TCP="host:port" adds an explicit
 * TCP bind (token still enforced on every request).
 */
export const startBrowserControlServer = (options: {
  readonly sessions: BrowserSessionService;
  readonly version: string;
  readonly home?: string;
  readonly env?: Record<string, string | undefined>;
}): BrowserControlServer => {
  const home = options.home ?? homedir();
  const dir = controlDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(controlShotsDir(home), { recursive: true });

  const token = loadOrCreateToken(controlTokenPath(home));
  const handlers = makeControlHandlers({
    sessions: options.sessions,
    version: options.version,
    canvasesDir: join(home, ".vellum", "canvases"),
    shotsDir: controlShotsDir(home),
  });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readBody(req);
      const respond = (status: number, envelope: ControlEnvelope<unknown>): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(envelope));
      };
      if (body === Symbol.for("vellum.control.badJson")) {
        return respond(400, controlErr("bad_request", "body is not valid JSON"));
      }
      try {
        const url = new URL(req.url ?? "/", "http://control.local");
        const { status, envelope } = await dispatchControlRequest(handlers, token, {
          method: req.method ?? "GET",
          path: url.pathname,
          token: bearerToken(req),
          body,
        });
        respond(status, envelope);
      } catch (error) {
        respond(
          500,
          controlErr("failed", error instanceof Error ? error.message : String(error)),
        );
      }
    })();
  });

  // Stale socket from a crashed run blocks listen — remove before binding.
  const socketPath = controlSocketPath(home);
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch (error) {
    console.error("[browser-control] failed to clear stale socket:", error);
  }
  server.listen(socketPath, () => {
    // Socket perms: owner-only, same posture as the token file.
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      // best-effort; the token gate still holds
    }
  });
  server.on("error", (error) => {
    console.error("[browser-control] server error:", error);
  });

  // Explicit LAN/TCP opt-in only — never bound by default.
  const tcp = (options.env ?? process.env)[CONTROL_TCP_ENV];
  let tcpServer: Server | undefined;
  if (tcp) {
    const [host, portRaw] = tcp.includes(":") ? [tcp.slice(0, tcp.lastIndexOf(":")), tcp.slice(tcp.lastIndexOf(":") + 1)] : ["127.0.0.1", tcp];
    const port = Number(portRaw);
    if (Number.isInteger(port) && port > 0) {
      tcpServer = createServer(server.listeners("request")[0] as (req: IncomingMessage, res: ServerResponse) => void);
      tcpServer.listen(port, host || "127.0.0.1");
      tcpServer.on("error", (error) => console.error("[browser-control] tcp error:", error));
      console.log(`[browser-control] explicit TCP bind on ${host || "127.0.0.1"}:${port} (token required)`);
    } else {
      console.error(`[browser-control] ignoring invalid ${CONTROL_TCP_ENV}=${tcp}`);
    }
  }

  return {
    socketPath,
    close: () => {
      server.close();
      tcpServer?.close();
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
      } catch {
        // socket file may already be gone
      }
    },
  };
};
