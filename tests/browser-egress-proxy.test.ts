import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { startBrowserEgressProxy } from "../src/main/junto/browser/egress-proxy";
import {
  BROWSER_MAX_EGRESS_PENDING_CONNECTS,
  BROWSER_MAX_EGRESS_SOCKETS,
} from "../src/shared/browser-limits";
import type { ApprovedEgressEndpoint, DialApprovedEndpoint } from "../src/main/junto/browser/egress-policy";

const listen = (): Promise<{ port: number; close: () => Promise<void>; connections: Socket[] }> =>
  new Promise((resolve, reject) => {
    const connections: Socket[] = [];
    const server = createServer((socket) => {
      connections.push(socket);
      socket.on("error", () => socket.destroy());
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
      socket.end();
    });
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        connections,
        close: () =>
          new Promise((done) => {
            for (const socket of connections) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });

interface CapturedRequest {
  readonly head: string;
  readonly body: string;
}

// Raw origin stand-in that never replies before it has read a complete
// request, so tests capture the actual upstream bytes the proxy sent.
const captureOrigin = (): Promise<{
  port: number;
  requests: CapturedRequest[];
  connections: Socket[];
  close: () => Promise<void>;
}> =>
  new Promise((resolve, reject) => {
    const requests: CapturedRequest[] = [];
    const connections: Socket[] = [];
    const server = createServer((socket) => {
      connections.push(socket);
      socket.on("error", () => socket.destroy());
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const separator = buffer.indexOf("\r\n\r\n");
          if (separator < 0) return;
          const head = buffer.subarray(0, separator).toString("latin1");
          const contentLength = Number(/content-length:\s*(\d+)/iu.exec(head)?.[1] ?? 0);
          const total = separator + 4 + contentLength;
          if (buffer.byteLength < total) return;
          const body = buffer.subarray(separator + 4, total).toString("latin1");
          buffer = buffer.subarray(total);
          requests.push({ head, body });
          socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        }
      });
    });
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        requests,
        connections,
        close: () =>
          new Promise((done) => {
            for (const socket of connections) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });

interface ProxyResponse {
  readonly status: number;
  readonly head: string;
  readonly body: string;
}

// Raw proxy client that keeps one TCP connection open and parses each HTTP
// response as it arrives, so keep-alive request sequences can be driven.
class ProxyClient {
  private readonly socket: Socket;
  private buffer = Buffer.alloc(0);
  private readonly settled: ProxyResponse[] = [];
  private readonly waiters: Array<{ resolve: (response: ProxyResponse) => void; reject: (error: Error) => void }> = [];

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on("close", () => {
      for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("proxy closed the connection"));
    });
  }

  static open = (port: number): Promise<ProxyClient> =>
    new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("error", reject);
      socket.once("connect", () => resolve(new ProxyClient(socket)));
    });

  private drain = (): void => {
    for (;;) {
      const separator = this.buffer.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const head = this.buffer.subarray(0, separator).toString("latin1");
      const contentLength = Number(/content-length:\s*(\d+)/iu.exec(head)?.[1] ?? 0);
      const total = separator + 4 + contentLength;
      if (this.buffer.byteLength < total) return;
      const body = this.buffer.subarray(separator + 4, total).toString("latin1");
      this.buffer = this.buffer.subarray(total);
      const response: ProxyResponse = {
        status: Number(/^HTTP\/1\.[01] (\d+)/u.exec(head)?.[1] ?? 0),
        head,
        body,
      };
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter.resolve(response);
      else this.settled.push(response);
    }
  };

  send = (text: string): void => {
    this.socket.write(text, "latin1");
  };

  nextResponse = (): Promise<ProxyResponse> => {
    const settled = this.settled.shift();
    if (settled !== undefined) return Promise.resolve(settled);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  };

  close = (): Promise<void> =>
    new Promise((done) => {
      if (this.socket.destroyed) {
        done();
        return;
      }
      this.socket.once("close", () => done());
      this.socket.destroy();
    });
}

const proxyRequest = (
  port: number,
  request: string,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let data = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error !== undefined) reject(error);
      else {
        const status = Number(/^HTTP\/1\.[01] (\d+)/u.exec(data)?.[1] ?? 0);
        resolve({ status, body: data });
      }
    };
    socket.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") {
        finish();
        return;
      }
      finish(error);
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      if (data.includes("\r\n\r\n")) {
        socket.end();
        finish();
      }
    });
    socket.on("end", () => finish());
    socket.on("close", () => finish());
    socket.write(request);
  });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const dialStandIn = (
  endpoint: ApprovedEgressEndpoint,
  targetPort: number,
  signal: AbortSignal,
): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: targetPort });
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    const onAbort = (): void => fail(new Error("dial aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      fail(error instanceof Error ? error : new Error("dial failed"));
    });
    socket.once("connect", () => {
      // The abort listener must not outlive the connected socket, or the
      // post-win abort in connectApprovedEndpoints would destroy the winner.
      signal.removeEventListener("abort", onAbort);
      Object.defineProperty(socket, "remoteAddress", { value: endpoint.address });
      resolve(socket);
    });
  });

