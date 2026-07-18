import * as FileSystem from "@effect/platform/FileSystem";
import {
  Context,
  Effect,
  ExecutionStrategy,
  Exit,
  Layer,
  Scope,
  Sink,
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
import {
  compileMasterExit,
  compileMasterWarm,
  compileProgram,
  inspectProgram,
} from "./program";
import { ProcessFailure, ProcessSpawner, type ProcessHandle } from "./process-spawner";

const STDOUT_LIMIT_BYTES = 8 * 1024 * 1024;
const STDERR_LIMIT_BYTES = 256 * 1024;
const STDERR_ERROR_BYTES = 4 * 1024;
const FORWARD_POLL_MS = 40;

export interface SshCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface SshLease {
  readonly stdin: Sink.Sink<void, Uint8Array, never, SshError>;
  readonly stdout: Stream.Stream<Uint8Array, SshError>;
  readonly stderr: Stream.Stream<Uint8Array, SshError>;
  readonly exitCode: Effect.Effect<number, SshError>;
  readonly close: Effect.Effect<void>;
}

export interface SshForwardLease {
  readonly localSocket: string;
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
    ) => Effect.Effect<A, SshError | E, R>;
    readonly forward: (program: ForwardProgram) => Effect.Effect<SshForwardLease, SshError>;
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
    readonly maxConcurrentDials: number;
  }
>() {}

interface Collected {
  readonly chunks: ReadonlyArray<Uint8Array>;
  readonly bytes: number;
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
      : Effect.succeed({ chunks: [...state.chunks, chunk], bytes });
  }).pipe(
    Effect.mapError((error) =>
      error instanceof ProcessFailure
        ? new SshIoError({ endpoint, operation, message: "SSH process I/O failed" })
        : error,
    ),
  );

const truncateUtf8 = (value: string, maxBytes: number): string => {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maxBytes ? value : bytes.subarray(0, maxBytes).toString("utf8");
};

const operationName = (tag: ReturnType<typeof inspectProgram>["_tag"]): string => {
  switch (tag) {
    case "OneShot": return "one-shot";
    case "Stream": return "stream";
    case "Forward": return "forward";
    case "DaemonHandoff": return "daemon-handoff";
  }
};

