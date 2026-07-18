import * as Command from "@effect/platform/Command";
import * as CommandExecutor from "@effect/platform/CommandExecutor";
import { Context, Effect, Layer, Scope, Sink, Stream } from "effect";
import { resolvedSpawnEnv, resolvedSpawnEnvSync } from "../adapters/exec";

export class ProcessFailure {
  readonly _tag = "ProcessFailure";
}

export interface ProcessHandle {
  readonly exitCode: Effect.Effect<number, ProcessFailure>;
  readonly isRunning: Effect.Effect<boolean, ProcessFailure>;
  readonly kill: (signal: CommandExecutor.Signal) => Effect.Effect<void, ProcessFailure>;
  readonly stdin: Sink.Sink<void, Uint8Array, never, ProcessFailure>;
  readonly stdout: Stream.Stream<Uint8Array, ProcessFailure>;
  readonly stderr: Stream.Stream<Uint8Array, ProcessFailure>;
}

export class ProcessSpawner extends Context.Tag("@vellum/ssh/ProcessSpawner")<
  ProcessSpawner,
  {
    readonly start: (command: Command.Command) => Effect.Effect<ProcessHandle, ProcessFailure, Scope.Scope>;
  }
>() {}

const failure = (): ProcessFailure => new ProcessFailure();

const stopProcess = (process: CommandExecutor.Process): Effect.Effect<void> =>
  process.isRunning.pipe(
    Effect.flatMap((running) => {
      if (!running) return Effect.void;
      const awaitExit = process.exitCode.pipe(Effect.asVoid);
      const forceAfterGrace = Effect.sleep("2 seconds").pipe(
        Effect.zipRight(process.kill("SIGKILL")),
        Effect.zipRight(awaitExit),
      );
      return process.kill("SIGTERM").pipe(
        Effect.zipRight(Effect.raceFirst(awaitExit, forceAfterGrace)),
      );
    }),
    Effect.timeout("4 seconds"),
    Effect.ignore,
  );

export const ProcessSpawnerLive = Layer.effect(
  ProcessSpawner,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const env = yield* Effect.tryPromise({
      try: resolvedSpawnEnv,
      catch: failure,
    }).pipe(Effect.orElseSucceed(resolvedSpawnEnvSync));

    return ProcessSpawner.of({
      start: (command) =>
        Effect.acquireRelease(
          executor.start(Command.env(command, env)).pipe(Effect.mapError(failure)),
          stopProcess,
        ).pipe(
          Effect.map((process): ProcessHandle => ({
            exitCode: process.exitCode.pipe(
              Effect.map(Number),
              Effect.mapError(failure),
            ),
            isRunning: process.isRunning.pipe(Effect.mapError(failure)),
            kill: (signal) => process.kill(signal).pipe(Effect.mapError(failure)),
            stdin: process.stdin.pipe(Sink.mapError(failure)),
            stdout: process.stdout.pipe(Stream.mapError(failure)),
            stderr: process.stderr.pipe(Stream.mapError(failure)),
          })),
        ),
    });
  }),
);
