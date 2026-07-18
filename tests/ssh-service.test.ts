import * as Command from "@effect/platform/Command";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import {
  Deferred,
  Effect,
  Either,
  Fiber,
  Layer,
  Scope,
  Sink,
  Stream,
  TestClock,
  TestContext,
} from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSshEndpoint,
  SshExitError,
  SshIoError,
  SshOutputLimitError,
  SshTimeoutError,
  SshTransport,
} from "../src/main/vellum/ssh";
import {
  makeRemoteCommand,
  makeRemoteStdin,
} from "../src/main/vellum/ssh/domain";
import {
  daemonHandoff,
  dedicatedStream,
  oneShot,
  oneShotWithStdin,
} from "../src/main/vellum/ssh/program";
import {
  ProcessSpawner,
  ProcessFailure,
  type ProcessHandle,
} from "../src/main/vellum/ssh/process-spawner";
import { SshTransportConfig, SshTransportLayer } from "../src/main/vellum/ssh/service";

interface FakeResult {
  readonly stdout?: Uint8Array;
  readonly stderr?: Uint8Array;
  readonly code?: number;
  readonly running?: boolean;
  readonly stdin?: Sink.Sink<void, Uint8Array, never, ProcessFailure>;
}

interface FakeProcess {
  readonly handle: ProcessHandle;
  readonly release: Effect.Effect<void>;
}

const encoder = new TextEncoder();
const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const standard = (command: Command.Command): Command.StandardCommand => Command.flatten(command)[0];

const fakeProcess = (
  result: FakeResult,
  pid: number,
): Effect.Effect<FakeProcess> =>
  Effect.gen(function* () {
    const exit = yield* Deferred.make<number>();
    let running = result.running === true;
    if (!running) yield* Deferred.succeed(exit, result.code ?? 0);
    return {
      handle: {
        pid,
        exitCode: Deferred.await(exit),
        isRunning: Effect.sync(() => running),
        stdin: result.stdin ?? Sink.drain,
        stdout: Stream.fromIterable(result.stdout === undefined ? [] : [result.stdout]),
        stderr: Stream.fromIterable(result.stderr === undefined ? [] : [result.stderr]),
      },
      release: Effect.sync(() => { running = false; }).pipe(
        Effect.zipRight(Deferred.succeed(exit, result.code ?? 143)),
        Effect.asVoid,
      ),
    };
  });

const testLayer = async (
  resolve: (command: Command.StandardCommand) => FakeResult,
  calls: Command.StandardCommand[],
  releases: Command.StandardCommand[],
  options?: { readonly global?: number; readonly perEndpoint?: number },
) => {
  const root = await mkdtemp(join(tmpdir(), "vellum-ssh-test-"));
  temporaryDirs.push(root);
  let nextPid = 100;
  const spawner = ProcessSpawner.of({
    start: (command) => {
      const flattened = standard(command);
      return Effect.acquireRelease(
        Effect.sync(() => calls.push(flattened)).pipe(
          Effect.zipRight(fakeProcess(resolve(flattened), nextPid++)),
        ),
        ({ release }) => release.pipe(
          Effect.zipRight(Effect.sync(() => releases.push(flattened))),
        ),
      ).pipe(Effect.map(({ handle }) => handle));
    },
  });
  return SshTransportLayer.pipe(
    Layer.provide(Layer.succeed(ProcessSpawner, spawner)),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(
      Layer.succeed(SshTransportConfig, {
        controlDir: join(root, "control"),
        envExecutable: "/usr/bin/env",
        sshExecutable: "/usr/bin/ssh",
        environment: { HOME: root, PATH: "/usr/bin:/bin" },
        maxConcurrentDials: options?.global ?? 3,
        maxConcurrentDialsPerEndpoint: options?.perEndpoint ?? 2,
      }),
    ),
  );
};

const remoteText = (command: Command.StandardCommand): string => command.args.at(-1) ?? "";

