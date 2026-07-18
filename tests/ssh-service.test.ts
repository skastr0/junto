import * as Command from "@effect/platform/Command";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Layer, Sink, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  daemonHandoff,
  makeRemoteCommand,
  oneShot,
  parseSshEndpoint,
  sharedStream,
  SshExitError,
  SshOutputLimitError,
  SshTransport,
} from "../src/main/vellum/ssh";
import {
  ProcessSpawner,
  type ProcessHandle,
} from "../src/main/vellum/ssh/process-spawner";
import { SshTransportConfig, SshTransportLayer } from "../src/main/vellum/ssh/service";

interface FakeResult {
  readonly stdout?: Uint8Array;
  readonly stderr?: Uint8Array;
  readonly code?: number;
}

const encoder = new TextEncoder();
const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const fakeHandle = (result: FakeResult): ProcessHandle => ({
  exitCode: Effect.succeed(result.code ?? 0),
  isRunning: Effect.succeed(false),
  kill: () => Effect.void,
  stdin: Sink.drain,
  stdout: Stream.fromIterable(result.stdout === undefined ? [] : [result.stdout]),
  stderr: Stream.fromIterable(result.stderr === undefined ? [] : [result.stderr]),
});

const testLayer = async (
  resolve: (command: Command.StandardCommand) => FakeResult,
  calls: Command.StandardCommand[],
  releases: { count: number },
) => {
  const root = await mkdtemp(join(tmpdir(), "vellum-ssh-test-"));
  temporaryDirs.push(root);
  const spawner = ProcessSpawner.of({
    start: (command) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const flattened = Command.flatten(command)[0];
          calls.push(flattened);
          return fakeHandle(resolve(flattened));
        }),
        () => Effect.sync(() => { releases.count += 1; }),
      ),
  });
  return SshTransportLayer.pipe(
    Layer.provide(Layer.succeed(ProcessSpawner, spawner)),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(
      Layer.succeed(SshTransportConfig, {
        controlDir: join(root, "control"),
        maxConcurrentDials: 2,
      }),
    ),
  );
};

describe("SshTransport", () => {
  it("drains output, closes stdin, and checks the exit status", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases = { count: 0 };
    const layer = await testLayer(
      (command) => command.args.includes("-O")
        ? {}
        : { stdout: encoder.encode("ok\n"), stderr: encoder.encode("note\n") },
      calls,
      releases,
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const endpoint = yield* parseSshEndpoint("remote-a");
        const remote = yield* makeRemoteCommand("true");
        const ssh = yield* SshTransport;
        return yield* ssh.run(oneShot(endpoint, remote));
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual({ stdout: "ok\n", stderr: "note\n" });
    expect(calls.some((command) => command.command === "ssh")).toBe(true);
    expect(releases.count).toBeGreaterThanOrEqual(1);
  });

  it("returns the sound exit error for any non-zero SSH exit", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases = { count: 0 };
    const layer = await testLayer(
      (command) => command.args.includes("-O")
        ? {}
        : { code: 255, stderr: encoder.encode("connection failed") },
      calls,
      releases,
    );

    const result = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const endpoint = yield* parseSshEndpoint("remote-a");
          const remote = yield* makeRemoteCommand("false");
          return yield* (yield* SshTransport).run(oneShot(endpoint, remote));
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(SshExitError);
      expect((result.left as SshExitError).code).toBe(255);
    }
  });

  it("interrupts a process as soon as bounded stdout is exceeded", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases = { count: 0 };
    const layer = await testLayer(
      (command) => command.args.includes("-O")
        ? {}
        : { stdout: new Uint8Array(8 * 1024 * 1024 + 1) },
      calls,
      releases,
    );

    const result = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const endpoint = yield* parseSshEndpoint("remote-a");
          const remote = yield* makeRemoteCommand("huge-output");
          return yield* (yield* SshTransport).run(oneShot(endpoint, remote));
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(SshOutputLimitError);
    expect(releases.count).toBeGreaterThanOrEqual(1);
  });

  it("requires an explicit readiness receipt before releasing a stream dial", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases = { count: 0 };
    const layer = await testLayer(() => ({}), calls, releases);

    const value = await Effect.runPromise(
      Effect.gen(function* () {
        const endpoint = yield* parseSshEndpoint("remote-a");
        const remote = yield* makeRemoteCommand("herdr", ["terminal", "session", "observe", "t1"]);
        const ssh = yield* SshTransport;
        return yield* ssh.connect(sharedStream(endpoint, remote), (lease, confirm) =>
          lease.close.pipe(Effect.as(confirm("ready"))),
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(value).toBe("ready");
    expect(releases.count).toBeGreaterThanOrEqual(1);
  });

  it("keeps daemon handoff inside the dial permit until domain readiness", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases = { count: 0 };
    const layer = await testLayer(
      (command) => command.args.includes("-O") ? {} : { stdout: encoder.encode("4242\n") },
      calls,
      releases,
    );

    const value = await Effect.runPromise(
      Effect.gen(function* () {
        const endpoint = yield* parseSshEndpoint("remote-a");
        const remote = yield* makeRemoteCommand("herdr", ["server"]);
        const ssh = yield* SshTransport;
        return yield* ssh.handoff(daemonHandoff(endpoint, remote), (confirm) =>
          Effect.succeed(confirm("healthy")),
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(value).toBe("healthy");
  });
});
