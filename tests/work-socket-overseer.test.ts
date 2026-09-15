import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORK_MAX_FRAME_BYTES,
  workControlSocketPath,
  workControlTokenPath,
  type WorkOpName,
} from "../src/shared/work-control";
import {
  WorkSocket,
  WorkSocketLive,
} from "../src/cli/core/socket";

type FailureMode = "timeout" | "disconnect" | "oversized" | "truncated";

const roots: string[] = [];
const servers: Server[] = [];
const openSockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of openSockets) socket.destroy();
  openSockets.clear();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
  delete process.env.VELLUM_COMMAND_WORK_HOME;
});

const startFakeWorkServer = async (
  mode: FailureMode,
): Promise<{ readonly invocations: () => number }> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-overseer-socket-"));
  roots.push(root);
  process.env.VELLUM_COMMAND_WORK_HOME = root;
  await mkdir(root, { recursive: true });
  await writeFile(workControlTokenPath(root), "test-token\n", { mode: 0o600 });

  let invocations = 0;
  const server = createServer((socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
    socket.on("error", () => undefined);
    let request = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      request = Buffer.concat([request, chunk]);
      const newline = request.indexOf(0x0a);
      if (newline < 0) return;
      invocations += 1;
      JSON.parse(request.subarray(0, newline).toString("utf8"));
      request = request.subarray(newline + 1);
      switch (mode) {
        case "timeout":
          return;
        case "disconnect":
          socket.end();
          return;
        case "truncated":
          socket.end('{"ok":true');
          return;
        case "oversized":
          socket.end(Buffer.alloc(WORK_MAX_FRAME_BYTES + 1, 0x78));
          return;
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(workControlSocketPath(root), resolve);
  });
  return { invocations: () => invocations };
};

const call = (
  op: WorkOpName,
  args: unknown,
  timeoutMs = 100,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const socket = yield* WorkSocket;
      return yield* socket.call(op, args, timeoutMs).pipe(Effect.result);
    }).pipe(Effect.provide(WorkSocketLive)),
  );

const overseerOp = "overseer" as WorkOpName;

describe("overseer Work socket completion classification", () => {
  it.each(["msg.send", "msg.prompt", "msg.reply", "verdict.post"] as const)(
    "does not invite replay after a dispatched %s loses its receipt",
    async (op) => {
      const server = await startFakeWorkServer("disconnect");
      const result = await call(op, { target: "peer", text: "Review ready" }, 1_000);
      expect(server.invocations()).toBe(1);
      expect(result).toMatchObject({
        _tag: "Failure", failure: { type: "UncertainCompletion", details: { retryable: false, operation: op } },
      });
    },
  );
  it.each<FailureMode>([
    "timeout",
    "disconnect",
    "oversized",
    "truncated",
  ])("does not invite replay after a dispatched mutation loses its %s response", async (mode) => {
    const server = await startFakeWorkServer(mode);
    const result = await call(
      overseerOp,
      { operation: "node.delete", args: { nodeId: "node-1" } },
      mode === "timeout" ? 20 : 1_000,
    );

    expect(server.invocations()).toBe(1);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "WireError",
        type: "UncertainCompletion",
        details: {
          retryable: false,
          operation: "node.delete",
        },
      },
    });
  });

  it.each([
    ["ordinary Work operation", "ping" as WorkOpName, undefined],
    [
      "read-only overseer operation",
      overseerOp,
      { operation: "canvas.read" },
    ],
  ])("keeps timeout retryable for a dispatched %s", async (_label, op, args) => {
    const server = await startFakeWorkServer("timeout");
    const result = await call(op, args, 20);

    expect(server.invocations()).toBe(1);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "WireError",
        type: "ProtocolError",
        details: { retryable: true },
      },
    });
  });
});
