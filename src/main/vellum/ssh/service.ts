// V4: FileSystem → effect/FileSystem - Command → effect/unstable/process/ChildProcess
// Map: src/cli/effect-v4-import-map.ts
import * as FileSystem from "effect/FileSystem";
import type * as Command from "effect/unstable/process/ChildProcess";
import { randomUUID } from "node:crypto";
import { Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Queue,
  Ref,
  Result,
  Scope,
  Sink,
  Stream, Semaphore } from "effect";
import type { SshEndpoint, SshError, SshTarget } from "./domain";
import {
  inspectSshTarget,
  SshExitError,
  SshForwardError,
  SshIoError,
  SshProcessError,
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
import { classifySshStderr } from "./format";
import { createSshProgramCompiler } from "./program";
import {
  ProcessFailure,
  ProcessSpawner,
  type ProcessHandle,
} from "./process-spawner";

const STDOUT_LIMIT_BYTES = 8 * 1024 * 1024;
const STDERR_LIMIT_BYTES = 256 * 1024;
const INPUT_CHUNK_LIMIT_BYTES = 1024 * 1024;
const INPUT_QUEUE_CAPACITY = 64;
const FORWARD_POLL_MS = 40;

export interface SshCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** A non-zero transfer exit retains bounded diagnostic output for its caller. */
export class SshTransferExitError extends Error {
  readonly _tag = "SshTransferExitError";

  constructor(
    readonly endpoint: SshEndpoint,
    readonly code: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`SSH transfer exited with code ${code}`);
    this.name = "SshTransferExitError";
  }
}