const basicAuth = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

const largeAddressBatch: ApprovedEgressEndpoint[] = [
  ...Array.from({ length: 12 }, (_, index) => ({
    address: `93.184.216.${String(10 + index)}`,
    family: "ipv4" as const,
  })),
  ...Array.from({ length: 12 }, (_, index) => ({
    address: `2606:4700:4700::${(10 + index).toString(16)}`,
    family: "ipv6" as const,
  })),
];

interface BurstObservation {
  readonly peakDials: number;
  readonly statusCounts: Map<number, number>;
}

// Fires many concurrent proxied requests against a large approved A/AAAA
// batch while every numeric dial is held, then releases them and reports the
// peak number of simultaneous dials plus the response status distribution.
const runHeldDialBurst = async (kind: "http" | "connect"): Promise<BurstObservation> => {
  const origin = await captureOrigin();
  let liveDials = 0;
  let peakDials = 0;
  const held: Array<() => void> = [];
  const dial: DialApprovedEndpoint = async (endpoint, _port, signal) => {
    liveDials += 1;
    peakDials = Math.max(peakDials, liveDials);
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const onAbort = (): void => reject(new Error("dial aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        held.push(() => {
          signal.removeEventListener("abort", onAbort);
          dialStandIn(endpoint, origin.port, signal).then(resolve, reject);
        });
      });
    } finally {
      liveDials -= 1;
    }
  };
  const proxy = await startBrowserEgressProxy({
    resolveHost: async () => ({ endpoints: largeAddressBatch }),
    dial,
  });
  const auth = basicAuth(proxy.credentials.username, proxy.credentials.password);
  const clients = await Promise.all(
    Array.from({ length: 40 }, () => ProxyClient.open(proxy.port)),
  );
  try {
    const requestLines = clients.map((_, index) =>
      kind === "http"
        ? `GET http://budget.example.net/p/${String(index)} HTTP/1.1\r\nHost: budget.example.net\r\nProxy-Authorization: ${auth}\r\n\r\n`
        : `CONNECT budget.example.net:80 HTTP/1.1\r\nHost: budget.example.net:80\r\nProxy-Authorization: ${auth}\r\n\r\n`,
    );
    const responses = clients.map((client) => client.nextResponse());
    for (const [index, client] of clients.entries()) client.send(requestLines[index] ?? "");
    // Let the Happy Eyeballs stagger open the second dial per connect attempt.
    await sleep(700);
    const observedPeak = peakDials;
    for (const release of held.splice(0)) release();
    const settledResponses = await Promise.all(responses);
    const statusCounts = new Map<number, number>();
    for (const response of settledResponses) {
      statusCounts.set(response.status, (statusCounts.get(response.status) ?? 0) + 1);
    }
    return { peakDials: observedPeak, statusCounts };
  } finally {
    for (const release of held.splice(0)) release();
    for (const client of clients) await client.close();
    await proxy.close();
    await origin.close();
  }
};

