import { randomBytes } from "node:crypto";
import {
  createServer as createHttpServer,
  request as createUpstreamRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import {
  BROWSER_MAX_EGRESS_PENDING_CONNECTS,
  BROWSER_MAX_EGRESS_SOCKETS,
} from "@shared/browser-limits";
import type { BrowserTestOnlyExactOriginGrant } from "./web-policy";
import {
  classifyEgressAuthority,
  classifyEgressHttpUrl,
  connectApprovedEndpoints,
  createBoundedHostResolver,
  type ApprovedEgressEndpoint,
  type DialApprovedEndpoint,
  type EgressDialBudget,
  type EgressSocket,
  type ResolveEgressHost,
} from "./egress-policy";

export interface BrowserEgressProxyCredentials {
  readonly username: string;
  readonly password: string;
  readonly realm: string;
}

export interface BrowserEgressProxyHandle {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly credentials: BrowserEgressProxyCredentials;
  readonly proxyRules: string;
  readonly proxyBypassRules: "<-loopback>";
  readonly close: () => Promise<void>;
}

export interface BrowserEgressProxyOptions {
  readonly resolveHost: ResolveEgressHost;
  readonly grant?: BrowserTestOnlyExactOriginGrant;
  readonly dial?: DialApprovedEndpoint;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const decodeBasic = (header: string | undefined): { username: string; password: string } | undefined => {
  if (header === undefined) return undefined;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/u.exec(header.trim());
  if (match === null) return undefined;
  try {
    const decoded = Buffer.from(match[1] ?? "", "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return undefined;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return undefined;
  }
};

const headerString = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
};

const parseConnectAuthority = (
  target: string,
): { readonly host: string; readonly port: number } | undefined => {
  if (target.startsWith("[")) {
    const end = target.indexOf("]");
    if (end < 2) return undefined;
    const suffix = target.slice(end + 1);
    if (!/^:[0-9]+$/u.test(suffix)) return undefined;
    return { host: target.slice(1, end), port: Number(suffix.slice(1)) };
  }
  const colon = target.lastIndexOf(":");
  if (colon < 1) return undefined;
  const port = Number(target.slice(colon + 1));
  if (!Number.isInteger(port)) return undefined;
  return { host: target.slice(0, colon), port };
};

const writeHead = (socket: Socket, status: number, extra: ReadonlyArray<string> = []): void => {
  const reason =
    status === 200
      ? "Connection Established"
      : status === 407
        ? "Proxy Authentication Required"
        : status === 403
          ? "Forbidden"
          : "Bad Request";
  socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\n${extra.join("\r\n")}${extra.length > 0 ? "\r\n" : ""}\r\n`);
};

const defaultDial: DialApprovedEndpoint = (endpoint, port, signal) =>
  new Promise((resolve, reject) => {
    const socket = connectTcp({
      host: endpoint.address,
      port,
      family: endpoint.family === "ipv6" ? 6 : 4,
    });
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    const onAbort = (): void => fail(new Error("egress connect aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      fail(error instanceof Error ? error : new Error("egress connect failed"));
    });
    socket.once("connect", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(socket);
    });
  });

const requestTargetPath = (parsed: URL): string => {
  const path = `${parsed.pathname}${parsed.search}`;
  return path === "" ? "/" : path;
};

/**
 * Request headers for the origin: hop-by-hop and proxy headers never leave the
 * proxy, and the Host header is the absolute-form URL authority. When the
 * client sent a chunked body the parsed stream is decoded, so any stale
 * content-length framing is dropped and node:http re-frames the body itself.
 */
const forwardRequestHeaders = (
  headers: IncomingHttpHeaders,
  hostAuthority: string,
): OutgoingHttpHeaders => {
  const connectionTokens = new Set(
    headerString(headers, "connection")
      ?.split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean) ?? [],
  );
  const chunked = headers["transfer-encoding"] !== undefined;
  const forwarded: OutgoingHttpHeaders = { Host: hostAuthority };
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "host" || HOP_BY_HOP.has(lower) || connectionTokens.has(lower)) continue;
    if (lower === "content-length" && chunked) continue;
    forwarded[name] = value;
  }
  return forwarded;
};

const forwardResponseHeaders = (headers: IncomingHttpHeaders): OutgoingHttpHeaders => {
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    forwarded[name] = value;
  }
  return forwarded;
};

export const startBrowserEgressProxy = (
  options: BrowserEgressProxyOptions,
): Promise<BrowserEgressProxyHandle> =>
  new Promise((resolve, reject) => {
    const credentials: BrowserEgressProxyCredentials = {
      username: `vellum-${randomBytes(8).toString("hex")}`,
      password: randomBytes(18).toString("base64url"),
      realm: `vellum-browser-${randomBytes(8).toString("hex")}`,
    };
    const resolveHost = createBoundedHostResolver(options.resolveHost);
    const dial = options.dial ?? defaultDial;
    const clients = new Set<Socket>();
    const upstreams = new Set<EgressSocket>();
    let inflightDials = 0;
    let pendingConnects = 0;
    let closed = false;

    const authenticate = (headers: IncomingHttpHeaders): boolean => {
      const decoded = decodeBasic(headerString(headers, "proxy-authorization"));
      return (
        decoded !== undefined &&
        decoded.username === credentials.username &&
        decoded.password === credentials.password
      );
    };

    // Outbound socket budget: every dialing or connected upstream socket is
    // charged from the moment it exists until it closes.
    const canChargeUpstream = (): boolean =>
      !closed && upstreams.size + inflightDials < BROWSER_MAX_EGRESS_SOCKETS;

    const trackUpstream = (socket: EgressSocket): void => {
      if (socket.destroyed) return;
      upstreams.add(socket);
      const release = (): void => {
        upstreams.delete(socket);
      };
      if (typeof (socket as Socket).once === "function") {
        (socket as Socket).once("close", release);
        (socket as Socket).once("error", () => {
          if (!socket.destroyed) socket.destroy();
        });
      }
    };

    // Dial wrapper: refuses when the egress budget is exhausted and charges
    // the attempt from dial start until the returned socket closes.
    const chargedDial: DialApprovedEndpoint = async (endpoint, port, signal) => {
      if (!canChargeUpstream()) throw new Error("egress socket budget exhausted");
      inflightDials += 1;
      try {
        const socket = await dial(endpoint, port, signal);
        trackUpstream(socket);
        return socket;
      } finally {
        inflightDials -= 1;
      }
    };

    const denyDialBudget: EgressDialBudget = () => canChargeUpstream();

    const challenge = (client: Socket): void => {
      writeHead(client, 407, [
        `Proxy-Authenticate: Basic realm="${credentials.realm}"`,
        "Connection: close",
      ]);
      client.end();
    };

    const deny = (client: Socket): void => {
      writeHead(client, 403, ["Connection: close"]);
      client.end();
    };

    const ignoreReset = (socket: Socket): void => {
      socket.on("error", () => socket.destroy());
    };

    const pipe = (client: Socket, upstream: Socket): void => {
      trackUpstream(upstream);
      ignoreReset(upstream);
      const drop = (): void => {
        upstreams.delete(upstream);
        if (!upstream.destroyed) upstream.destroy();
        if (!client.destroyed) client.destroy();
      };
      client.on("close", drop);
      upstream.on("close", drop);
      client.pipe(upstream);
      upstream.pipe(client);
    };

    // Test-only exact-origin grant path (127.0.0.1:<ephemeral> fixtures).
    const connectGranted = (host: string, port: number): Promise<Socket> =>
      new Promise((resolveConnect, rejectConnect) => {
        if (!canChargeUpstream()) {
          rejectConnect(new Error("egress socket budget exhausted"));
          return;
        }
        const socket = connectTcp({ host, port, family: 4 });
        trackUpstream(socket);
        socket.once("error", rejectConnect);
        socket.once("connect", () => resolveConnect(socket));
      });

    const connectDestination = async (
      decision: Exclude<ReturnType<typeof classifyEgressAuthority>, { kind: "deny" }>,
      signal: AbortSignal,
    ): Promise<Socket> => {
      if (decision.kind === "grant") return connectGranted(decision.host, decision.port);
      const endpoints: ReadonlyArray<ApprovedEgressEndpoint> =
        decision.kind === "literal"
          ? [decision.endpoint]
          : ((await resolveHost(decision.hostname)) ?? []);
      if (endpoints.length === 0) throw new Error("dns");
      return (await connectApprovedEndpoints(
        endpoints,
        decision.port,
        chargedDial,
        signal,
        denyDialBudget,
      )) as Socket;
    };

    // Admission gate for a logical destination connect, shared by CONNECT and
    // plain HTTP so both paths are bounded before DNS or dialing begins.
    const admitDestination = (): boolean =>
      !closed &&
      pendingConnects < BROWSER_MAX_EGRESS_PENDING_CONNECTS &&
      upstreams.size + inflightDials < BROWSER_MAX_EGRESS_SOCKETS;

    const handleTunnel = async (
      client: Socket,
      request: IncomingMessage,
      head: Buffer,
    ): Promise<void> => {
      const authority = parseConnectAuthority(request.url ?? "");
      if (authority === undefined) {
        deny(client);
        return;
      }
      if (headerString(request.headers, "proxy-connection")?.toLowerCase() === "upgrade") {
        deny(client);
        return;
      }
      const decision = classifyEgressAuthority(authority.host, authority.port, options.grant);
      if (decision.kind === "deny") {
        deny(client);
        return;
      }
      if (!admitDestination()) {
        deny(client);
        return;
      }
      pendingConnects += 1;
      const controller = new AbortController();
      client.once("close", () => controller.abort());
      try {
        const upstream = await connectDestination(decision, controller.signal);
        if (client.destroyed || closed) {
          upstream.destroy();
          return;
        }
        writeHead(client, 200);
        if (head.byteLength > 0) upstream.write(head);
        pipe(client, upstream);
      } catch {
        if (!client.destroyed) deny(client);
      } finally {
        pendingConnects -= 1;
      }
    };

    const respondUnavailable = (
      res: ServerResponse,
      status: number,
      proxyAuthenticate?: string,
    ): void => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const headers: OutgoingHttpHeaders = { Connection: "close" };
      if (proxyAuthenticate !== undefined) headers["Proxy-Authenticate"] = proxyAuthenticate;
      res.writeHead(status, headers);
      res.end();
    };

    const forwardRequest = (
      request: IncomingMessage,
      res: ServerResponse,
      parsed: URL,
      port: number,
      upstream: Socket,
    ): void => {
      const upstreamRequest = createUpstreamRequest({
        host: parsed.hostname,
        port,
        method: request.method,
        path: requestTargetPath(parsed),
        headers: forwardRequestHeaders(request.headers, parsed.host),
        createConnection: (_options, callback) => {
          callback(null, upstream);
          return upstream;
        },
      });
      upstreamRequest.on("socket", (socket) => {
        socket.setNoDelay(true);
      });
      request.on("error", () => {
        upstreamRequest.destroy();
        if (!res.writableEnded) res.destroy();
      });
      res.on("error", () => {
        upstreamRequest.destroy();
      });
      upstreamRequest.on("error", () => {
        if (res.writableEnded || res.destroyed) return;
        if (res.headersSent) {
          res.destroy();
          return;
        }
        respondUnavailable(res, 502);
      });
      upstreamRequest.on("response", (upstreamResponse) => {
        upstreamResponse.on("error", () => {
          upstreamRequest.destroy();
          if (!res.writableEnded) res.destroy();
        });
        if (res.destroyed || res.writableEnded) {
          upstreamResponse.destroy();
          return;
        }
        res.writeHead(
          upstreamResponse.statusCode ?? 502,
          forwardResponseHeaders(upstreamResponse.headers),
        );
        res.on("finish", () => {
          if (!upstream.destroyed) upstream.destroy();
        });
        upstreamResponse.pipe(res);
      });
      // The parsed request body streams (and re-frames) only after the
      // upstream dial completed; nothing is consumed from the socket before
      // that, so bytes that arrive during DNS/connect are buffered, not lost.
      request.pipe(upstreamRequest);
    };

    const handleProxyRequest = async (
      request: IncomingMessage,
      res: ServerResponse,
    ): Promise<void> => {
      const method = (request.method ?? "").toUpperCase();
      // Tunnelling and MASQUE methods must never take the plain-HTTP
      // forwarding path; CONNECT is handled by the dedicated listener.
      if (method === "CONNECT" || method === "CONNECT-UDP") {
        respondUnavailable(res, 403);
        return;
      }
      if (!authenticate(request.headers)) {
        respondUnavailable(res, 407, `Basic realm="${credentials.realm}"`);
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(request.url ?? "");
      } catch {
        respondUnavailable(res, 403);
        return;
      }
      if (parsed.protocol !== "http:") {
        respondUnavailable(res, 403);
        return;
      }
      const hostHeader = request.headers.host;
      if (hostHeader !== undefined) {
        if (typeof hostHeader !== "string" || hostHeader.trim().toLowerCase() !== parsed.host.toLowerCase()) {
          respondUnavailable(res, 403);
          return;
        }
      }
      const decision = classifyEgressHttpUrl(parsed.href, options.grant);
      if (decision.kind === "deny") {
        respondUnavailable(res, 403);
        return;
      }
      if (!admitDestination()) {
        respondUnavailable(res, 403);
        return;
      }
      pendingConnects += 1;
      const controller = new AbortController();
      res.once("close", () => controller.abort());
      try {
        const upstream = await connectDestination(decision, controller.signal);
        if (closed || request.destroyed || res.destroyed) {
          upstream.destroy();
          return;
        }
        forwardRequest(request, res, parsed, decision.port, upstream);
      } catch {
        respondUnavailable(res, 403);
      } finally {
        pendingConnects -= 1;
      }
    };

    const server = createHttpServer((request, res) => {
      void handleProxyRequest(request, res).catch(() => {
        if (res.writableEnded || res.destroyed) return;
        if (res.headersSent) res.destroy();
        else respondUnavailable(res, 403);
      });
    });
    server.on("connection", (client: Socket) => {
      ignoreReset(client);
      if (closed) {
        client.destroy();
        return;
      }
      if (clients.size >= BROWSER_MAX_EGRESS_SOCKETS) {
        client.destroy();
        return;
      }
      clients.add(client);
      client.once("close", () => clients.delete(client));
    });
    server.on("connect", (request, clientSocket, head) => {
      const client = clientSocket as Socket;
      if (!authenticate(request.headers)) {
        challenge(client);
        return;
      }
      void handleTunnel(client, request, head);
    });
    server.on("upgrade", (request, clientSocket) => {
      // Upgrades bypass per-request proxy authentication; fail closed.
      deny(clientSocket as Socket);
    });
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
        server.close();
        reject(new Error("browser egress proxy did not bind loopback"));
        return;
      }
      const handle: BrowserEgressProxyHandle = {
        host: "127.0.0.1",
        port: address.port,
        credentials,
        proxyRules: `127.0.0.1:${String(address.port)}`,
        proxyBypassRules: "<-loopback>",
        close: () =>
          new Promise((resolveClose) => {
            closed = true;
            for (const socket of clients) socket.destroy();
            for (const socket of upstreams) socket.destroy();
            server.close(() => resolveClose());
          }),
      };
      resolve(handle);
    });
  });