export const SshTransportLayer = Layer.scoped(
  SshTransport,
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* SshTransportConfig;
    const owner = yield* Scope.Scope;
    const dialPermits = yield* Effect.makeSemaphore(config.maxConcurrentDials);
    const warmLocks = new Map<string, Effect.Semaphore>();
    const masters = new Map<string, SshEndpoint>();

    const confirm: ConfirmSshReady = <A>(value: A): SshReady<A> => ({
      [ReadyTypeId]: ReadyTypeId,
      value,
    });

    const ioError = (endpoint: SshEndpoint, operation: string) =>
      new SshIoError({ endpoint, operation, message: "SSH process I/O failed" });

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

    const withDial = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      dialPermits.withPermits(1)(effect);

    const acquire = (
      endpoint: SshEndpoint,
      operation: string,
      command: Parameters<Context.Tag.Service<typeof ProcessSpawner>["start"]>[0],
    ): Effect.Effect<ProcessHandle, SshSpawnError, Scope.Scope> =>
      spawner.start(command).pipe(
        Effect.mapError(() =>
          new SshSpawnError({ endpoint, operation, message: "SSH process could not be started" }),
        ),
      );

    const runProcess = (
      endpoint: SshEndpoint,
      operation: string,
      command: Parameters<Context.Tag.Service<typeof ProcessSpawner>["start"]>[0],
      stdin?: Uint8Array,
    ): Effect.Effect<{ readonly result: SshCommandResult; readonly code: number }, SshError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* acquire(endpoint, operation, command);
          const completed = yield* Effect.all(
            {
              input: Stream.run(
                stdin === undefined ? Stream.empty : Stream.make(stdin),
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
      command: Parameters<Context.Tag.Service<typeof ProcessSpawner>["start"]>[0],
      timeoutMs: number,
      stdin?: Uint8Array,
    ): Effect.Effect<SshCommandResult, SshError> =>
      runProcess(endpoint, operation, command, stdin).pipe(
        Effect.flatMap(({ result, code }) =>
          code === 0
            ? Effect.succeed(result)
            : Effect.fail(
                new SshExitError({
                  endpoint,
                  operation,
                  code,
                  stderr: truncateUtf8(result.stderr, STDERR_ERROR_BYTES),
                }),
              ),
        ),
        Effect.timeoutFail({
          duration: timeoutMs,
          onTimeout: () => new SshTimeoutError({ endpoint, operation, timeoutMs }),
        }),
      );

    const leaseFor = (
      endpoint: SshEndpoint,
      operation: string,
      process: ProcessHandle,
      child: Scope.CloseableScope,
    ): SshLease => ({
      stdin: process.stdin.pipe(Sink.mapError(() => ioError(endpoint, operation))),
      stdout: process.stdout.pipe(Stream.mapError(() => ioError(endpoint, operation))),
      stderr: process.stderr.pipe(Stream.mapError(() => ioError(endpoint, operation))),
      exitCode: process.exitCode.pipe(Effect.mapError(() => ioError(endpoint, operation))),
      close: Scope.close(child, Exit.void).pipe(Effect.ignore),
    });

    const openLease = (
      endpoint: SshEndpoint,
      operation: string,
      command: Parameters<Context.Tag.Service<typeof ProcessSpawner>["start"]>[0],
    ): Effect.Effect<SshLease, SshSpawnError> =>
      Effect.gen(function* () {
        const child = yield* Scope.fork(owner, ExecutionStrategy.sequential);
        const process = yield* acquire(endpoint, operation, command).pipe(
          Scope.extend(child),
          Effect.catchAll((error) =>
            Scope.close(child, Exit.fail(error)).pipe(
              Effect.zipRight(Effect.fail(error)),
            ),
          ),
        );
        return leaseFor(endpoint, operation, process, child);
      });

    const rememberMaster = (endpoint: SshEndpoint): void => {
      masters.set(endpoint, endpoint);
    };

    const run = (program: OneShotProgram): Effect.Effect<SshCommandResult, SshError> => {
      const payload = inspectProgram(program);
      if (payload._tag !== "OneShot") {
        return Effect.die(new TypeError("SshTransport.run received a non-one-shot program"));
      }
      const operation = operationName(payload._tag);
      return withDial(
        ensureControlDir(payload.endpoint).pipe(
          Effect.tap(() => Effect.sync(() => rememberMaster(payload.endpoint))),
          Effect.zipRight(
            runChecked(
              payload.endpoint,
              operation,
              compileProgram(payload, config.controlDir),
              payload.timeoutMs,
              payload.stdin,
            ),
          ),
        ),
      );
    };

    const connect: Context.Tag.Service<typeof SshTransport>["connect"] = (program, awaitReady) => {
      const payload = inspectProgram(program);
      if (payload._tag !== "Stream") {
        return Effect.die(new TypeError("SshTransport.connect received a non-stream program"));
      }
      const operation = operationName(payload._tag);
      const setup = payload.connection === "shared"
        ? ensureControlDir(payload.endpoint).pipe(
            Effect.tap(() => Effect.sync(() => rememberMaster(payload.endpoint))),
          )
        : Effect.void;
      return withDial(
        setup.pipe(
          Effect.zipRight(openLease(payload.endpoint, operation, compileProgram(payload, config.controlDir))),
          Effect.flatMap((lease) =>
            awaitReady(lease, confirm).pipe(
              Effect.timeoutFail({
                duration: payload.readinessTimeoutMs,
                onTimeout: () =>
                  new SshTimeoutError({
                    endpoint: payload.endpoint,
                    operation,
                    timeoutMs: payload.readinessTimeoutMs,
                  }),
              }),
              Effect.onError(() => lease.close),
            ),
          ),
          Effect.map((ready) => ready.value),
        ),
      );
    };

    const forward = (program: ForwardProgram): Effect.Effect<SshForwardLease, SshError> => {
      const payload = inspectProgram(program);
      if (payload._tag !== "Forward") {
        return Effect.die(new TypeError("SshTransport.forward received a non-forward program"));
      }
      const operation = operationName(payload._tag);
      return withDial(
        openLease(payload.endpoint, operation, compileProgram(payload, config.controlDir)).pipe(
          Effect.flatMap((lease) => {
            const waitForSocket: Effect.Effect<void, SshError> = Effect.suspend(() =>
              fs.exists(payload.localSocket).pipe(
                Effect.mapError(() =>
                  new SshForwardError({
                    endpoint: payload.endpoint,
                    message: "forward socket readiness check failed",
                  }),
                ),
                Effect.flatMap((exists) =>
                  exists
                    ? Effect.void
                    : Effect.raceFirst(
                        lease.exitCode.pipe(
                          Effect.flatMap((code) =>
                            Effect.fail(
                              new SshForwardError({
                                endpoint: payload.endpoint,
                                message: `SSH forward exited before readiness (${code})`,
                              }),
                            ),
                          ),
                        ),
                        Effect.sleep(FORWARD_POLL_MS).pipe(Effect.zipRight(waitForSocket)),
                      ),
                ),
              ),
            );
            return waitForSocket.pipe(
              Effect.timeoutFail({
                duration: payload.readinessTimeoutMs,
                onTimeout: () =>
                  new SshTimeoutError({
                    endpoint: payload.endpoint,
                    operation,
                    timeoutMs: payload.readinessTimeoutMs,
                  }),
              }),
              Effect.onError(() => lease.close),
              Effect.as({
                localSocket: payload.localSocket,
                close: lease.close,
                exitCode: lease.exitCode,
              }),
            );
          }),
        ),
      );
    };

    const handoff: Context.Tag.Service<typeof SshTransport>["handoff"] = (program, awaitReady) => {
      const payload = inspectProgram(program);
      if (payload._tag !== "DaemonHandoff") {
        return Effect.die(new TypeError("SshTransport.handoff received a non-daemon program"));
      }
      const operation = operationName(payload._tag);
      return withDial(
        Effect.gen(function* () {
          yield* ensureControlDir(payload.endpoint);
          rememberMaster(payload.endpoint);
          const result = yield* runChecked(
            payload.endpoint,
            operation,
            compileProgram(payload, config.controlDir),
            payload.readinessTimeoutMs,
          );
          if (!/^\d+$/u.test(result.stdout.trim())) {
            return yield* Effect.fail(
              new SshIoError({
                endpoint: payload.endpoint,
                operation,
                message: "remote daemon handoff did not return a process receipt",
              }),
            );
          }
          const ready = yield* awaitReady(confirm).pipe(
            Effect.timeoutFail({
              duration: payload.readinessTimeoutMs,
              onTimeout: () =>
                new SshTimeoutError({
                  endpoint: payload.endpoint,
                  operation,
                  timeoutMs: payload.readinessTimeoutMs,
                }),
            }),
          );
          return ready.value;
        }),
      );
    };

    const warm = (endpoint: SshEndpoint): Effect.Effect<void, SshError> => {
      let lock = warmLocks.get(endpoint);
      if (!lock) {
        lock = Effect.unsafeMakeSemaphore(1);
        warmLocks.set(endpoint, lock);
      }
      return lock.withPermits(1)(
        withDial(
          ensureControlDir(endpoint).pipe(
            Effect.tap(() => Effect.sync(() => rememberMaster(endpoint))),
            Effect.zipRight(
              runChecked(endpoint, "master-warm", compileMasterWarm(endpoint, config.controlDir), 8_000),
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
              compileMasterExit(endpoint, config.controlDir),
              4_000,
            ).pipe(Effect.ignore),
          { concurrency: 4, discard: true },
        ),
      ),
    );

    return SshTransport.of({ run, connect, forward, handoff, warm });
  }),
);