export interface SshLease {
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, SshError>;
  /**
   * Writes one secret frame, waits until the sink has consumed it, and
   * zeroizes the transport-owned copy before returning.
   */
  readonly writeSensitive: (
    bytes: Uint8Array,
  ) => Effect.Effect<void, SshError>;
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

/**
 * S4 (effect@3.21): single canonical Tag id `@vellum/SshTransport`.
 * `Context.Service` is unavailable until the product pins Effect V4 — do not
 * dual-define Tag + Service. Shape is `SshTransportShape` for callers.
 * V4 map: `class SshTransport extends Context.Service<SshTransport, Shape>()("@vellum/SshTransport")`.
 * @see docs/END_STATE-effect-foundation.md §S4
 * @see Playground/effect/migration/services.md
 */
export class SshTransport extends Context.Service<SshTransport,
  {
    readonly run: (
      program: OneShotProgram,
    ) => Effect.Effect<SshCommandResult, SshError>;
    /**
     * Streams a bounded local byte source into a remote command. The transport
     * owns the SSH lease for the whole operation, including cancellation.
     */
    readonly transfer: <E, R>(
      program: ScopedStreamProgram,
      input: Stream.Stream<Uint8Array, E, R>,
      timeoutMs: number,
    ) => Effect.Effect<SshCommandResult, SshError | SshTransferExitError | E, R>;
    readonly connect: <A, E, R>(
      program: ScopedStreamProgram,
      awaitReady: (
        lease: SshLease,
        confirm: ConfirmSshReady,
      ) => Effect.Effect<SshReady<A>, E, R>,
    ) => Effect.Effect<A, SshError | E, R | Scope.Scope>;
    /**
     * Station negotiation readiness path.
     *
     * Unlike `connect`, the transport does not race child exit against the
     * callback. The callback owns exit observation so it can distinguish a
     * peer response from helper exit after draining stdout to EOF. A
     * confirmed live connection is still checked exactly like `connect`.
     */
    readonly connectWithExitObservation: <A, E, R>(
      program: ScopedStreamProgram,
      awaitReady: (
        lease: SshLease,
        confirm: ConfirmSshReady,
      ) => Effect.Effect<SshReady<A>, E, R>,
    ) => Effect.Effect<A, SshError | E, R | Scope.Scope>;
    /**
     * Runs one finite duplex protocol over one scoped SSH child and requires a
     * clean remote exit. The callback owns stdin sequencing and must close it
     * when its protocol has no more frames to send.
     */
    readonly transact: <A, E, R>(
      program: ScopedStreamProgram,
      use: (lease: SshLease) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, SshError | E, R>;
    readonly forward: (
      program: ForwardProgram,
    ) => Effect.Effect<SshForwardLease, SshError, Scope.Scope>;
    readonly handoff: <A, E, R>(
      program: DaemonHandoffProgram,
      awaitReady: (
        confirm: ConfirmSshReady,
      ) => Effect.Effect<SshReady<A>, E, R>,
    ) => Effect.Effect<A, SshError | E, R>;
    readonly warm: (target: SshTarget) => Effect.Effect<void, SshError>;
    /**
     * Explicit, best-effort `-O exit` against the endpoint's SHARED
     * ControlMaster. Reserved for the host-removal/edit operator action —
     * never wired into a Scope/Layer finalizer (see the never-teardown-on-
     * dispose note above `SshTransportLayer`). Stock OpenSSH itself unlinks
     * the ControlPath socket on a successful exit, so no separate file
     * cleanup is attempted here.
     */
    readonly teardown: (endpoint: SshEndpoint) => Effect.Effect<void>;
  }>()("@vellum/SshTransport") {}

/** Canonical service shape for `SshTransport` (one id, one shape — no dual path). */
export type SshTransportShape = Context.Service.Shape<typeof SshTransport>;

/**
 * S4: single Tag `@vellum/ssh/SshTransportConfig`. Same V4 staging as SshTransport.
 */
export class SshTransportConfig extends Context.Service<SshTransportConfig,
  {
    readonly controlDir: string;
    readonly envExecutable: string;
    readonly sshExecutable: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly maxConcurrentDials: number;
    readonly maxConcurrentDialsPerEndpoint: number;
  }>()("@vellum/ssh/SshTransportConfig") {}

export type SshTransportConfigShape = Context.Service.Shape<
  typeof SshTransportConfig
>;

interface Collected {
  readonly chunks: ReadonlyArray<Uint8Array>;
  readonly bytes: number;
}

interface InputChunk {
  readonly _tag: "Chunk";
  readonly bytes: Uint8Array;
}

interface InputBarrier {
  readonly _tag: "Barrier";
  readonly afterPriorWrite: Effect.Effect<void>;
}

interface InputEnd {
  readonly _tag: "End";
}

type InputMessage = InputChunk | InputBarrier | InputEnd;

interface InternalLease extends SshLease {
  readonly isRunning: Effect.Effect<boolean, SshError>;
  readonly scope: Scope.Closeable;
}

const asText = (collected: Collected): string =>
  Buffer.concat(
    collected.chunks.map((chunk) => Buffer.from(chunk)),
    collected.bytes,
  ).toString("utf8");

const collectBounded = (
  stream: Stream.Stream<Uint8Array, ProcessFailure | SshError>,
  endpoint: SshEndpoint,
  operation: string,
  streamName: "stdout" | "stderr",
  limitBytes: number,
): Effect.Effect<Collected, SshError> =>
  Stream.runFoldEffect(
    stream,
    (): Collected => ({ chunks: [], bytes: 0 }),
    (state, chunk) => {
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
        : Effect.succeed({
            chunks: [...state.chunks, Uint8Array.from(chunk)],
            bytes,
          });
    },
  ).pipe(
    Effect.mapError((error) =>
      error instanceof ProcessFailure
        ? new SshProcessError({
            endpoint,
            operation,
            message: `SSH ${operation} closed before it finished`,
          })
        : error,
    ),
  );

/** Transfer treats child death as EOF so exit code and script tags survive. */
const collectTransferOutput = (
  stream: Stream.Stream<Uint8Array, ProcessFailure | SshError>,
  endpoint: SshEndpoint,
  streamName: "stdout" | "stderr",
  limitBytes: number,
): Effect.Effect<Collected, SshError> =>
  collectBounded(
    stream.pipe(
      Stream.catchIf(
        (error): error is SshProcessError => error instanceof SshProcessError,
        () => Stream.empty,
      ),
    ),
    endpoint,
    "transfer",
    streamName,
    limitBytes,
  );

export const SshTransportLayer = Layer.effect(
  SshTransport,
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* SshTransportConfig;
    const compiler = createSshProgramCompiler(config);
    const dialPermits = yield* Semaphore.make(config.maxConcurrentDials);
    const endpointPermits = new Map<string, Semaphore.Semaphore>();
    const warmLocks = new Map<string, Semaphore.Semaphore>();
    // Shared commands may multiplex while one command owns the master, but
    // ControlPersist=no prevents a completed command from leaving an SSH
    // process behind. Do not issue -O exit on ordinary scope disposal: a GUI
    // and headless CLI can still be concurrently using the same ControlPath.

    const confirm: ConfirmSshReady = <A>(value: A): SshReady<A> => ({
      [ReadyTypeId]: ReadyTypeId,
      value,
    });

    const ioError = (
      endpoint: SshEndpoint,
      operation: string,
      message: string,
    ) => new SshIoError({ endpoint, operation, message });

    const processClosed = (
      endpoint: SshEndpoint,
      operation: string,
      message = `SSH ${operation} closed before it finished`,
    ) => new SshProcessError({ endpoint, operation, message });

    const forwardError = (endpoint: SshEndpoint, message: string) =>
      new SshForwardError({ endpoint, message });

    const ensureControlDir = (
      endpoint: SshEndpoint,
    ): Effect.Effect<void, SshSetupError> =>
      fs
        .makeDirectory(config.controlDir, { recursive: true, mode: 0o700 })
        .pipe(
          Effect.andThen(fs.chmod(config.controlDir, 0o700)),
          Effect.mapError(
            () =>
              new SshSetupError({
                endpoint,
                message: "SSH control directory could not be secured",
              }),
          ),
        );

    const semaphoreFor = (endpoint: SshEndpoint): Semaphore.Semaphore => {
      const key = String(endpoint);
      const existing = endpointPermits.get(key);
      if (existing) return existing;
      const created = Semaphore.makeUnsafe(
        config.maxConcurrentDialsPerEndpoint,
      );
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
      spawner
        .start(command)
        .pipe(
          Effect.mapError(
            () =>
              new SshSpawnError({
                endpoint,
                operation,
                message: "SSH process could not be started",
              }),
          ),
        );

    const runProcess = (
      endpoint: SshEndpoint,
      operation: string,
      command: Command.Command,
      input?: Uint8Array,
    ): Effect.Effect<
      { readonly result: SshCommandResult; readonly code: number },
      SshError
    > =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* acquire(endpoint, operation, command);
          const completed = yield* Effect.all(
            {
              input: Stream.run(
                input === undefined
                  ? Stream.empty
                  : Stream.make(Uint8Array.from(input)),
                process.stdin,
              ).pipe(Effect.mapError(() => processClosed(endpoint, operation))),
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
              code: process.exitCode.pipe(
                Effect.mapError(() => processClosed(endpoint, operation)),
              ),
            },
            { concurrency: "unbounded" },
          );
          return {
            result: {
              stdout: asText(completed.stdout),
              stderr: asText(completed.stderr),
            },
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
        Effect.flatMap(({ result, code }) => {
          if (code === 0) return Effect.succeed(result);
          const detail = classifySshStderr(result.stderr);
          return Effect.fail(
            new SshExitError({
              endpoint,
              operation,
              code,
              ...(detail === undefined ? {} : { detail }),
            }),
          );
        }),
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new SshTimeoutError({ endpoint, operation, timeoutMs })),}),
      );

