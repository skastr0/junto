import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import {
  OPERATOR_PROTOCOL_VERSION,
  decodeOperatorRequest,
  operatorControlSocketPath,
  type OperatorDataByOp,
} from "../src/shared/operator-control";
import {
  OperatorSocket,
  OperatorSocketLive,
} from "../src/cli/core/operator-socket";
import {
  readAdministratorPasswordLine,
  runOperatorDeployment,
} from "../src/cli/commands/operator";
import { browserCliArgsFromArgv } from "../src/cli/main";
import { __resetVellumHomeCache } from "../src/shared/vellum-home";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
  delete process.env.VELLUM_HOME;
  __resetVellumHomeCache();
  process.exitCode = 0;
});

const startOperatorServer = async (
  respond: (request: Record<string, unknown>) => unknown,
): Promise<void> => {
  const root = await mkdtemp("/tmp/vellum-op-");
  roots.push(root);
  process.env.VELLUM_HOME = root;
  __resetVellumHomeCache();
  const socketPath = operatorControlSocketPath(root);
  await mkdir(join(root, ".vellum", "operator"), { recursive: true });
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
};

describe("operator socket client", () => {
  it("sends one strict token-free request and decodes its typed response", async () => {
    let observed: Record<string, unknown> | undefined;
    await startOperatorServer((request) => {
      observed = request;
      return {
        protocol: OPERATOR_PROTOCOL_VERSION,
        id: request.id,
        ok: true,
        op: "fleet.list",
        data: {
          hosts: [
            {
              id: "local",
              label: "Local",
              kind: "local",
              capabilities: ["terminal"],
            },
          ],
        },
      };
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const socket = yield* OperatorSocket;
        return yield* socket.call("fleet.list", {});
      }).pipe(Effect.provide(OperatorSocketLive)),
    );

    expect(result.hosts[0]?.id).toBe("local");
    expect(observed).toBeDefined();
    expect(observed).not.toHaveProperty("token");
    expect(decodeOperatorRequest(observed)._tag).toBe("Right");
  });

  it("rejects a response with a different request id", async () => {
    await startOperatorServer((request) => ({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: `${String(request.id)}-wrong`,
      ok: true,
      op: "fleet.list",
      data: { hosts: [] },
    }));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const socket = yield* OperatorSocket;
        return yield* socket.call("fleet.list", {}).pipe(Effect.either);
      }).pipe(Effect.provide(OperatorSocketLive)),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toMatch(/match the request/);
    }
  });
});

const authorizationRequest = {
  kind: "linux-administrator-password" as const,
  hostId: "station-1",
  endpoint: "vellum@station-1",
  version: "0.1.5",
  manifestSha256: "a".repeat(64),
  debSha256: "b".repeat(64),
  inventorySha256: "c".repeat(64),
};

const authorizationRequired: OperatorDataByOp["fleet.qualify"] = {
  status: "authorization-required",
  ok: false,
  detail: "administrator authorization required",
  stages: [],
  authorizationRequest,
};

const ready: OperatorDataByOp["fleet.qualify"] = {
  status: "ready",
  ok: true,
  detail: "ready",
  stages: [],
  outcome: "ready",
  packageState: "present",
  role: "remote",
};

describe("operator deploy password ingress", () => {
  it("does not touch stdin when the first deploy is terminal", async () => {
    const input = new PassThrough();
    const service = OperatorSocket.of({
      call: () => Effect.succeed(ready) as never,
    });
    const result = await Effect.runPromise(
      runOperatorDeployment({
        op: "fleet.qualify",
        id: "station-1",
        passwordStdin: true,
        passwordInput: input,
      }).pipe(Effect.provide(Layer.succeed(OperatorSocket, service))),
    );
    expect(result.status).toBe("ready");
    expect(input.listenerCount("data")).toBe(0);
  });

  it("first deploys without auth, then reads and retries one exact binding", async () => {
    const input = new PassThrough();
    const sourceBytes = Buffer.from("one-shot-secret\n");
    let calls = 0;
    const service = OperatorSocket.of({
      call: (op, args) => {
        expect(op).toBe("fleet.qualify");
        calls += 1;
        if (calls === 1) {
          expect(args).toEqual({ id: "station-1" });
          return Effect.succeed(authorizationRequired) as never;
        }
        expect(args).toMatchObject({
          id: "station-1",
          authorization: {
            request: authorizationRequest,
            password: "one-shot-secret",
          },
        });
        return Effect.succeed(ready) as never;
      },
    });
    const running = Effect.runPromise(
      runOperatorDeployment({
        op: "fleet.qualify",
        id: "station-1",
        passwordStdin: true,
        passwordInput: input,
      }).pipe(Effect.provide(Layer.succeed(OperatorSocket, service))),
    );
    input.end(sourceBytes);
    const result = await running;

    expect(result.status).toBe("ready");
    expect(calls).toBe(2);
    expect(sourceBytes.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects extra lines and zeroes the source Buffer", async () => {
    const input = new PassThrough();
    const sourceBytes = Buffer.from("first\nsecond\n");
    const running = Effect.runPromise(
      readAdministratorPasswordLine(input).pipe(Effect.either),
    );
    input.end(sourceBytes);
    const result = await running;

    expect(result._tag).toBe("Left");
    expect(sourceBytes.every((byte) => byte === 0)).toBe(true);
  });
});

describe("top-level browser dispatch", () => {
  it("does not treat a fleet capability value as the browser command", () => {
    expect(
      browserCliArgsFromArgv([
        "/usr/local/bin/vellum",
        "fleet",
        "add",
        "--capability",
        "browser",
      ]),
    ).toBeUndefined();
    expect(
      browserCliArgsFromArgv([
        "/usr/local/bin/vellum",
        "browser",
        "doctor",
        "--json",
      ]),
    ).toEqual(["doctor", "--json"]);
  });
});