describe("browser egress proxy pinning", () => {
  it("authenticates before DNS and dials only the approved numeric IP", async () => {
    const publicStandIn = await listen();
    const loopbackSentinel = await listen();
    const hostnameLookups: string[] = [];
    const dialed: string[] = [];
    const resolveHost = async (hostname: string) => {
      hostnameLookups.push(hostname);
      return { endpoints: [{ address: "93.184.216.34", family: "ipv4" as const }] };
    };
    const proxy = await startBrowserEgressProxy({
      resolveHost,
      dial: async (endpoint: ApprovedEgressEndpoint, port, signal) => {
        if (endpoint.address === "example.com") {
          throw new Error("hostname must never reach the connector");
        }
        dialed.push(`${endpoint.address}:${String(port)}`);
        return dialStandIn(endpoint, publicStandIn.port, signal);
      },
    });
    const auth = basicAuth(proxy.credentials.username, proxy.credentials.password);

    const unauthenticated = await proxyRequest(
      proxy.port,
      "CONNECT example.com:80 HTTP/1.1\r\nHost: example.com:80\r\n\r\n",
    );
    expect(unauthenticated.status).toBe(407);
    expect(hostnameLookups).toEqual([]);

    const connected = await proxyRequest(
      proxy.port,
      `CONNECT example.com:80 HTTP/1.1\r\nHost: example.com:80\r\nProxy-Authorization: ${auth}\r\n\r\n`,
    );
    expect(connected.status).toBe(200);
    expect(hostnameLookups).toEqual(["example.com"]);
    expect(dialed).toEqual(["93.184.216.34:80"]);
    expect(publicStandIn.connections.length).toBeGreaterThan(0);
    expect(loopbackSentinel.connections).toHaveLength(0);

    await proxy.close();
    await publicStandIn.close();
    await loopbackSentinel.close();
  });

  it("runs the rebinding filter: an admitted hostname resolving to a private answer is denied", async () => {
    const loopbackSentinel = await listen();
    const hostnameLookups: string[] = [];
    let dialCalls = 0;
    const proxy = await startBrowserEgressProxy({
      resolveHost: async (hostname) => {
        hostnameLookups.push(hostname);
        return { endpoints: [{ address: "127.0.0.1", family: "ipv4" }] };
      },
      dial: async () => {
        dialCalls += 1;
        throw new Error("private resolution must not dial");
      },
    });
    const auth = basicAuth(proxy.credentials.username, proxy.credentials.password);
    const denied = await proxyRequest(
      proxy.port,
      `CONNECT rebound.example.net:80 HTTP/1.1\r\nHost: rebound.example.net:80\r\nProxy-Authorization: ${auth}\r\n\r\n`,
    );
    expect(denied.status).toBe(403);
    expect(hostnameLookups).toEqual(["rebound.example.net"]);
    expect(dialCalls).toBe(0);
    expect(loopbackSentinel.connections).toHaveLength(0);
    await proxy.close();
    await loopbackSentinel.close();
  });

  it("re-authenticates and sanitizes every keep-alive request before any upstream byte", async () => {
    const origin = await captureOrigin();
    const proxy = await startBrowserEgressProxy({
      resolveHost: async () => ({ endpoints: [{ address: "93.184.216.34", family: "ipv4" }] }),
      dial: async (endpoint, _port, signal) => dialStandIn(endpoint, origin.port, signal),
    });
    const auth = basicAuth(proxy.credentials.username, proxy.credentials.password);
    const client = await ProxyClient.open(proxy.port);

    client.send(
      `GET http://example.com/one HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: ${auth}\r\nProxy-Connection: keep-alive\r\n\r\n`,
    );
    const first = await client.nextResponse();
    expect(first.status).toBe(200);

    // Second request on the same client TCP connection: the proxy must
    // authenticate and sanitize it again, not relay stored credentials.
    client.send(
      `GET http://example.com/two HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: ${auth}\r\nX-Test: keep\r\n\r\n`,
    );
    const second = await client.nextResponse();
    expect(second.status).toBe(200);
    await client.close();

    expect(origin.requests).toHaveLength(2);
    for (const request of origin.requests) {
      expect(request.head).toMatch(/^GET \/(one|two) HTTP\/1\.1\r\n/);
      expect(request.head).toContain("Host: example.com\r\n");
      expect(request.head.toLowerCase()).not.toContain("proxy-authorization");
      expect(request.head.toLowerCase()).not.toContain("proxy-connection");
      expect(request.head).not.toContain(proxy.credentials.password);
      expect(request.head).not.toContain("vellum-");
    }
    // node:http normalizes forwarded header names to lower case.
    expect(origin.requests[0]?.head.toLowerCase()).not.toContain("x-test");
    expect(origin.requests[1]?.head.toLowerCase()).toContain("x-test: keep\r\n");
    await proxy.close();
    await origin.close();
  });

  it("forwards the origin-form path with the URL-authority Host header and no proxy headers", async () => {
    const origin = await captureOrigin();
    const proxy = await startBrowserEgressProxy({
      resolveHost: async () => ({ endpoints: [{ address: "93.184.216.34", family: "ipv4" }] }),
      dial: async (endpoint, _port, signal) => dialStandIn(endpoint, origin.port, signal),
    });
    const auth = basicAuth(proxy.credentials.username, proxy.credentials.password);
    const client = await ProxyClient.open(proxy.port);
    client.send(
      `GET http://example.com/path?q=1 HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: ${auth}\r\nX-Test: keep\r\nProxy-Connection: keep-alive\r\n\r\n`,
    );
    const response = await client.nextResponse();
    expect(response.status).toBe(200);
    await client.close();

    expect(origin.requests).toHaveLength(1);
    const request = origin.requests[0];
    expect(request?.head.startsWith("GET /path?q=1 HTTP/1.1\r\n")).toBe(true);
    expect(request?.head).toContain("Host: example.com\r\n");
    // node:http normalizes forwarded header names to lower case.
    expect(request?.head.toLowerCase()).toContain("x-test: keep\r\n");
    expect(request?.head.toLowerCase()).not.toContain("proxy-authorization");
    expect(request?.head.toLowerCase()).not.toContain("proxy-connection");
    expect(request?.head).not.toContain(proxy.credentials.password);
    await proxy.close();
    await origin.close();
  });

  it("streams request bodies that arrive while the destination dial is pending", async () => {
    const origin = await captureOrigin();
    let releaseDial!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDial = resolve;
    });
    let dialStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      dialStarted = resolve;
    });
    const proxy = await startBrowserEgressProxy({
      resolveHost: async () => ({ endpoints: [{ address: "93.184.216.34", family: "ipv4" }] }),
      dial: async (endpoint, _port, signal) => {
        dialStarted();
        await gate;
        return dialStandIn(endpoint, origin.port, signal);
      },
    });
    const auth = basicAuth(proxy.credentials.username, proxy.credentials.password);
    const client = await ProxyClient.open(proxy.port);
    client.send(
      `POST http://example.com/upload HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: ${auth}\r\nContent-Length: 5\r\n\r\n`,
    );
    await started;
    // The body arrives only after the request head and while the dial is held.
    client.send("hello");
    await sleep(100);
    releaseDial();
    const response = await client.nextResponse();
    expect(response.status).toBe(200);
    await client.close();

    expect(origin.requests).toHaveLength(1);
    const request = origin.requests[0];
    expect(request?.head.startsWith("POST /upload HTTP/1.1\r\n")).toBe(true);
    expect(request?.head).toContain("Host: example.com\r\n");
    expect(request?.head.toLowerCase()).not.toContain("proxy-authorization");
    expect(request?.body).toBe("hello");
    await proxy.close();
    await origin.close();
  });

  it("caps pending logical HTTP connects and simultaneous dials at the egress socket budget", async () => {
    const { peakDials, statusCounts } = await runHeldDialBurst("http");
    // Every dialing or connected upstream socket is charged, so the fan-out
    // from one large A/AAAA batch can never exceed the egress socket budget.
    expect(peakDials).toBeLessThanOrEqual(BROWSER_MAX_EGRESS_SOCKETS);
    expect(peakDials).toBeGreaterThanOrEqual(BROWSER_MAX_EGRESS_PENDING_CONNECTS);
    // At most BROWSER_MAX_EGRESS_PENDING_CONNECTS logical connects may be in
    // flight; the surplus is denied before any DNS or dialing happens.
    expect(statusCounts.get(200)).toBe(BROWSER_MAX_EGRESS_PENDING_CONNECTS);
    expect(statusCounts.get(403)).toBe(40 - BROWSER_MAX_EGRESS_PENDING_CONNECTS);
    expect(statusCounts.size).toBe(2);
  }, 20_000);

  it("caps pending logical CONNECT tunnels and simultaneous dials at the egress socket budget", async () => {
    const { peakDials, statusCounts } = await runHeldDialBurst("connect");
    expect(peakDials).toBeLessThanOrEqual(BROWSER_MAX_EGRESS_SOCKETS);
    expect(peakDials).toBeGreaterThanOrEqual(BROWSER_MAX_EGRESS_PENDING_CONNECTS);
    expect(statusCounts.get(200)).toBe(BROWSER_MAX_EGRESS_PENDING_CONNECTS);
    expect(statusCounts.get(403)).toBe(40 - BROWSER_MAX_EGRESS_PENDING_CONNECTS);
    expect(statusCounts.size).toBe(2);
  }, 20_000);

  it("forwards HTTP origin-form with the original Host header", async () => {
    const upstream = await listen();
    const proxy = await startBrowserEgressProxy({
      resolveHost: async () => ({ endpoints: [{ address: "1.1.1.1", family: "ipv4" }] }),
      dial: async (endpoint, _port, signal) => dialStandIn(endpoint, upstream.port, signal),
    });
    const auth = basicAuth(proxy.credentials.username, proxy.credentials.password);
    const response = await proxyRequest(
      proxy.port,
      `GET http://example.com/path?q=1 HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: ${auth}\r\nX-Test: keep\r\nProxy-Connection: keep-alive\r\n\r\n`,
    );
    expect(response.status).toBe(200);
    await proxy.close();
    await upstream.close();
  });
});
