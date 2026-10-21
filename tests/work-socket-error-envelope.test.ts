import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { WORK_TOKEN_ENV, workControlSocketPath } from "../src/shared/work-control";
import { WorkSocket, WorkSocketLive } from "../src/cli/core/socket";

const roots: string[] = [];
const servers: Server[] = [];
const openSockets = new Set<Socket>();
const savedHome = process.env.JUNTO_WORK_HOME;
const savedToken = process.env[WORK_TOKEN_ENV];

afterEach(async () => {
  for (const socket of openSockets) socket.destroy();
  openSockets.clear();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.JUNTO_WORK_HOME;
  else process.env.JUNTO_WORK_HOME = savedHome;
  if (savedToken === undefined) delete process.env[WORK_TOKEN_ENV];
  else process.env[WORK_TOKEN_ENV] = savedToken;
});

/** A core that answers every call with this error body. */
const startCoreAnswering = async (error: object): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "junto-socket-error-"));
  roots.push(root);
  process.env.JUNTO_WORK_HOME = root;
  process.env[WORK_TOKEN_ENV] = "test-token";
  const server = createServer((socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
    socket.on("error", () => undefined);
    socket.once("data", () => socket.end(`${JSON.stringify({ ok: false, op: "ping", error })}\n`));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(workControlSocketPath(root), resolve));
};

const call = () =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const socket = yield* WorkSocket;
      return yield* socket.call("ping", {});
    }).pipe(Effect.provide(WorkSocketLive)),
  );

const failureOf = (exit: Exit.Exit<unknown, unknown>): Record<string, unknown> => {
  expect(Exit.isFailure(exit)).toBe(true);
  const failures = JSON.parse(JSON.stringify(exit)).cause.failures as ReadonlyArray<{ readonly error?: Record<string, unknown> }>;
  return failures[0]?.error ?? {};
};

describe("a core refusal the CLI passes on", () => {
  for (const type of ["RuntimeDown", "AuthError"] as const) {
    it(`${type} with no next_step is passed on as itself, not as a schema failure`, async () => {
      await startCoreAnswering({ type, message: "the core said no" });
      const failure = failureOf(await call());
      expect(failure._tag).toBe(type);
      expect(failure.message).toBe("the core said no");
      expect(failure).not.toHaveProperty("next_step");
    });

    it(`${type} keeps a next_step the core gave`, async () => {
      await startCoreAnswering({ type, message: "the core said no", details: { next_step: "junto doctor" } });
      const failure = failureOf(await call());
      expect(failure._tag).toBe(type);
      expect(failure.next_step).toBe("junto doctor");
    });
  }
});
