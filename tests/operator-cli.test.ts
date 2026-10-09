import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  OPERATOR_PROTOCOL_VERSION,
  decodeOperatorRequest,
  operatorControlSocketPath,
} from "../src/shared/operator-control";
import {
  OperatorSocket,
  OperatorSocketLive,
} from "../src/cli/core/operator-socket";
import { browserCliArgsFromArgv } from "../src/cli/browser-argv";
import { __resetJuntoHomeCache } from "../src/shared/junto-home";
import { WORK_TOKEN_ENV } from "../src/shared/work-control";
import { OWNER_COMMAND_REFUSAL } from "../src/cli/core/owner-access";

const DEVICE = "dev_01J9Z3K4M5N6P7Q8R9S0T1V2W3";
const hello = { appVersion: "t", deviceId: DEVICE, deviceName: "Phone", station: "Mac", serverTime: 1 };

const roots: string[] = [];
const servers: Server[] = [];

beforeEach(() => { vi.stubEnv(WORK_TOKEN_ENV, undefined); });

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
  delete process.env.JUNTO_HOME;
  __resetJuntoHomeCache();
  process.exitCode = 0;
  vi.unstubAllEnvs();
});

const startOperatorServer = async (
  respond: (request: Record<string, unknown>) => unknown,
): Promise<Server> => {
  const root = await mkdtemp("/tmp/junto-op-");
  roots.push(root);
  process.env.JUNTO_HOME = root;
  __resetJuntoHomeCache();
  const socketPath = operatorControlSocketPath(root);
  await mkdir(join(root, ".junto", "operator"), { recursive: true });
  const server = createServer((socket) => {
    let request = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      request = Buffer.concat([request, chunk]);
      const newline = request.indexOf(0x0a);
      if (newline < 0) return;
      const decoded = JSON.parse(
        request.subarray(0, newline).toString("utf8"),
      ) as Record<string, unknown>;
      request.fill(0);
      socket.end(`${JSON.stringify(respond(decoded))}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return server;
};

describe("operator socket client", () => {
  it.each(["", "malformed", "seat-generation"])("refuses a present seat variable before connecting (%j)", async (token) => {
    let connections = 0;
    const server = await startOperatorServer(() => { throw new Error("a seat must not send an owner request"); });
    server.on("connection", () => { connections++; });
    vi.stubEnv(WORK_TOKEN_ENV, token);
    const result = await Effect.runPromise(Effect.gen(function* () {
      const socket = yield* OperatorSocket;
      return yield* socket.call("machine.status", {}).pipe(Effect.result);
    }).pipe(Effect.provide(OperatorSocketLive)));
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "AuthError", message: OWNER_COMMAND_REFUSAL } });
    expect(connections).toBe(0);
  });

  it("sends one strict token-free request and decodes its typed response", async () => {
    let observed: Record<string, unknown> | undefined;
    await startOperatorServer((request) => {
      observed = request;
      return {
        protocol: OPERATOR_PROTOCOL_VERSION,
        id: request.id,
        ok: true,
        op: "companion.hello",
        data: { ok: true, hello },
      };
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const socket = yield* OperatorSocket;
        return yield* socket.call("companion.hello", { deviceId: DEVICE });
      }).pipe(Effect.provide(OperatorSocketLive)),
    );

    expect(result).toEqual({ ok: true, hello });
    expect(observed).toBeDefined();
    expect(observed).not.toHaveProperty("token");
    expect(decodeOperatorRequest(observed)._tag).toBe("Success");
  });

  it("rejects a response with a different request id", async () => {
    await startOperatorServer((request) => ({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: `${String(request.id)}-wrong`,
      ok: true,
      op: "companion.hello",
      data: { ok: true, hello },
    }));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const socket = yield* OperatorSocket;
        return yield* socket.call("companion.hello", { deviceId: DEVICE }).pipe(Effect.result);
      }).pipe(Effect.provide(OperatorSocketLive)),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toMatch(/match the request/);
    }
  });
});

describe("top-level browser dispatch", () => {
  it("does not treat a later browser argument as the browser command", () => {
    expect(
      browserCliArgsFromArgv([
        "bun",
        "/$bunfs/root/junto",
        "docs",
        "node",
        "browser",
      ]),
    ).toBeUndefined();
    expect(
      browserCliArgsFromArgv([
        "bun",
        "/$bunfs/root/junto",
        "browser",
        "doctor",
        "--json",
      ]),
    ).toEqual(["doctor", "--json"]);
    expect(
      browserCliArgsFromArgv([
        "/Users/dev/.bun/bin/bun",
        "/Users/dev/Projects/junto/src/cli/main.ts",
        "browser",
        "doctor",
      ]),
    ).toEqual(["doctor"]);
  });
});
