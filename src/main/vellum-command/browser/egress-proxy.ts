import { randomBytes } from "node:crypto";
import { connect as connectTcp, createServer, type Server, type Socket } from "node:net";
import {
  BROWSER_EGRESS_HEADER_MAX_BYTES,
  BROWSER_EGRESS_PRECONNECT_BUFFER_BYTES,
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

const headerValue = (headers: Map<string, string>, name: string): string | undefined =>
  headers.get(name.toLowerCase());

const parseHeaders = (raw: string): Map<string, string> | undefined => {
  const headers = new Map<string, string>();
  const lines = raw.split("\r\n");
  for (const line of lines) {
    if (line.length === 0) continue;
    const separator = line.indexOf(":");
    if (separator < 1) return undefined;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name.length === 0) return undefined;
    headers.set(name, value);
  }
  return headers;
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
    const upstreams = new Set<Socket>();
    let pendingConnects = 0;
    let closed = false;

    const authenticate = (headers: Map<string, string>): boolean => {
      const decoded = decodeBasic(headerValue(headers, "proxy-authorization"));
      return (
        decoded !== undefined &&
        decoded.username === credentials.username &&
        decoded.password === credentials.password
      );
    };

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
      upstreams.add(upstream);
      ignoreReset(client);
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

    const connectGranted = (host: string, port: number): Promise<Socket> =>
      new Promise((resolveConnect, rejectConnect) => {
        const socket = connectTcp({ host, port, family: 4 });
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
      return (await connectApprovedEndpoints(endpoints, decision.port, dial, signal)) as Socket;
    };

    const handleConnect = async (
      client: Socket,
      target: string,
      headers: Map<string, string>,
      rest: Buffer,
    ): Promise<void> => {
      const authority = parseConnectAuthority(target);
      if (authority === undefined) {
        deny(client);
        return;
      }
      if (headerValue(headers, "proxy-connection") === "upgrade") {
        deny(client);
        return;
      }
      const decision = classifyEgressAuthority(authority.host, authority.port, options.grant);
      if (decision.kind === "deny") {
        deny(client);
        return;
      }
      if (clients.size + pendingConnects > BROWSER_MAX_EGRESS_SOCKETS) {
        deny(client);
        return;
      }
      if (pendingConnects >= BROWSER_MAX_EGRESS_PENDING_CONNECTS) {
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
        if (rest.byteLength > 0) upstream.write(rest);
        pipe(client, upstream);
      } catch {
        if (!client.destroyed) deny(client);
      } finally {
        pendingConnects -= 1;
      }
    };

    const handleHttp = async (
      client: Socket,
      method: string,
      target: string,
      version: string,
      headers: Map<string, string>,
      rest: Buffer,
    ): Promise<void> => {
      if (method === "CONNECT-UDP") {
        deny(client);
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        deny(client);
        return;
      }
      if (parsed.protocol !== "http:") {
        deny(client);
        return;
      }
      const hostHeader = headerValue(headers, "host");
      if (hostHeader !== undefined) {
        const expected = parsed.host;
        if (hostHeader.toLowerCase() !== expected.toLowerCase()) {
          deny(client);
          return;
        }
      }
      const decision = classifyEgressHttpUrl(parsed.href, options.grant);
      if (decision.kind === "deny") {
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
        const path = `${parsed.pathname}${parsed.search}`;
        const forwarded: string[] = [`${method} ${path === "" ? "/" : path} ${version}`];
        forwarded.push(`Host: ${parsed.host}`);
        for (const [name, value] of headers) {
          if (HOP_BY_HOP.has(name) || name === "host") continue;
          forwarded.push(`${name}: ${value}`);
        }
        forwarded.push("");
        upstream.write(`${forwarded.join("\r\n")}\r\n`);
        if (rest.byteLength > 0) upstream.write(rest);
        pipe(client, upstream);
      } catch {
        if (!client.destroyed) deny(client);
      } finally {
        pendingConnects -= 1;
      }
    };

    const onClient = (client: Socket): void => {
      client.on("error", () => client.destroy());
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
      client.once("error", () => client.destroy());

      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.byteLength > BROWSER_EGRESS_HEADER_MAX_BYTES + BROWSER_EGRESS_PRECONNECT_BUFFER_BYTES) {
          client.destroy();
          return;
        }
        const separator = buffer.indexOf("\r\n\r\n");
        if (separator < 0) {
          if (buffer.byteLength > BROWSER_EGRESS_HEADER_MAX_BYTES) client.destroy();
          return;
        }
        const head = buffer.subarray(0, separator).toString("latin1");
        const rest = buffer.subarray(separator + 4);
        if (rest.byteLength > BROWSER_EGRESS_PRECONNECT_BUFFER_BYTES) {
          client.destroy();
          return;
        }
        client.off("data", onData);
        const [requestLine, ...headerLines] = head.split("\r\n");
        const parts = requestLine?.split(" ") ?? [];
        if (parts.length < 3) {
          deny(client);
          return;
        }
        const [method = "", target = "", version = ""] = parts;
        const headers = parseHeaders(headerLines.join("\r\n"));
        if (headers === undefined) {
          deny(client);
          return;
        }
        if (!authenticate(headers)) {
          challenge(client);
          return;
        }
        if (method.toUpperCase() === "CONNECT") {
          void handleConnect(client, target, headers, rest);
          return;
        }
        void handleHttp(client, method, target, version, headers, rest);
      };
      client.on("data", onData);
    };

    const server: Server = createServer({ allowHalfOpen: false }, onClient);
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
