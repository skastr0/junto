import { lstat, mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import {
  OPERATOR_PROTOCOL_VERSION,
  decodeOperatorResponse,
  encodeOperatorFrame,
  type OperatorRequestEnvelope,
  type OperatorResponseEnvelope,
} from "../src/shared/operator-control";
import { STATION_API_PROTOCOL } from "../src/shared/station-api";
import {
  appendAndWipeOperatorBytes,
  startOperatorControlServer,
  type OperatorControlServer,
  type OperatorControlServerRuntime,
} from "../src/main/vellum/operator-control";
import type { ProcessIdentityMap } from "../src/main/vellum/process-identity";
import { Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
const servers: OperatorControlServer[] = [];

const emptyProcessMap = {
  snapshot: () => [],
} as unknown as ProcessIdentityMap;

const admittedRuntime: OperatorControlServerRuntime = {
  admission: {
    processMap: emptyProcessMap,
    readPeerPid: () => 410,
    readParentPid: (pid: number) => (pid === 410 ? 1 : undefined),
  },
};

const statusRequest = (id = "status-1"): OperatorRequestEnvelope => ({
  protocol: OPERATOR_PROTOCOL_VERSION,
  id,
  op: "station.status",
  args: {},
});

const statusResponse = (
  request: OperatorRequestEnvelope,
): OperatorResponseEnvelope => {
  const decoded = decodeOperatorResponse({
    protocol: OPERATOR_PROTOCOL_VERSION,
    id: request.id,
    ok: true,
    op: "station.status",
    data: {
      protocol: STATION_API_PROTOCOL,
      op: "status",
      installationId: "installation-test",
      state: "unenrolled",
      receivedThrough: [],
      peerAcknowledgedThrough: [],
      readiness: {
        database: true,
        workControl: false,
        simulation: false,
        session: false,
      },
      observedAt: "2026-07-31T00:00:00.000Z",
    },
  });
  if (Either.isLeft(decoded)) {
    throw new Error("invalid operator status fixture");
  }
  return decoded.right;
};

const connect = (socketPath: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });

const exchange = async (
  socketPath: string,
  frame: string,
  halfClose = false,
): Promise<string> => {
  const socket = await connect(socketPath);
  return new Promise((resolve, reject) => {
    let output = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      output += chunk;
    });
    socket.once("end", () => {
      socket.once("close", () => resolve(output));
      socket.destroy();
    });
    socket.once("error", reject);
    if (halfClose) socket.end(frame);
    else socket.write(frame);
  });
};

const start = async (
  dispatch = async (request: OperatorRequestEnvelope) =>
    statusResponse(request),
  runtime: OperatorControlServerRuntime = admittedRuntime,
): Promise<OperatorControlServer> => {
  // Darwin Unix-domain socket paths are capped near 104 bytes.
  const home = await mkdtemp("/tmp/vellum-operator-");
  roots.push(home);
  const server = await startOperatorControlServer({ home, dispatch }, runtime);
  servers.push(server);
  return server;
};

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      server.beginShutdown();
      await server.close();
    }
  }
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("operator control server", () => {
  it("clears every source buffer while accumulating sensitive request bytes", () => {
    const current = Buffer.from('{"password":"secret');
    const incoming = Buffer.from('"}\n');
    const combined = appendAndWipeOperatorBytes(current, incoming);
    expect(combined.toString("utf8")).toBe('{"password":"secret"}\n');
    expect([...current]).toEqual(new Array(current.byteLength).fill(0));
    expect([...incoming]).toEqual(new Array(incoming.byteLength).fill(0));
    combined.fill(0);
  });

  it("creates an owner-private directory and socket and serves one frame", async () => {
    const dispatch = vi.fn(async (request: OperatorRequestEnvelope) =>
      statusResponse(request),
    );
    const server = await start(dispatch);
    const directory = await stat(join(server.socketPath, ".."));
    const socket = await lstat(server.socketPath);
    expect(directory.mode & 0o777).toBe(0o700);
    expect(socket.isSocket()).toBe(true);
    expect(socket.isSymbolicLink()).toBe(false);
    expect(socket.mode & 0o777).toBe(0o600);

    const raw = await exchange(
      server.socketPath,
      encodeOperatorFrame(statusRequest()),
    );
    const decoded = decodeOperatorResponse(JSON.parse(raw));
    expect(Either.isRight(decoded)).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("keeps the response side open after a Node client half-closes", async () => {
    // Bun's net shim destroys the server-side socket on peer FIN despite
    // allowHalfOpen. Electron/Node is the product runtime for this listener.
    if (typeof process.versions.bun === "string") return;
    const server = await start();
    const raw = await exchange(
      server.socketPath,
      encodeOperatorFrame(statusRequest("half-close")),
      true,
    );
    expect(raw).toContain('"id":"half-close"');
  });

  it("fails closed when kernel peer identity is unavailable", async () => {
    const dispatch = vi.fn(async (request: OperatorRequestEnvelope) =>
      statusResponse(request),
    );
    const server = await start(dispatch, {
      admission: {
        processMap: emptyProcessMap,
        readPeerPid: () => undefined,
      },
    });
    const raw = await exchange(
      server.socketPath,
      encodeOperatorFrame(statusRequest()),
    );
    expect(raw).toContain('"type":"forbidden"');
    expect(raw).not.toContain("peer-pid-unavailable");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects multiple frames and never dispatches either request", async () => {
    const dispatch = vi.fn(async (request: OperatorRequestEnvelope) =>
      statusResponse(request),
    );
    const server = await start(dispatch);
    const frame = encodeOperatorFrame(statusRequest());
    const raw = await exchange(server.socketPath, `${frame}${frame}`);
    expect(raw).toContain('"type":"protocol_error"');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not echo a secret from strict decode failures", async () => {
    const secret = `secret-${"x".repeat(300)}`;
    const server = await start();
    const raw = await exchange(
      server.socketPath,
      `${JSON.stringify({
        protocol: OPERATOR_PROTOCOL_VERSION,
        id: "deploy-1",
        op: "fleet.deploy",
        args: {
          id: "station-1",
          source: "cached",
          unexpectedSecret: secret,
        },
      })}\n`,
    );
    expect(raw).toContain('"type":"protocol_error"');
    expect(raw).toContain("invalid operator request");
    expect(raw).not.toContain(secret);
  });

  it("retains an admitted dispatch after the client disconnects", async () => {
    let resolveDispatch!: (response: OperatorResponseEnvelope) => void;
    const dispatch = vi.fn(
      (request: OperatorRequestEnvelope) =>
        new Promise<OperatorResponseEnvelope>((resolve) => {
          resolveDispatch = resolve;
        }),
    );
    const server = await start(dispatch, {
      ...admittedRuntime,
      shutdownDeadlineMs: 20,
    });
    const socket = await connect(server.socketPath);
    socket.write(encodeOperatorFrame(statusRequest()));
    for (
      let index = 0;
      index < 20 && dispatch.mock.calls.length === 0;
      index++
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(dispatch).toHaveBeenCalledOnce();
    socket.destroy();
    server.beginShutdown();
    const retained = await server.close();
    expect(retained.clean).toBe(false);
    expect(retained.pendingDispatches).toBe(1);

    resolveDispatch(statusResponse(statusRequest()));
    await Promise.resolve();
    const clean = await server.close();
    expect(clean.clean).toBe(true);
  });
});
