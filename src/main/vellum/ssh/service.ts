import * as FileSystem from "@effect/platform/FileSystem";
import type * as Command from "@effect/platform/Command";
import { randomUUID } from "node:crypto";
import {
  Context,
  Deferred,
  Effect,
  ExecutionStrategy,
  Exit,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect";
import type { SshEndpoint, SshError } from "./domain";
import {
  SshExitError,
  SshForwardError,
  SshIoError,
  SshOutputLimitError,
  SshSetupError,
  SshSpawnError,
  SshTimeoutError,
} from "./domain";
import type {
  DaemonHandoffProgram,
  ForwardProgram,
  OneShotProgram,
  ScopedStreamProgram,
} from "./program";
import { createSshProgramCompiler } from "./program";
import { ProcessFailure, ProcessSpawner, type ProcessHandle } from "./process-spawner";

const STDOUT_LIMIT_BYTES = 8 * 1024 * 1024;
const STDERR_LIMIT_BYTES = 256 * 1024;
const INPUT_CHUNK_LIMIT_BYTES = 1024 * 1024;
const INPUT_QUEUE_CAPACITY = 64;
const FORWARD_POLL_MS = 40;

export interface SshCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface SshLease {
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, SshError>;
  readonly closeInput: Effect.Effect<void, SshError>;
  readonly stdout: Stream.Stream<Uint8Array, SshError>;
  readonly stderr: Stream.Stream<Uint8Array, SshError>;
  readonly exitCode: Effect.Effect<number, SshError>;
  readonly close: Effect.Effect<void>;
}

declare const LocalForwardSocketTypeId: unique symbol;
export type LocalForwardSocket = string & {
  readonly [LocalForwardSocketTypeId]: typeof LocalForwardSocketTypeId;
};

export interface SshForwardLease {
  readonly localSocket: LocalForwardSocket;
  readonly close: Effect.Effect<void>;
  readonly exitCode: Effect.Effect<number, SshError>;
}

const ReadyTypeId: unique symbol = Symbol("@vellum/ssh/Ready");

export interface SshReady<A> {
  readonly [ReadyTypeId]: typeof ReadyTypeId;
  readonly value: A;
}

export type ConfirmSshReady = <A>(value: A) => SshReady<A>;

export class SshTransport extends Context.Tag("@vellum/SshTransport")<
  SshTransport,
  {
    readonly run: (program: OneShotProgram) => Effect.Effect<SshCommandResult, SshError>;
    readonly connect: <A, E, R>(
      program: ScopedStreamProgram,
      awaitReady: (lease: SshLease, confirm: ConfirmSshReady) => Effect.Effect<SshReady<A>, E, R>,
    ) => Effect.Effect<A, SshError | E, R | Scope.Scope>;
    readonly forward: (
      program: ForwardProgram,
    ) => Effect.Effect<SshForwardLease, SshError, Scope.Scope>;
    readonly handoff: <A, E, R>(
      program: DaemonHandoffProgram,
      awaitReady: (confirm: ConfirmSshReady) => Effect.Effect<SshReady<A>, E, R>,
    ) => Effect.Effect<A, SshError | E, R>;
    readonly warm: (endpoint: SshEndpoint) => Effect.Effect<void, SshError>;
  }
>() {}

export class SshTransportConfig extends Context.Tag("@vellum/ssh/SshTransportConfig")<
  SshTransportConfig,
  {
    readonly controlDir: string;
    readonly envExecutable: string;
    readonly sshExecutable: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly maxConcurrentDials: number;
    readonly maxConcurrentDialsPerEndpoint: number;
  }
>() {}

interface Collected {
  readonly chunks: ReadonlyArray<Uint8Array>;
  readonly bytes: number;
}

interface InputChunk {
  readonly _tag: "Chunk";
  readonly bytes: Uint8Array;
}

interface InputEnd {
  readonly _tag: "End";
}

type InputMessage = InputChunk | InputEnd;

interface InternalLease extends SshLease {
  readonly isRunning: Effect.Effect<boolean, SshError>;
  readonly scope: Scope.CloseableScope;
}

const asText = (collected: Collected): string =>
  Buffer.concat(collected.chunks.map((chunk) => Buffer.from(chunk)), collected.bytes).toString("utf8");

const collectBounded = (
  stream: Stream.Stream<Uint8Array, ProcessFailure>,
  endpoint: SshEndpoint,
  operation: string,
  streamName: "stdout" | "stderr",
  limitBytes: number,
): Effect.Effect<Collected, SshError> =>
  Stream.runFoldEffect(stream, { chunks: [], bytes: 0 } as Collected, (state, chunk) => {
    const bytes = state.bytes + chunk.byteLength;
    return bytes > limitBytes
      ? Effect.fail(
          new SshOutputLimitError({
            endpoint,
            operation,
            stream: streamName,
            limitBytes,
          }),
        )
      : Effect.succeed({ chunks: [...state.chunks, Uint8Array.from(chunk)], bytes });
  }).pipe(
    Effect.mapError((error) =>
      error instanceof ProcessFailure
        ? new SshIoError({ endpoint, operation, message: "SSH process I/O failed" })
        : error,
    ),
  );

export const SshTransportLayer = Layer.scoped(
  SshTransport,
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* SshTransportConfig;
    const owner = yield* Scope.Scope;
    const compiler = createSshProgramCompiler(config);
    const dialPermits = yield* Effect.makeSemaphore(config.maxConcurrentDials);
    const endpointPermits = new Map<string, Effect.Semaphore>();
    const warmLocks = new Map<string, Effect.Semaphore>();
    const masters = new Map<string, SshEndpoint>();

    const confirm: ConfirmSshReady = <A>(value: A): SshReady<A> => ({
      [ReadyTypeId]: ReadyTypeId,
      value,
    });

    const ioError = (endpoint: SshEndpoint, operation: string, message = "SSH process I/O failed") =>
      new SshIoError({ endpoint, operation, message });

    const forwardError = (endpoint: SshEndpoint, message: string) =>
      new SshForwardError({ endpoint, message });

    const ensureControlDir = (endpoint: SshEndpoint): Effect.Effect<void, SshSetupError> =>
      fs.makeDirectory(config.controlDir, { recursive: true, mode: 0o700 }).pipe(
        Effect.zipRight(fs.chmod(config.controlDir, 0o700)),
        Effect.mapError(() =>
          new SshSetupError({
            endpoint,
            message: "SSH control directory could not be secured",
          }),
        ),
      );

    const semaphoreFor = (endpoint: SshEndpoint): Effect.Semaphore => {
      const key = String(endpoint);
      const existing = endpointPermits.get(key);
      if (existing) return existing;
      const created = Effect.unsafeMakeSemaphore(config.maxConcurrentDialsPerEndpoint);
      endpointPermits.set(key, created);
      return created;
    };

    const withDial = <A, E, R>(
      endpoint: SshEndpoint,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      semaphoreFor(endpoint).withPermits(1)(dialPermits.withPermits(1)(effect));

    const acquire = (
      endpoint: SshEndpoint,
      operation: string,
      command: Command.Command,
    ): Effect.Effect<ProcessHandle, SshSpawnError, Scope.Scope> =>
      spawner.start(command).pipe(
        Effect.mapError(() =>
          new SshSpawnError({ endpoint, operation, message: "SSH process could not be started" }),
        ),
      );

    const runProcess = (
      endpoint: SshEndpoint,
      operation: string,
      command: Command.Command,
      input?: Uint8Array,
    ): Effect.Effect<{ readonly result: SshCommandResult; readonly code: number }, SshError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* acquire(endpoint, operation, command);
          const completed = yield* Effect.all(
            {
              input: Stream.run(
                input === undefined ? Stream.empty : Stream.make(Uint8Array.from(input)),
                process.stdin,
              ).pipe(Effect.mapError(() => ioError(endpoint, operation))),
              stdout: collectBounded(
                process.stdout,
                endpoint,
                operation,
                "stdout",
                STDOUT_LIMIT_BYTES,
              ),
              stderr: collectBounded(
                process.stderr,
                endpoint,
                operation,
                "stderr",
                STDERR_LIMIT_BYTES,
              ),
              code: process.exitCode.pipe(Effect.mapError(() => ioError(endpoint, operation))),
            },
            { concurrency: "unbounded" },
          );
          return {
            result: { stdout: asText(completed.stdout), stderr: asText(completed.stderr) },
            code: completed.code,
          };
        }),
      );

    const runChecked = (
      endpoint: SshEndpoint,
      operation: string,
      command: Command.Command,
      timeoutMs: number,
      input?: Uint8Array,
    ): Effect.Effect<SshCommandResult, SshError> =>
      runProcess(endpoint, operation, command, input).pipe(
        Effect.flatMap(({ result, code }) =>
          code === 0
            ? Effect.succeed(result)
            : Effect.fail(new SshExitError({ endpoint, operation, code })),
        ),
        Effect.timeoutFail({
          duration: timeoutMs,
          onTimeout: () => new SshTimeoutError({ endpoint, operation, timeoutMs }),
        }),
      );

    const openLease = (
      endpoint: SshEndpoint,
      operation: string,
      command: Command.Command,
    ): Effect.Effect<InternalLease, SshSpawnError, Scope.Scope> =>
      Effect.gen(function* () {
        const caller = yield* Scope.Scope;
        const child = yield* Scope.fork(caller, ExecutionStrategy.sequential);
        const process = yield* acquire(endpoint, operation, command).pipe(
          Scope.extend(child),
          Effect.catchAll((error) =>
            Scope.close(child, Exit.fail(error)).pipe(Effect.zipRight(Effect.fail(error))),
          ),
        );
        const queue = yield* Queue.bounded<InputMessage>(INPUT_QUEUE_CAPACITY);
        const inputDone = yield* Deferred.make<void, SshError>();
        const inputOpen = yield* Ref.make(true);
        const inputLock = yield* Effect.makeSemaphore(1);
        const mappedInput = Stream.fromQueue(queue).pipe(
          Stream.takeUntil((message) => message._tag === "End"),
          Stream.filterMap((message) =>
            message._tag === "Chunk" ? Option.some(message.bytes) : Option.none(),
          ),
        );
        const pump = Stream.run(mappedInput, process.stdin).pipe(
          Effect.mapError(() => ioError(endpoint, operation)),
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(inputDone, exit)),
          Effect.ignore,
        );
        yield* Effect.forkIn(pump, child);
        yield* Scope.addFinalizer(child, Queue.shutdown(queue));

        const inputUnavailable: Effect.Effect<never, SshError> = Deferred.await(inputDone).pipe(
          Effect.flatMap(() =>
            Effect.fail(ioError(endpoint, operation, "SSH process input is already closed")),
          ),
        );
        const offer = (message: InputMessage): Effect.Effect<void, SshError> =>
          Effect.raceFirst(
            Queue.offer(queue, message).pipe(Effect.asVoid),
            inputUnavailable,
          );
        const write = (bytes: Uint8Array): Effect.Effect<void, SshError> =>
          inputLock.withPermits(1)(
            Effect.gen(function* () {
              if (bytes.byteLength > INPUT_CHUNK_LIMIT_BYTES) {
                return yield* Effect.fail(
                  ioError(endpoint, operation, "SSH input chunk exceeds the 1 MiB write boundary"),
                );
              }
              if (!(yield* Ref.get(inputOpen))) {
                return yield* Effect.fail(
                  ioError(endpoint, operation, "SSH process input is already closed"),
                );
              }
              yield* offer({ _tag: "Chunk", bytes: Uint8Array.from(bytes) });
            }),
          );
        const closeInput = inputLock.withPermits(1)(
          Ref.getAndSet(inputOpen, false).pipe(
            Effect.flatMap((wasOpen) => wasOpen ? offer({ _tag: "End" }) : Effect.void),
          ),
        ).pipe(Effect.zipRight(Deferred.await(inputDone)));

        return {
          write,
          closeInput,
          stdout: process.stdout.pipe(Stream.mapError(() => ioError(endpoint, operation))),
          stderr: process.stderr.pipe(Stream.mapError(() => ioError(endpoint, operation))),
          exitCode: process.exitCode.pipe(Effect.mapError(() => ioError(endpoint, operation))),
          isRunning: process.isRunning.pipe(Effect.mapError(() => ioError(endpoint, operation))),
          close: Scope.close(child, Exit.void).pipe(Effect.ignore),
          scope: child,
        };
      });

    const rememberMaster = (endpoint: SshEndpoint): void => {
      masters.set(String(endpoint), endpoint);
    };

    const run = (program: OneShotProgram): Effect.Effect<SshCommandResult, SshError> =>
      Effect.try({
        try: () => compiler.oneShot(program),
        catch: () => new SshSetupError({
          endpoint: "invalid-program",
          message: "SSH operation was not created by the policy surface",
        }),
      }).pipe(
        Effect.flatMap((compiled) =>
          withDial(
            compiled.endpoint,
            ensureControlDir(compiled.endpoint).pipe(
              Effect.tap(() => Effect.sync(() => rememberMaster(compiled.endpoint))),
              Effect.zipRight(
                runChecked(
                  compiled.endpoint,
                  "one-shot",
                  compiled.command,
                  compiled.timeoutMs,
                  compiled.input,
                ),
              ),
            ),
          ),
        ),
      );

    const connect: Context.Tag.Service<typeof SshTransport>["connect"] = (program, awaitReady) =>
      Effect.try({
        try: () => compiler.stream(program),
        catch: () => new SshSetupError({
          endpoint: "invalid-program",
          message: "SSH operation was not created by the policy surface",
        }),
      }).pipe(
        Effect.flatMap((compiled) => {
          const setup = compiled.connection === "shared"
            ? ensureControlDir(compiled.endpoint).pipe(
                Effect.tap(() => Effect.sync(() => rememberMaster(compiled.endpoint))),
              )
            : Effect.void;
          return withDial(
            compiled.endpoint,
            setup.pipe(
              Effect.zipRight(openLease(compiled.endpoint, "stream", compiled.command)),
              Effect.flatMap((lease) => {
                const exited: Effect.Effect<never, SshError> = lease.exitCode.pipe(
                  Effect.flatMap((code) =>
                    Effect.fail(new SshExitError({
                      endpoint: compiled.endpoint,
                      operation: "stream",
                      code,
                    })),
                  ),
                );
                return Effect.raceFirst(awaitReady(lease, confirm), exited).pipe(
                  Effect.timeoutFail({
                    duration: compiled.readinessTimeoutMs,
                    onTimeout: () =>
                      new SshTimeoutError({
                        endpoint: compiled.endpoint,
                        operation: "stream",
                        timeoutMs: compiled.readinessTimeoutMs,
                      }),
                  }),
                  Effect.flatMap((ready) =>
                    lease.isRunning.pipe(
                      Effect.flatMap((running) =>
                        running
                          ? Effect.succeed(ready.value)
                          : Effect.fail(new SshIoError({
                              endpoint: compiled.endpoint,
                              operation: "stream",
                              message: "SSH stream exited during readiness confirmation",
                            })),
                      ),
                    ),
                  ),
                  Effect.onError(() => lease.close),
                );
              }),
            ),
          );
        }),
      );

    const forward: Context.Tag.Service<typeof SshTransport>["forward"] = (program) =>
      Effect.gen(function* () {
        const compiled = yield* Effect.try({
          try: () => compiler.forward(program, randomUUID().replaceAll("-", "")),
          catch: () => new SshSetupError({
            endpoint: "invalid-program",
            message: "SSH forward operation or owned socket path is invalid",
          }),
        });
        return yield* withDial(
          compiled.endpoint,
          Effect.gen(function* () {
            yield* ensureControlDir(compiled.endpoint);
            yield* fs.remove(compiled.localSocket, { force: true }).pipe(Effect.ignore);
            yield* fs.remove(compiled.controlSocket, { force: true }).pipe(Effect.ignore);
            const master = yield* openLease(compiled.endpoint, "forward-master", compiled.master);
            const cleanup = Effect.gen(function* () {
              yield* runChecked(
                compiled.endpoint,
                "forward-cancel",
                compiled.cancel,
                2_000,
              ).pipe(Effect.interruptible, Effect.ignore);
              yield* runChecked(
                compiled.endpoint,
                "forward-exit",
                compiled.exit,
                2_000,
              ).pipe(Effect.interruptible, Effect.ignore);
              yield* fs.remove(compiled.localSocket, { force: true }).pipe(Effect.ignore);
              yield* fs.remove(compiled.controlSocket, { force: true }).pipe(Effect.ignore);
            });
            yield* Scope.addFinalizer(master.scope, cleanup);
            yield* Effect.forkIn(Stream.runDrain(master.stdout).pipe(Effect.ignore), master.scope);
            yield* Effect.forkIn(Stream.runDrain(master.stderr).pipe(Effect.ignore), master.scope);

            const masterExited: Effect.Effect<never, SshError> = master.exitCode.pipe(
              Effect.matchEffect({
                onFailure: () => Effect.fail(
                  forwardError(compiled.endpoint, "SSH forward master failed before readiness"),
                ),
                onSuccess: (code) => Effect.fail(
                  forwardError(
                    compiled.endpoint,
                    `SSH forward master exited before readiness (${code})`,
                  ),
                ),
              }),
            );
            const waitForControl: Effect.Effect<void, SshError> = Effect.suspend(() =>
              Effect.raceFirst(
                runChecked(
                  compiled.endpoint,
                  "forward-check",
                  compiled.check,
                  1_000,
                ).pipe(
                  Effect.asVoid,
                  Effect.catchAll(() =>
                    Effect.sleep(FORWARD_POLL_MS).pipe(Effect.zipRight(waitForControl)),
                  ),
                ),
                masterExited,
              ),
            );
            const socketExists = fs.exists(compiled.localSocket).pipe(
              Effect.mapError(() =>
                forwardError(compiled.endpoint, "forward socket readiness check failed"),
              ),
            );
            const waitForSocket: Effect.Effect<void, SshError> = Effect.suspend(() =>
              Effect.raceFirst(
                socketExists.pipe(
                  Effect.flatMap((exists) =>
                    exists
                      ? Effect.void
                      : Effect.sleep(FORWARD_POLL_MS).pipe(Effect.zipRight(waitForSocket)),
                  ),
                ),
                masterExited,
              ),
            );
            const setup = waitForControl.pipe(
              Effect.zipRight(
                runChecked(
                  compiled.endpoint,
                  "forward-request",
                  compiled.request,
                  4_000,
                ),
              ),
              Effect.zipRight(waitForSocket),
              Effect.timeoutFail({
                duration: compiled.readinessTimeoutMs,
                onTimeout: () => new SshTimeoutError({
                  endpoint: compiled.endpoint,
                  operation: "forward",
                  timeoutMs: compiled.readinessTimeoutMs,
                }),
              }),
              Effect.onError(() => master.close),
            );
            yield* setup;
            return {
              localSocket: compiled.localSocket as LocalForwardSocket,
              close: master.close,
              exitCode: master.exitCode,
            };
          }),
        );
      });

    const handoff: Context.Tag.Service<typeof SshTransport>["handoff"] = (program, awaitReady) =>
      Effect.try({
        try: () => compiler.daemonHandoff(program),
        catch: () => new SshSetupError({
          endpoint: "invalid-program",
          message: "SSH operation was not created by the policy surface",
        }),
      }).pipe(
        Effect.flatMap((compiled) =>
          withDial(
            compiled.endpoint,
            Effect.gen(function* () {
              yield* ensureControlDir(compiled.endpoint);
              rememberMaster(compiled.endpoint);
              const result = yield* runChecked(
                compiled.endpoint,
                "daemon-handoff",
                compiled.command,
                compiled.readinessTimeoutMs,
              );
              if (!/^\d+$/u.test(result.stdout.trim())) {
                return yield* Effect.fail(
                  new SshIoError({
                    endpoint: compiled.endpoint,
                    operation: "daemon-handoff",
                    message: "remote daemon handoff did not return a process receipt",
                  }),
                );
              }
              const ready = yield* awaitReady(confirm).pipe(
                Effect.timeoutFail({
                  duration: compiled.readinessTimeoutMs,
                  onTimeout: () =>
                    new SshTimeoutError({
                      endpoint: compiled.endpoint,
                      operation: "daemon-handoff",
                      timeoutMs: compiled.readinessTimeoutMs,
                    }),
                }),
              );
              return ready.value;
            }),
          ),
        ),
      );

    const warm = (endpoint: SshEndpoint): Effect.Effect<void, SshError> => {
      let lock = warmLocks.get(String(endpoint));
      if (!lock) {
        lock = Effect.unsafeMakeSemaphore(1);
        warmLocks.set(String(endpoint), lock);
      }
      return lock.withPermits(1)(
        withDial(
          endpoint,
          ensureControlDir(endpoint).pipe(
            Effect.tap(() => Effect.sync(() => rememberMaster(endpoint))),
            Effect.zipRight(
              runChecked(endpoint, "master-warm", compiler.masterWarm(endpoint), 8_000),
            ),
            Effect.asVoid,
          ),
        ),
      );
    };

    yield* Scope.addFinalizer(
      owner,
      Effect.suspend(() =>
        Effect.forEach(
          [...masters.values()],
          (endpoint) =>
            runChecked(
              endpoint,
              "master-exit",
              compiler.masterExit(endpoint),
              4_000,
            ).pipe(Effect.interruptible, Effect.ignore),
          { concurrency: 4, discard: true },
        ),
      ),
    );

    return SshTransport.of({ run, connect, forward, handoff, warm });
  }),
);
