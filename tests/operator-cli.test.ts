import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
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
  runOperatorDeployment,
} from "../src/cli/commands/operator";
import { browserCliArgsFromArgv } from "../src/cli/browser-argv";
import { __resetJuntoHomeCache } from "../src/shared/junto-home";

const roots: string[] = [];
const servers: Server[] = [];

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
});

const startOperatorServer = async (
  respond: (request: Record<string, unknown>) => unknown,
): Promise<void> => {
  const root = await mkdtemp("/tmp/vellum-op-");
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
    expect(decodeOperatorRequest(observed)._tag).toBe("Success");
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
        return yield* socket.call("fleet.list", {}).pipe(Effect.result);
      }).pipe(Effect.provide(OperatorSocketLive)),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toMatch(/match the request/);
    }
  });
});

const ready: OperatorDataByOp["fleet.qualify"] = {
  status: "ready",
  ok: true,
  detail: "ready",
  stages: [],
  outcome: "ready",
  packageState: "present",
  role: "remote",
};

describe("operator deploy (userland, no password ingress)", () => {
  it("deploys through one operator call without stdin credentials", async () => {
    const service = OperatorSocket.of({
      call: (op, args) => {
        expect(op).toBe("fleet.qualify");
        expect(args).toEqual({ id: "station-1" });
        return Effect.succeed(ready) as never;
      },
    });
    const result = await Effect.runPromise(
      runOperatorDeployment({
        op: "fleet.qualify",
        id: "station-1",
      }).pipe(Effect.provide(Layer.succeed(OperatorSocket, service))),
    );
    expect(result.status).toBe("ready");
  });
});

describe("top-level browser dispatch", () => {
  it("does not treat a fleet capability value as the browser command", () => {
    expect(
      browserCliArgsFromArgv([
        "bun",
        "/$bunfs/root/vellum-command",
        "fleet",
        "add",
        "--capability",
        "browser",
      ]),
    ).toBeUndefined();
    expect(
      browserCliArgsFromArgv([
        "bun",
        "/$bunfs/root/vellum-command",
        "browser",
        "doctor",
        "--json",
      ]),
    ).toEqual(["doctor", "--json"]);
    expect(
      browserCliArgsFromArgv([
        "/Users/dev/.bun/bin/bun",
        "/Users/dev/Projects/vellum/src/cli/main.ts",
        "browser",
        "doctor",
      ]),
    ).toEqual(["doctor"]);
  });
});
