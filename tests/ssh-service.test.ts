import * as Command from "@effect/platform/Command";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Result,
  Fiber,
  Layer,
  Option,
  Scope,
  Sink,
  Stream,
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
  sharedStream,
} from "../src/main/vellum/ssh/program";
import {
  ProcessSpawner,
  ProcessFailure,
  type ProcessHandle,
} from "../src/main/vellum/ssh/process-spawner";
import {
  SshTransferExitError,
  SshTransportConfig,
  SshTransportLayer,
} from "../src/main/vellum/ssh/service";

interface FakeResult {
  readonly stdout?: Uint8Array;
  readonly stderr?: Uint8Array;
  readonly code?: number;
  readonly running?: boolean;
  readonly exitCode?: Effect.Effect<number, ProcessFailure>;
  readonly stdin?: Sink.Sink<void, Uint8Array, never, ProcessFailure>;
}

interface FakeProcess {
  readonly handle: ProcessHandle;
  readonly release: Effect.Effect<void>;
}

const encoder = new TextEncoder();
const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const standard = (command: Command.Command): Command.StandardCommand =>
  Command.flatten(command)[0];

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
        exitCode: result.exitCode ?? Deferred.await(exit),
        isRunning: Effect.sync(() => running),
        stdin: result.stdin ?? Sink.drain,
        stdout: Stream.fromIterable(
          result.stdout === undefined ? [] : [result.stdout],
        ),
        stderr: Stream.fromIterable(
          result.stderr === undefined ? [] : [result.stderr],
        ),
      },
      release: Effect.sync(() => {
        running = false;
      }).pipe(
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
        ({ release }) =>
          release.pipe(
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

const remoteText = (command: Command.StandardCommand): string =>
  command.args.at(-1) ?? "";

describe("SshTransport", () => {
  it("drains bounded output, closes one-shot stdin, and checks exit status", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const layer = await testLayer(
      (command) =>
        command.args.includes("-O")
          ? {}
          : {
              stdout: encoder.encode("ok\n"),
              stderr: encoder.encode("note\n"),
            },
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
    expect(calls.some((command) => command.args.includes("/usr/bin/ssh"))).toBe(
      true,
    );
    expect(releases.length).toBeGreaterThanOrEqual(1);
  });

  it("omits remote stderr from serializable exit errors", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const layer = await testLayer(
      (command) =>
        command.args.includes("-O")
          ? {}
          : { code: 255, stderr: encoder.encode("secret-token\u001b[31m") },
      calls,
      releases,
    );

    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const endpoint = yield* parseSshEndpoint("remote-a");
          const remote = yield* makeRemoteCommand("false");
          return yield* (yield* SshTransport).run(oneShot(endpoint, remote));
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(SshExitError);
      expect((result.failure as SshExitError).code).toBe(255);
      expect(JSON.stringify(result.failure)).not.toContain("secret-token");
      expect(JSON.stringify(result.failure)).not.toContain("\\u001b");
    }
  });

  it("carries sensitive one-shot input only through stdin", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const received: Uint8Array[] = [];
    const input = Sink.forEach((chunk: Uint8Array) =>
      Effect.sync(() => {
        received.push(Uint8Array.from(chunk));
      }),
    );
    const layer = await testLayer(
      (command) =>
        remoteText(command).includes("identity-apply") ? { stdin: input } : {},
      calls,
      releases,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const endpoint = yield* parseSshEndpoint("remote-a");
        const remote = yield* makeRemoteCommand("hermes", ["identity-apply"]);
        const body = yield* makeRemoteStdin("private prompt body");
        yield* (yield* SshTransport).run(
          oneShotWithStdin(endpoint, remote, body),
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(
      calls.some((command) =>
        command.args.some((arg) => arg.includes("private prompt body")),
      ),
    ).toBe(false);
    expect(
      Buffer.concat(received.map((chunk) => Buffer.from(chunk))).toString(
        "utf8",
      ),
    ).toBe("private prompt body");
  });

  it("streams input incrementally, closes stdin, and collects bounded transfer output", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const received: Uint8Array[] = [];
    const input = Sink.forEach((chunk: Uint8Array) =>
      Effect.sync(() => {
        received.push(Uint8Array.from(chunk));
      }),
    );
    const layer = await testLayer(
      (command) =>
        remoteText(command).includes("remote-install")
          ? {
              stdin: input,
              stdout: encoder.encode("STATION_READY term=1 browser=1\n"),
              exitCode: Effect.sleep(10).pipe(Effect.as(0)),
            }
          : {},
      calls,
      releases,
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const endpoint = yield* parseSshEndpoint("remote-a");
        const remote = yield* makeRemoteCommand("remote-install");
        return yield* (yield* SshTransport).transfer(
          sharedStream(endpoint, remote),
          Stream.make(encoder.encode("first"), encoder.encode("second")),
          1_000,
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(result.stdout).toContain("STATION_READY");
    expect(
      Buffer.concat(received.map((chunk) => Buffer.from(chunk))).toString(
        "utf8",
      ),
    ).toBe("firstsecond");
    expect(releases.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects transfer chunks beyond the write boundary and releases the lease", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const layer = await testLayer(() => ({ running: true }), calls, releases);

    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const endpoint = yield* parseSshEndpoint("remote-a");
          const remote = yield* makeRemoteCommand("remote-install");
          return yield* (yield* SshTransport).transfer(
            sharedStream(endpoint, remote),
            Stream.make(new Uint8Array(1024 * 1024 + 1)),
            1_000,
          );
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(SshIoError);
    expect(calls).toHaveLength(1);
    expect(releases.length).toBeGreaterThanOrEqual(1);
  });

  it("times out a stalled transfer and closes its SSH lease", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const layer = await testLayer(() => ({ running: true }), calls, releases);

    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const endpoint = yield* parseSshEndpoint("remote-a");
          const remote = yield* makeRemoteCommand("remote-install");
          return yield* (yield* SshTransport).transfer(
            sharedStream(endpoint, remote),
            Stream.never,
            10,
          );
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure).toBeInstanceOf(SshTimeoutError);
    expect(calls).toHaveLength(1);
    expect(releases.length).toBeGreaterThanOrEqual(1);
  });

  it("retains bounded remote diagnostics when a transfer exits non-zero", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const layer = await testLayer(
      () => ({
        code: 2,
        stdout: encoder.encode("TERM_SOCK_TIMEOUT\n"),
        stderr: encoder.encode("STATION_PARTIAL term=0 browser=0\n"),
      }),
      calls,
      releases,
    );

    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const endpoint = yield* parseSshEndpoint("remote-a");
          const remote = yield* makeRemoteCommand("remote-install");
          return yield* (yield* SshTransport).transfer(
            sharedStream(endpoint, remote),
            Stream.empty,
            1_000,
          );
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(SshTransferExitError);
      const failure = result.failure as SshTransferExitError;
      expect(failure.code).toBe(2);
      expect(failure.stdout).toContain("TERM_SOCK_TIMEOUT");
      expect(failure.stderr).toContain("STATION_PARTIAL");
    }
  });

  it("releases the process as soon as bounded stdout is exceeded", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const layer = await testLayer(
      (command) =>
        command.args.includes("-O")
          ? {}
          : { stdout: new Uint8Array(8 * 1024 * 1024 + 1) },
      calls,
      releases,
    );

    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const endpoint = yield* parseSshEndpoint("remote-a");
          const remote = yield* makeRemoteCommand("huge-output");
          return yield* (yield* SshTransport).run(oneShot(endpoint, remote));
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure).toBeInstanceOf(SshOutputLimitError);
    expect(releases.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps one input pump across repeated writes and closes with the caller scope", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const received: Uint8Array[] = [];
    const input = Sink.forEach((chunk: Uint8Array) =>
      Effect.sync(() => {
        received.push(Uint8Array.from(chunk));
      }),
    );
    const layer = await testLayer(
      (command) =>
        remoteText(command).includes("hermes")
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
              lease
                .write(encoder.encode("first"))
                .pipe(
                  Effect.zipRight(lease.write(encoder.encode("second"))),
                  Effect.zipRight(lease.closeInput),
                  Effect.as(confirm("ready")),
                ),
          );
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(value).toBe("ready");
    expect(
      Buffer.concat(received.map((chunk) => Buffer.from(chunk))).toString(
        "utf8",
      ),
    ).toBe("firstsecond");
    expect(
      releases.some((command) => remoteText(command).includes("hermes")),
    ).toBe(true);
  });

  it("runs a finite duplex transaction through one child and requires exit zero", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const received: Uint8Array[] = [];
    const input = Sink.forEach((chunk: Uint8Array) =>
      Effect.sync(() => {
        received.push(Uint8Array.from(chunk));
      }),
    );
    const layer = await testLayer(
      (command) =>
        remoteText(command).includes("release-bridge")
          ? {
              stdin: input,
              stdout: encoder.encode('{"kind":"installed"}\n'),
            }
          : {},
      calls,
      releases,
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const endpoint = yield* parseSshEndpoint("linux-station");
        const remote = yield* makeRemoteCommand(
          "/usr/libexec/vellum-release-bridge",
        );
        return yield* (yield* SshTransport).transact(
          dedicatedStream(endpoint, remote),
          (lease) =>
            lease.write(encoder.encode("stage\n")).pipe(
              Effect.zipRight(lease.write(encoder.encode("password\n"))),
              Effect.zipRight(lease.closeInput),
              Effect.zipRight(
                Stream.runFold(
                  lease.stdout,
                  "",
                  (body, chunk) =>
                    body + Buffer.from(chunk).toString("utf8"),
                ),
              ),
            ),
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toBe('{"kind":"installed"}\n');
    expect(
      Buffer.concat(received.map((chunk) => Buffer.from(chunk))).toString(
        "utf8",
      ),
    ).toBe("stage\npassword\n");
    expect(
      releases.some((command) =>
        remoteText(command).includes("release-bridge"),
      ),
    ).toBe(true);
  });

  it("flushes and clears the transport-owned copy of sensitive input", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const received: Uint8Array[] = [];
    const sinkEntered = Effect.runSync(Deferred.make<void>());
    const allowSink = Effect.runSync(Deferred.make<void>());
    const input = Sink.forEach((chunk: Uint8Array) =>
      Deferred.succeed(sinkEntered, undefined).pipe(
        Effect.zipRight(Deferred.await(allowSink)),
        Effect.zipRight(
          Effect.sync(() => {
            received.push(Uint8Array.from(chunk));
          }),
        ),
      ),
    );
    const layer = await testLayer(
      (command) =>
        remoteText(command).includes("release-bridge")
          ? { stdin: input }
          : {},
      calls,
      releases,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const endpoint = yield* parseSshEndpoint("linux-station");
        const remote = yield* makeRemoteCommand(
          "/usr/libexec/vellum-release-bridge",
        );
        yield* (yield* SshTransport).transact(
          dedicatedStream(endpoint, remote),
          (lease) =>
            Effect.gen(function* () {
              const passwordLine = Buffer.from("one-shot-secret\n", "utf8");
              const write = yield* Effect.fork(
                lease.writeSensitive(passwordLine),
              );
              yield* Deferred.await(sinkEntered);
              expect(Option.isNone(yield* Fiber.poll(write))).toBe(true);
              yield* Deferred.succeed(allowSink, undefined);
              yield* Fiber.join(write);
              passwordLine.fill(0);
              yield* lease.closeInput;
            }),
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(
      Buffer.concat(received.map((chunk) => Buffer.from(chunk))).toString(
        "utf8",
      ),
    ).toBe("one-shot-secret\n");
  });

  it("rejects a duplex transaction whose remote child exits non-zero", async () => {
    const layer = await testLayer(
      (command) =>
        remoteText(command).includes("release-bridge")
          ? { code: 70 }
          : {},
      [],
      [],
    );

    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const endpoint = yield* parseSshEndpoint("linux-station");
          const remote = yield* makeRemoteCommand(
            "/usr/libexec/vellum-release-bridge",
          );
          return yield* (yield* SshTransport).transact(
            dedicatedStream(endpoint, remote),
            (lease) => lease.closeInput,
          );
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(SshExitError);
      expect((result.failure as SshExitError).code).toBe(70);
    }
  });

  it("rejects writes after the process input pump fails", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const layer = await testLayer(
      (command) =>
        remoteText(command).includes("hermes")
          ? { running: true, stdin: Sink.fail(new ProcessFailure()) }
          : {},
      calls,
      releases,
    );

    const result = await Effect.runPromise(
      Effect.result(
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

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(SshIoError);
  });

  it("rejects readiness when the stream exits first or is closed by the callback", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const layer = await testLayer(() => ({}), calls, releases);

    const exitedFirst = await Effect.runPromise(
      Effect.result(
        Effect.scoped(
          Effect.gen(function* () {
            const endpoint = yield* parseSshEndpoint("remote-a");
            const remote = yield* makeRemoteCommand("already-exited");
            return yield* (yield* SshTransport).connect(
              dedicatedStream(endpoint, remote),
              (_lease, confirm) =>
                Effect.sleep(20).pipe(Effect.as(confirm("late"))),
            );
          }),
        ).pipe(Effect.provide(layer)),
      ),
    );
    expect(Result.isFailure(exitedFirst)).toBe(true);
    if (Result.isFailure(exitedFirst))
      expect(exitedFirst.left).toBeInstanceOf(SshExitError);

    const closedInCallback = await Effect.runPromise(
      Effect.result(
        Effect.scoped(
          Effect.gen(function* () {
            const endpoint = yield* parseSshEndpoint("remote-a");
            const remote = yield* makeRemoteCommand("long-stream");
            const runningLayer = yield* Effect.succeed(undefined);
            void runningLayer;
            return yield* (yield* SshTransport).connect(
              dedicatedStream(endpoint, remote),
              (lease, confirm) =>
                lease.close.pipe(Effect.as(confirm("closed"))),
            );
          }),
        ).pipe(
          Effect.provide(
            await testLayer(
              (command) =>
                remoteText(command).includes("long-stream")
                  ? { running: true }
                  : {},
              [],
              [],
            ),
          ),
        ),
      ),
    );
    expect(Result.isFailure(closedInCallback)).toBe(true);
    if (Result.isFailure(closedInCallback))
      expect(closedInCallback.left).toBeInstanceOf(SshIoError);
  });

  it("lets Station readiness drain stdout before classifying an already-finished exit", async () => {
    const layer = await testLayer(
      (command) =>
        remoteText(command).includes("station-negotiation")
          ? {
              code: 64,
              stdout: encoder.encode("peer-bytes-before-exit\n"),
            }
          : {},
      [],
      [],
    );

    const result = await Effect.runPromise(
      Effect.result(
        Effect.scoped(
          Effect.gen(function* () {
            const endpoint = yield* parseSshEndpoint("linux-station");
            const remote = yield* makeRemoteCommand(
              "station-negotiation",
            );
            return yield* (
              yield* SshTransport
            ).connectWithExitObservation(
              dedicatedStream(endpoint, remote),
              (lease) =>
                Effect.gen(function* () {
                  const stdout = yield* Stream.runFold(
                    lease.stdout,
                    "",
                    (body, chunk) =>
                      body + Buffer.from(chunk).toString("utf8"),
                  );
                  const code = yield* lease.exitCode;
                  return yield* Effect.fail({
                    _tag: "ObservedStationExit" as const,
                    code,
                    stdout,
                  });
                }),
            );
          }),
        ).pipe(Effect.provide(layer)),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toEqual({
        _tag: "ObservedStationExit",
        code: 64,
        stdout: "peer-bytes-before-exit\n",
      });
    }
  });

  it("keeps daemon handoff inside admission until domain readiness", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const layer = await testLayer(
      (command) =>
        remoteText(command).includes("nohup")
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
      (command) => (command.args.includes("-O") ? {} : { running: true }),
      calls,
      releases,
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fireTimeout = yield* Deferred.make<void>();
        let observedTimeoutMs: number | undefined;
        const clock: Clock.Clock = {
          [Clock.ClockTypeId]: Clock.ClockTypeId,
          unsafeCurrentTimeMillis: () => 0,
          currentTimeMillis: Effect.succeed(0),
          unsafeCurrentTimeNanos: () => 0n,
          currentTimeNanos: Effect.succeed(0n),
          sleep: (duration) =>
            Effect.sync(() => {
              observedTimeoutMs = Duration.toMillis(duration);
            }).pipe(Effect.zipRight(Deferred.await(fireTimeout))),
        };
        const operation = Effect.gen(function* () {
          const endpoint = yield* parseSshEndpoint("remote-a");
          const remote = yield* makeRemoteCommand("never");
          return yield* (yield* SshTransport).run(
            oneShot(endpoint, remote, { budget: "short" }),
          );
        }).pipe(Effect.provide(layer), Effect.withClock(clock), Effect.result);
        const fiber = yield* Effect.fork(operation);
        while (
          !calls.some((command) => remoteText(command).includes("never"))
        ) {
          yield* Effect.yieldNow();
        }
        yield* Deferred.succeed(fireTimeout, undefined);
        return { result: yield* Fiber.join(fiber), observedTimeoutMs };
      }),
    );

    expect(result.observedTimeoutMs).toBe(6_000);
    expect(Result.isFailure(result.result)).toBe(true);
    if (Result.isFailure(result.result)) {
      expect(result.result.failure).toBeInstanceOf(SshTimeoutError);
      expect((result.result.failure as SshTimeoutError).timeoutMs).toBe(6_000);
    }
    expect(
      releases.some((command) => remoteText(command).includes("never")),
    ).toBe(true);
  });

  it("teardown issues -O exit against the endpoint's shared ControlMaster", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    const layer = await testLayer(() => ({}), calls, releases);

    await Effect.runPromise(
      Effect.gen(function* () {
        const endpoint = yield* parseSshEndpoint("remote-a");
        yield* (yield* SshTransport).teardown(endpoint);
      }).pipe(Effect.provide(layer)),
    );

    const exitCall = calls.find(
      (command) => command.args.includes("-O") && command.args.includes("exit"),
    );
    expect(exitCall).toBeDefined();
    expect(exitCall!.args.at(-1)).toBe("remote-a");
    // Same ControlPath template as the shared master it is exiting — ssh
    // resolves the identical socket for this endpoint.
    expect(exitCall!.args.some((arg) => arg.startsWith("ControlPath="))).toBe(
      true,
    );
  });

  it("teardown is best-effort: an already-gone master never fails or throws", async () => {
    const calls: Command.StandardCommand[] = [];
    const releases: Command.StandardCommand[] = [];
    // ssh -O exit against a socket with no listening master exits non-zero.
    const layer = await testLayer(() => ({ code: 255 }), calls, releases);

    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const endpoint = yield* parseSshEndpoint("remote-a");
          yield* (yield* SshTransport).teardown(endpoint);
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(Result.isSuccess(result)).toBe(true);
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
            () =>
              Effect.sync(() => {
                releases.push(flattened);
              }),
          );
        }
        return Effect.acquireRelease(
          Effect.sync(() => {
            calls.push(flattened);
            active += 1;
            maxActive = Math.max(maxActive, active);
            const hostActive = (activeByEndpoint.get(endpoint) ?? 0) + 1;
            activeByEndpoint.set(endpoint, hostActive);
            maxByEndpoint.set(
              endpoint,
              Math.max(maxByEndpoint.get(endpoint) ?? 0, hostActive),
            );
            return {
              pid: pid++,
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
            } satisfies ProcessHandle;
          }),
          () =>
            Effect.sync(() => {
              active -= 1;
              activeByEndpoint.set(
                endpoint,
                (activeByEndpoint.get(endpoint) ?? 1) - 1,
              );
              releases.push(flattened);
            }),
        );
      },
    });
    const layer = SshTransportLayer.pipe(
      Layer.provide(Layer.succeed(ProcessSpawner, spawner)),
      Layer.provide(NodeFileSystem.layer),
      Layer.provide(
        Layer.succeed(SshTransportConfig, {
          controlDir: join(root, "control"),
          envExecutable: "/usr/bin/env",
          sshExecutable: "/usr/bin/ssh",
          environment: { HOME: root, PATH: "/usr/bin:/bin" },
          maxConcurrentDials: 3,
          maxConcurrentDialsPerEndpoint: 2,
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const endpointA = yield* parseSshEndpoint("host-a");
          const endpointB = yield* parseSshEndpoint("host-b");
          const command = yield* makeRemoteCommand("hold");
          const ssh = yield* SshTransport;
          const fibers = yield* Effect.forEach([0, 1, 2, 3], () =>
            Effect.fork(ssh.run(oneShot(endpointA, command))),
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