    const openLease = (
      endpoint: SshEndpoint,
      operation: string,
      command: Command.Command,
      cleanupAfterProcess?: Effect.Effect<void>,
    ): Effect.Effect<InternalLease, SshSpawnError, Scope.Scope> =>
      Effect.gen(function* () {
        const caller = yield* Scope.Scope;
        const child = yield* Scope.fork(caller, "sequential");
        // Sequential scopes close finalizers in LIFO order. Register owned-file
        // cleanup before process acquisition so the ProcessSpawner release
        // stops/reaps the child before its socket paths are unlinked.
        if (cleanupAfterProcess !== undefined) {
          yield* Scope.addFinalizer(child, cleanupAfterProcess);
        }
        const process = yield* acquire(endpoint, operation, command).pipe(
          Scope.provide(child),
          Effect.catch((error) =>
            Scope.close(child, Exit.fail(error)).pipe(
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
        const queue = yield* Queue.bounded<InputMessage>(INPUT_QUEUE_CAPACITY);
        const inputDone = yield* Deferred.make<void, SshError>();
        const inputOpen = yield* Ref.make(true);
        const inputLock = yield* Semaphore.make(1);
        const sensitiveCopies = new Set<Uint8Array>();
        const mappedInput = Stream.fromQueue(queue).pipe(
          Stream.takeUntil((message) => message._tag === "End"),
          Stream.mapEffect((message): Effect.Effect<
            Result.Result<Uint8Array, void>
          > =>
            message._tag === "Barrier"
              ? message.afterPriorWrite.pipe(
                  Effect.as(Result.fail(undefined as void)),
                )
              : Effect.succeed(
                  message._tag === "Chunk"
                    ? Result.succeed(message.bytes)
                    : Result.fail(undefined as void),
                ),
          ),
          Stream.filterMap((chunk) => chunk),
        );
        const pump = Stream.run(mappedInput, process.stdin).pipe(
          Effect.mapError(() => processClosed(endpoint, operation)),
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.uninterruptible(
              Ref.set(inputOpen, false).pipe(
                Effect.andThen(Queue.shutdown(queue)),
                Effect.andThen(Deferred.done(inputDone, exit)),
                Effect.asVoid,
              ),
            ),
          ),
        );
        yield* Effect.forkIn(pump, child);
        yield* Scope.addFinalizer(child, Queue.shutdown(queue));
        yield* Scope.addFinalizer(
          child,
          Effect.sync(() => {
            for (const bytes of sensitiveCopies) bytes.fill(0);
            sensitiveCopies.clear();
          }),
        );

        const inputUnavailable: Effect.Effect<never, SshError> = Deferred.await(
          inputDone,
        ).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              processClosed(
                endpoint,
                operation,
                "SSH process input is already closed",
              ),
            ),
          ),
        );
        const offer = (message: InputMessage): Effect.Effect<void, SshError> =>
          Effect.raceFirst(
            Queue.offer(queue, message).pipe(
              Effect.flatMap((accepted) =>
                accepted ? Effect.void : inputUnavailable,
              ),
            ),
            inputUnavailable,
          );
        const write = (bytes: Uint8Array): Effect.Effect<void, SshError> =>
          inputLock.withPermits(1)(
            Effect.gen(function* () {
              if (bytes.byteLength > INPUT_CHUNK_LIMIT_BYTES) {
                return yield* Effect.fail(
                  ioError(
                    endpoint,
                    operation,
                    "SSH input chunk exceeds the 1 MiB write boundary",
                  ),
                );
              }
              if (!(yield* Ref.get(inputOpen))) {
                return yield* Effect.fail(
                  processClosed(
                    endpoint,
                    operation,
                    "SSH process input is already closed",
                  ),
                );
              }
              yield* offer({ _tag: "Chunk", bytes: Uint8Array.from(bytes) });
            }),
          );
        const writeSensitive = (
          bytes: Uint8Array,
        ): Effect.Effect<void, SshError> =>
          inputLock.withPermits(1)(
            Effect.gen(function* () {
              if (bytes.byteLength > INPUT_CHUNK_LIMIT_BYTES) {
                return yield* Effect.fail(
                  ioError(
                    endpoint,
                    operation,
                    "SSH sensitive input chunk exceeds the 1 MiB write boundary",
                  ),
                );
              }
              if (!(yield* Ref.get(inputOpen))) {
                return yield* Effect.fail(
                  processClosed(
                    endpoint,
                    operation,
                    "SSH process input is already closed",
                  ),
                );
              }
              const owned = Uint8Array.from(bytes);
              const flushed = yield* Deferred.make<void, SshError>();
              sensitiveCopies.add(owned);
              const zeroAndConfirm = Effect.sync(() => {
                owned.fill(0);
                sensitiveCopies.delete(owned);
              }).pipe(
                Effect.andThen(Deferred.succeed(flushed, undefined)),
                Effect.asVoid,
              );
              const submitted = offer({
                _tag: "Chunk",
                bytes: owned,
              }).pipe(
                Effect.andThen(
                  offer({
                    _tag: "Barrier",
                    afterPriorWrite: zeroAndConfirm,
                  }),
                ),
                Effect.andThen(
                  Effect.raceFirst(
                    Deferred.await(flushed),
                    inputUnavailable,
                  ),
                ),
              );
              yield* submitted.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (sensitiveCopies.has(owned)) {
                      owned.fill(0);
                      sensitiveCopies.delete(owned);
                    }
                  }),
                ),
              );
            }),
          );
        const closeInput = inputLock
          .withPermits(1)(
            Ref.getAndSet(inputOpen, false).pipe(
              Effect.flatMap((wasOpen) =>
                wasOpen ? offer({ _tag: "End" }) : Effect.void,
              ),
            ),
          )
          .pipe(Effect.andThen(Deferred.await(inputDone)));

        return {
          write,
          writeSensitive,
          closeInput,
          stdout: process.stdout.pipe(
            Stream.mapError(() => processClosed(endpoint, operation)),
          ),
          stderr: process.stderr.pipe(
            Stream.mapError(() => processClosed(endpoint, operation)),
          ),
          exitCode: process.exitCode.pipe(
            Effect.mapError(() => processClosed(endpoint, operation)),
          ),
          isRunning: process.isRunning.pipe(
            Effect.mapError(() => processClosed(endpoint, operation)),
          ),
          close: Scope.close(child, Exit.void).pipe(Effect.ignore),
          scope: child,
        };
      });

    const run = (
      program: OneShotProgram,
    ): Effect.Effect<SshCommandResult, SshError> =>
      Effect.try({
        try: () => compiler.oneShot(program),
        catch: () =>
          new SshSetupError({
            endpoint: "invalid-program",
            message: "SSH operation was not created by the policy surface",
          }),
      }).pipe(
        Effect.flatMap((compiled) =>
          withDial(
            compiled.endpoint,
            ensureControlDir(compiled.endpoint).pipe(
              Effect.andThen(
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

    const connectWithPolicy = <A, E, R>(
      callbackOwnsExit: boolean,
      program: ScopedStreamProgram,
      awaitReady: (
        lease: SshLease,
        confirm: ConfirmSshReady,
      ) => Effect.Effect<SshReady<A>, E, R>,
    ): Effect.Effect<A, SshError | E, R | Scope.Scope> =>
      Effect.try({
        try: () => compiler.stream(program),
        catch: () =>
          new SshSetupError({
            endpoint: "invalid-program",
            message: "SSH operation was not created by the policy surface",
          }),
      }).pipe(
        Effect.flatMap((compiled) => {
          const setup =
            compiled.connection === "shared"
              ? ensureControlDir(compiled.endpoint)
              : Effect.void;
          return withDial(
            compiled.endpoint,
            setup.pipe(
              Effect.andThen(
                openLease(compiled.endpoint, "stream", compiled.command),
              ),
              Effect.flatMap((lease) => {
                const exited: Effect.Effect<never, SshError> =
                  lease.exitCode.pipe(
                    Effect.flatMap((code) =>
                      Effect.fail(
                        new SshExitError({
                          endpoint: compiled.endpoint,
                          operation: "stream",
                          code,
                        }),
                      ),
                    ),
                  );
                const readiness = callbackOwnsExit
                  ? awaitReady(lease, confirm)
                  : Effect.raceFirst(
                      awaitReady(lease, confirm),
                      exited,
                    );
                return readiness.pipe(
                  Effect.timeoutOrElse({
                    duration: compiled.readinessTimeoutMs,
                    orElse: () => Effect.fail(new SshTimeoutError({
                        endpoint: compiled.endpoint,
                        operation: "stream",
                        timeoutMs: compiled.readinessTimeoutMs,
                      })),}),
                  Effect.flatMap((ready) =>
                    lease.isRunning.pipe(
                      Effect.flatMap((running) =>
                        running
                          ? Effect.succeed(ready.value)
                          : Effect.fail(
                              new SshIoError({
                                endpoint: compiled.endpoint,
                                operation: "stream",
                                message:
                                  "SSH stream exited during readiness confirmation",
                              }),
                            ),
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

    const connect: SshTransportShape["connect"] = (
      program,
      awaitReady,
    ) => connectWithPolicy(false, program, awaitReady);

    const connectWithExitObservation: SshTransportShape["connectWithExitObservation"] =
      (program, awaitReady) =>
        connectWithPolicy(true, program, awaitReady);

    const transfer: SshTransportShape["transfer"] = (
      program,
      input,
      timeoutMs,
    ) =>
      Effect.try({
        try: () => compiler.stream(program),
        catch: () =>
          new SshSetupError({
            endpoint: "invalid-program",
            message:
              "SSH transfer operation was not created by the policy surface",
          }),
      }).pipe(
        Effect.flatMap((compiled) => {
          if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            return Effect.fail(
              new SshSetupError({
                endpoint: compiled.endpoint,
                message:
                  "SSH transfer timeout must be a positive finite number",
              }),
            );
          }
          const setup =
            compiled.connection === "shared"
              ? ensureControlDir(compiled.endpoint)
              : Effect.void;
          return withDial(
            compiled.endpoint,
            Effect.scoped(
              setup.pipe(
                Effect.andThen(
                  openLease(compiled.endpoint, "transfer", compiled.command),
                ),
                Effect.flatMap((lease) => {
                const writeInput = Stream.run(
                  input.pipe(
                    Stream.map((chunk) => {
                      if (chunk.byteLength <= INPUT_CHUNK_LIMIT_BYTES) {
                        return [chunk];
                      }
                      const parts: Uint8Array[] = [];
                      for (
                        let offset = 0;
                        offset < chunk.byteLength;
                        offset += INPUT_CHUNK_LIMIT_BYTES
                      ) {
                        parts.push(
                          chunk.subarray(
                            offset,
                            offset + INPUT_CHUNK_LIMIT_BYTES,
                          ),
                        );
                      }
                      return parts;
                    }),
                    Stream.flattenIterable,
                  ),
                  Sink.forEach(lease.write),
                ).pipe(
                  Effect.andThen(lease.closeInput),
                  // If the remote command exits first, interrupt the local
                  // producer now but keep draining its bounded diagnostics.
                  Effect.raceFirst(lease.exitCode.pipe(Effect.asVoid)),
                  Effect.catchIf(
                    (error): error is SshProcessError =>
                      error instanceof SshProcessError,
                    () => Effect.void,
                  ),
                  );
                  return Effect.all(
                    {
                      input: writeInput,
                      stdout: collectTransferOutput(
                        lease.stdout,
                        compiled.endpoint,
                        "stdout",
                        STDOUT_LIMIT_BYTES,
                      ),
                      stderr: collectTransferOutput(
                        lease.stderr,
                        compiled.endpoint,
                        "stderr",
                        STDERR_LIMIT_BYTES,
                      ),
                      code: lease.exitCode,
                    },
                    { concurrency: "unbounded" },
                  ).pipe(
                    Effect.flatMap(({ stdout, stderr, code }) =>
                      code === 0
                        ? Effect.succeed({
                            stdout: asText(stdout),
                            stderr: asText(stderr),
                          })
                      : Effect.fail(
                          new SshTransferExitError(
                            compiled.endpoint,
                            code,
                            asText(stdout),
                            asText(stderr),
                          ),
                        ),
                    ),
                    Effect.timeoutOrElse({
                      duration: timeoutMs,
                      orElse: () => Effect.fail(new SshTimeoutError({
                          endpoint: compiled.endpoint,
                          operation: "transfer",
                          timeoutMs,
                        })),}),
                    Effect.ensuring(lease.close),
                  );
                }),
              ),
            ),
          );
        }),
      );

    const transact: SshTransportShape["transact"] = (
      program,
      use,
    ) =>
      Effect.try({
        try: () => compiler.stream(program),
        catch: () =>
          new SshSetupError({
            endpoint: "invalid-program",
            message:
              "SSH transaction operation was not created by the policy surface",
          }),
      }).pipe(
        Effect.flatMap((compiled) => {
          const setup =
            compiled.connection === "shared"
              ? ensureControlDir(compiled.endpoint)
              : Effect.void;
          return withDial(
            compiled.endpoint,
            Effect.scoped(
              setup.pipe(
                Effect.andThen(
                  openLease(
                    compiled.endpoint,
                    "transaction",
                    compiled.command,
                  ),
                ),
                Effect.flatMap((lease) =>
                  Effect.all(
                    {
                      value: use(lease),
                      code: lease.exitCode,
                    },
                    { concurrency: "unbounded" },
                  ).pipe(
                    Effect.flatMap(({ value, code }) =>
                      code === 0
                        ? Effect.succeed(value)
                        : Effect.fail(
                            new SshExitError({
                              endpoint: compiled.endpoint,
                              operation: "transaction",
                              code,
                            }),
                          ),
                    ),
                    Effect.timeoutOrElse({
                      duration: compiled.readinessTimeoutMs,
                      orElse: () => Effect.fail(new SshTimeoutError({
                          endpoint: compiled.endpoint,
                          operation: "transaction",
                          timeoutMs: compiled.readinessTimeoutMs,
                        })),}),
                    Effect.ensuring(lease.close),
                  ),
                ),
              ),
            ),
          );
        }),
      );

    const forward: SshTransportShape["forward"] = (
      program,
    ): Effect.Effect<SshForwardLease, SshError, Scope.Scope> =>
      Effect.gen(function* () {
        const compiled = yield* Effect.try({
          try: () =>
            compiler.forward(program, randomUUID().replaceAll("-", "")),
          catch: () =>
            new SshSetupError({
              endpoint: "invalid-program",
              message: "SSH forward operation or owned socket path is invalid",
            }),
        });
        return yield* withDial(
          compiled.endpoint,
          Effect.gen(function* () {
            yield* ensureControlDir(compiled.endpoint);
            yield* fs
              .remove(compiled.localSocket, { force: true })
              .pipe(Effect.ignore);
            yield* fs
              .remove(compiled.controlSocket, { force: true })
              .pipe(Effect.ignore);
            // App shutdown quiesces process admission before runtime scopes.
            // Finalization therefore releases this existing ControlPersist=no
            // master lease and unlinks its files without spawning -O helpers.
            const cleanupSocketFiles = fs
              .remove(compiled.localSocket, { force: true })
              .pipe(
                Effect.ignore,
                Effect.andThen(
                  fs
                    .remove(compiled.controlSocket, { force: true })
                    .pipe(Effect.ignore),
                ),
              );
            const master = yield* openLease(
              compiled.endpoint,
              "forward-master",
              compiled.master,
              cleanupSocketFiles,
            );
            yield* Effect.forkIn(
              Stream.runDrain(master.stdout).pipe(Effect.ignore),
              master.scope,
            );
            yield* Effect.forkIn(
              Stream.runDrain(master.stderr).pipe(Effect.ignore),
              master.scope,
            );

            const masterExited: Effect.Effect<never, SshError> =
              master.exitCode.pipe(
                Effect.matchEffect({
                  onFailure: () =>
                    Effect.fail(
                      forwardError(
                        compiled.endpoint,
                        "SSH forward master failed before readiness",
                      ),
                    ),
                  onSuccess: (code) =>
                    Effect.fail(
                      forwardError(
                        compiled.endpoint,
                        `SSH forward master exited before readiness (${code})`,
                      ),
                    ),
                }),
              );
            const waitForControl: Effect.Effect<void, SshError> =
              Effect.suspend(() =>
                Effect.raceFirst(
                  runChecked(
                    compiled.endpoint,
                    "forward-check",
                    compiled.check,
                    1_000,
                  ).pipe(
                    Effect.asVoid,
                    Effect.catch(() =>
                      Effect.sleep(FORWARD_POLL_MS).pipe(
                        Effect.andThen(waitForControl),
                      ),
                    ),
                  ),
                  masterExited,
                ),
              );
            const socketExists = fs
              .exists(compiled.localSocket)
              .pipe(
                Effect.mapError(() =>
                  forwardError(
                    compiled.endpoint,
                    "forward socket readiness check failed",
                  ),
                ),
              );
            const waitForSocket: Effect.Effect<void, SshError> = Effect.suspend(
              () =>
                Effect.raceFirst(
                  socketExists.pipe(
                    Effect.flatMap((exists) =>
                      exists
                        ? Effect.void
                        : Effect.sleep(FORWARD_POLL_MS).pipe(
                            Effect.andThen(waitForSocket),
                          ),
                    ),
                  ),
                  masterExited,
                ),
            );
            const setup = waitForControl.pipe(
              Effect.andThen(
                runChecked(
                  compiled.endpoint,
                  "forward-request",
                  compiled.request,
                  4_000,
                ),
              ),
              Effect.andThen(waitForSocket),
              Effect.timeoutOrElse({
                duration: compiled.readinessTimeoutMs,
                orElse: () => Effect.fail(new SshTimeoutError({
                    endpoint: compiled.endpoint,
                    operation: "forward",
                    timeoutMs: compiled.readinessTimeoutMs,
                  })),}),
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
      }) as Effect.Effect<SshForwardLease, SshError, Scope.Scope>;

    const handoff: SshTransportShape["handoff"] = (
      program,
      awaitReady,
    ) =>
      Effect.try({
        try: () => compiler.daemonHandoff(program),
        catch: () =>
          new SshSetupError({
            endpoint: "invalid-program",
            message: "SSH operation was not created by the policy surface",
          }),
      }).pipe(
        Effect.flatMap((compiled) =>
          withDial(
            compiled.endpoint,
            Effect.gen(function* () {
              yield* ensureControlDir(compiled.endpoint);
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
                    message:
                      "remote daemon handoff did not return a process receipt",
                  }),
                );
              }
              const ready = yield* awaitReady(confirm).pipe(
                Effect.timeoutOrElse({
                  duration: compiled.readinessTimeoutMs,
                  orElse: () => Effect.fail(new SshTimeoutError({
                      endpoint: compiled.endpoint,
                      operation: "daemon-handoff",
                      timeoutMs: compiled.readinessTimeoutMs,
                    })),}),
              );
              return ready.value;
            }),
          ),
        ),
      );

    const warm = (target: SshTarget): Effect.Effect<void, SshError> => {
      const endpoint = inspectSshTarget(target).endpoint;
      let lock = warmLocks.get(String(endpoint));
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        warmLocks.set(String(endpoint), lock);
      }
      return lock.withPermits(1)(
        withDial(
          endpoint,
          ensureControlDir(endpoint).pipe(
            Effect.andThen(
              runChecked(
                endpoint,
                "master-warm",
                compiler.masterWarm(target),
                8_000,
              ),
            ),
            Effect.asVoid,
          ),
        ),
      );
    };

    // Sole caller of compiler.masterExit. Explicit operator action only —
    // the host registry invokes this on removal/edit, never on Layer/Scope
    // disposal where another concurrent command may own the shared master.
    const teardown = (endpoint: SshEndpoint): Effect.Effect<void> =>
      withDial(
        endpoint,
        runChecked(
          endpoint,
          "master-exit",
          compiler.masterExit(endpoint),
          4_000,
        ),
      ).pipe(Effect.asVoid, Effect.ignore);

    return SshTransport.of({
      run,
      transfer,
      connect,
      connectWithExitObservation,
      transact,
      forward,
      handoff,
      warm,
      teardown,
    });
  }),
);