describe("SshTransport", () => {
  it("drains bounded output, closes one-shot stdin, and checks exit status", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
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
        return yield* (yield* SshTransport).run(oneShot(endpoint, remote));
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual({ stdout: "ok\n", stderr: "note\n" });
    expect(calls.some((command) => command.args.includes("/usr/bin/ssh"))).toBe(true);
    expect(releases.length).toBeGreaterThanOrEqual(1);
  });

  it("omits remote stderr from serializable exit errors", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const layer = await testLayer(
      (command) => command.args.includes("-O")
        ? {}
        : { code: 255, stderr: encoder.encode("secret-token\u001b[31m") },
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
      expect(JSON.stringify(result.left)).not.toContain("secret-token");
      expect(JSON.stringify(result.left)).not.toContain("\\u001b");
    }
  });

  it("carries sensitive one-shot input only through stdin", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const received: Uint8Array[] = [];
    const input = Sink.forEach((chunk: Uint8Array) =>
      Effect.sync(() => { received.push(Uint8Array.from(chunk)); }),
    );
    const layer = await testLayer(
      (command) => remoteText(command).includes("identity-apply") ? { stdin: input } : {},
      calls,
      releases,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const endpoint = yield* parseSshEndpoint("remote-a");
        const remote = yield* makeRemoteCommand("hermes", ["identity-apply"]);
        const body = yield* makeRemoteStdin("private prompt body");
        yield* (yield* SshTransport).run(oneShotWithStdin(endpoint, remote, body));
      }).pipe(Effect.provide(layer)),
    );

    expect(calls.some((command) => command.args.some((arg) => arg.includes("private prompt body"))))
      .toBe(false);
    expect(Buffer.concat(received.map((chunk) => Buffer.from(chunk))).toString("utf8"))
      .toBe("private prompt body");
  });

  it("releases the process as soon as bounded stdout is exceeded", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
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
    expect(releases.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps one input pump across repeated writes and closes with the caller scope", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const received: Uint8Array[] = [];
    const input = Sink.forEach((chunk: Uint8Array) =>
      Effect.sync(() => { received.push(Uint8Array.from(chunk)); }),
    );
    const layer = await testLayer(
      (command) => remoteText(command).includes("hermes")
        ? { running: true, stdin: input }
        : {},
      calls,
      releases,
    );

    const value = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const endpoint = yield* parseSshEndpoint("remote-a");
          const remote = yield* makeRemoteCommand("hermes", ["acp"]);
          return yield* (yield* SshTransport).connect(
            dedicatedStream(endpoint, remote),
            (lease, confirm) =>
              lease.write(encoder.encode("first")).pipe(
                Effect.zipRight(lease.write(encoder.encode("second"))),
                Effect.zipRight(lease.closeInput),
                Effect.as(confirm("ready")),
              ),
          );
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(value).toBe("ready");
    expect(Buffer.concat(received.map((chunk) => Buffer.from(chunk))).toString("utf8"))
      .toBe("firstsecond");
    expect(releases.some((command) => remoteText(command).includes("hermes"))).toBe(true);
  });

  it("rejects writes after the process input pump fails", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const layer = await testLayer(
      (command) => remoteText(command).includes("hermes")
        ? { running: true, stdin: Sink.fail(new ProcessFailure()) }
        : {},
      calls,
      releases,
    );

    const result = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          Effect.gen(function* () {
            const endpoint = yield* parseSshEndpoint("remote-a");
            const remote = yield* makeRemoteCommand("hermes", ["acp"]);
            return yield* (yield* SshTransport).connect(
              dedicatedStream(endpoint, remote),
              (lease, confirm) =>
                Effect.sleep(10).pipe(
                  Effect.zipRight(lease.write(encoder.encode("discarded"))),
                  Effect.as(confirm("ready")),
                ),
            );
          }),
        ).pipe(Effect.provide(layer)),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(SshIoError);
  });

  it("rejects readiness when the stream exits first or is closed by the callback", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const layer = await testLayer(() => ({}), calls, releases);

    const exitedFirst = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          Effect.gen(function* () {
            const endpoint = yield* parseSshEndpoint("remote-a");
            const remote = yield* makeRemoteCommand("already-exited");
            return yield* (yield* SshTransport).connect(
              dedicatedStream(endpoint, remote),
              (_lease, confirm) => Effect.sleep(20).pipe(Effect.as(confirm("late"))),
            );
          }),
        ).pipe(Effect.provide(layer)),
      ),
    );
    expect(Either.isLeft(exitedFirst)).toBe(true);
    if (Either.isLeft(exitedFirst)) expect(exitedFirst.left).toBeInstanceOf(SshExitError);

    const closedInCallback = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          Effect.gen(function* () {
            const endpoint = yield* parseSshEndpoint("remote-a");
            const remote = yield* makeRemoteCommand("long-stream");
            const runningLayer = yield* Effect.succeed(undefined);
            void runningLayer;
            return yield* (yield* SshTransport).connect(
              dedicatedStream(endpoint, remote),
              (lease, confirm) => lease.close.pipe(Effect.as(confirm("closed"))),
            );
          }),
        ).pipe(
          Effect.provide(
            await testLayer(
              (command) => remoteText(command).includes("long-stream") ? { running: true } : {},
              [],
              [],
            ),
          ),
        ),
      ),
    );
    expect(Either.isLeft(closedInCallback)).toBe(true);
    if (Either.isLeft(closedInCallback)) expect(closedInCallback.left).toBeInstanceOf(SshIoError);
  });

  it("keeps daemon handoff inside admission until domain readiness", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const layer = await testLayer(
      (command) => remoteText(command).includes("nohup")
        ? { stdout: encoder.encode("4242\n") }
        : {},
      calls,
      releases,
    );

    const value = await Effect.runPromise(
      Effect.gen(function* () {
        const endpoint = yield* parseSshEndpoint("remote-a");
        const remote = yield* makeRemoteCommand("herdr", ["server"]);
        return yield* (yield* SshTransport).handoff(
          daemonHandoff(endpoint, remote),
          (confirm) => Effect.succeed(confirm("healthy")),
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(value).toBe("healthy");
  });

  it("times out a non-terminating one-shot with the typed budget error", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const layer = await testLayer(
      (command) => command.args.includes("-O") ? {} : { running: true },
      calls,
      releases,
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            Effect.gen(function* () {
              const endpoint = yield* parseSshEndpoint("remote-a");
              const remote = yield* makeRemoteCommand("never");
              return yield* (yield* SshTransport).run(oneShot(endpoint, remote, { budget: "short" }));
            }).pipe(Effect.provide(layer), Effect.either),
          );
          yield* TestClock.adjust("7 seconds");
          return yield* Fiber.join(fiber);
        }),
      ).pipe(Effect.provide(TestContext.TestContext)),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(SshTimeoutError);
  });

  it("composes global and per-endpoint dial admission without host starvation", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    let active = 0;
    let maxActive = 0;
    const activeByEndpoint = new Map<string, number>();
    const maxByEndpoint = new Map<string, number>();
    const root = await mkdtemp(join(tmpdir(), "vellum-ssh-admission-"));
    temporaryDirs.push(root);
    let pid = 1_000;
    const spawner = ProcessSpawner.of({
      start: (command) => {
        const flattened = standard(command);
        const endpoint = flattened.args.at(-2) ?? "control";
        if (flattened.args.includes("-O")) {
          return Effect.acquireRelease(
            Effect.sync(() => {
              calls.push(flattened);
              return {
                pid: pid++,
                exitCode: Effect.succeed(0),
                isRunning: Effect.succeed(false),
                stdin: Sink.drain,
                stdout: Stream.empty,
                stderr: Stream.empty,
              } satisfies ProcessHandle;
            }),
            () => Effect.sync(() => { releases.push(flattened); }),
          );
        }
        return Effect.acquireRelease(
          Effect.sync(() => {
            calls.push(flattened);
            active += 1;
            maxActive = Math.max(maxActive, active);
            const hostActive = (activeByEndpoint.get(endpoint) ?? 0) + 1;
            activeByEndpoint.set(endpoint, hostActive);
            maxByEndpoint.set(endpoint, Math.max(maxByEndpoint.get(endpoint) ?? 0, hostActive));
            return {
              pid: pid++,
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
            } satisfies ProcessHandle;
          }),
          () => Effect.sync(() => {
            active -= 1;
            activeByEndpoint.set(endpoint, (activeByEndpoint.get(endpoint) ?? 1) - 1);
            releases.push(flattened);
          }),
        );
      },
    });
    const layer = SshTransportLayer.pipe(
      Layer.provide(Layer.succeed(ProcessSpawner, spawner)),
      Layer.provide(NodeFileSystem.layer),
      Layer.provide(Layer.succeed(SshTransportConfig, {
        controlDir: join(root, "control"),
        envExecutable: "/usr/bin/env",
        sshExecutable: "/usr/bin/ssh",
        environment: { HOME: root, PATH: "/usr/bin:/bin" },
        maxConcurrentDials: 3,
        maxConcurrentDialsPerEndpoint: 2,
      })),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const endpointA = yield* parseSshEndpoint("host-a");
          const endpointB = yield* parseSshEndpoint("host-b");
          const command = yield* makeRemoteCommand("hold");
          const ssh = yield* SshTransport;
          const fibers = yield* Effect.forEach(
            [0, 1, 2, 3],
            () => Effect.fork(ssh.run(oneShot(endpointA, command))),
          );
          yield* Effect.sleep(50);
          fibers.push(yield* Effect.fork(ssh.run(oneShot(endpointB, command))));
          yield* Effect.sleep(50);
          expect(active).toBe(3);
          expect(activeByEndpoint.get("host-a")).toBe(2);
          expect(activeByEndpoint.get("host-b")).toBe(1);
          yield* Fiber.interruptAll(fibers);
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxByEndpoint.get("host-a")).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
    expect(releases.length).toBe(calls.length);
  });
});
