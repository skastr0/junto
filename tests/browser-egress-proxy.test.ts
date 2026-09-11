import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { startBrowserEgressProxy } from "../src/main/vellum-command/browser/egress-proxy";
import type { ApprovedEgressEndpoint } from "../src/main/vellum-command/browser/egress-policy";

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
        return new Promise((resolve, reject) => {
          const socket = connect({ host: "127.0.0.1", port: publicStandIn.port });
          const fail = (error: Error): void => {
            socket.destroy();
            reject(error);
          };
          signal.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
          socket.once("error", (error) => fail(error instanceof Error ? error : new Error("dial")));
          socket.once("connect", () => {
            Object.defineProperty(socket, "remoteAddress", { value: endpoint.address });
            resolve(socket);
          });
        });
      },
    });
    const auth = `Basic ${Buffer.from(`${proxy.credentials.username}:${proxy.credentials.password}`).toString("base64")}`;

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

    const privateLookup = await startBrowserEgressProxy({
      resolveHost: async () => ({ endpoints: [{ address: "127.0.0.1", family: "ipv4" }] }),
      dial: async () => {
        throw new Error("private resolution must not dial");
      },
    });
    const denied = await proxyRequest(
      privateLookup.port,
      `CONNECT rebound.example:80 HTTP/1.1\r\nHost: rebound.example:80\r\nProxy-Authorization: Basic ${Buffer.from(`${privateLookup.credentials.username}:${privateLookup.credentials.password}`).toString("base64")}\r\n\r\n`,
    );
    expect(denied.status).toBe(403);
    expect(loopbackSentinel.connections).toHaveLength(0);

    await proxy.close();
    await privateLookup.close();
    await publicStandIn.close();
    await loopbackSentinel.close();
  });

  it("forwards HTTP origin-form with the original Host header", async () => {
    const upstream = await listen();
    const proxy = await startBrowserEgressProxy({
      resolveHost: async () => ({ endpoints: [{ address: "1.1.1.1", family: "ipv4" }] }),
      dial: async (endpoint) =>
        new Promise((resolve, reject) => {
          const socket = connect({ host: "127.0.0.1", port: upstream.port });
          socket.once("error", reject);
          socket.once("connect", () => {
            Object.defineProperty(socket, "remoteAddress", { value: endpoint.address });
            resolve(socket);
          });
        }),
    });
    const auth = `Basic ${Buffer.from(`${proxy.credentials.username}:${proxy.credentials.password}`).toString("base64")}`;
    const response = await proxyRequest(
      proxy.port,
      `GET http://example.com/path?q=1 HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: ${auth}\r\nX-Test: keep\r\nProxy-Connection: keep-alive\r\n\r\n`,
    );
    expect(response.status).toBe(200);
    await proxy.close();
    await upstream.close();
  });
});
