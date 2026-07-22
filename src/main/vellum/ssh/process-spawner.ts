import * as Command from "@effect/platform/Command";
import * as CommandExecutor from "@effect/platform/CommandExecutor";
import { Context, Effect, Layer, Scope, Sink, Stream } from "effect";
import { signalOwnedProcess } from "../process-signal";

export class ProcessFailure {
  readonly _tag = "ProcessFailure";
}

export interface ProcessHandle {
  readonly pid: number;
  readonly exitCode: Effect.Effect<number, ProcessFailure>;
  readonly isRunning: Effect.Effect<boolean, ProcessFailure>;
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

const signalOwnedSshProcess = (pid: number, signal: NodeJS.Signals): Effect.Effect<void> =>
  Effect.sync(() => {
    // SSH transport owns detached ControlMaster children as process groups.
    // Still goes through the sealed gate — refuses init/self/parent/-1.
    signalOwnedProcess({
      source: "ssh.process-spawner",
      pid,
      signal,
      ownsProcessGroup: true,
    });
  }).pipe(Effect.ignore);

const stopProcess = (child: CommandExecutor.Process): Effect.Effect<void> =>
  child.isRunning.pipe(
    Effect.flatMap((running) => {
      if (!running) return Effect.void;
      const pid = Number(child.pid);
      const awaitExit = child.exitCode.pipe(Effect.exit, Effect.asVoid);
      const forceAfterGrace = Effect.sleep("2 seconds").pipe(
        Effect.zipRight(signalOwnedSshProcess(pid, "SIGKILL")),
        Effect.zipRight(awaitExit.pipe(Effect.timeout("2 seconds"), Effect.ignore)),
      );
      return signalOwnedSshProcess(pid, "SIGTERM").pipe(
        Effect.zipRight(
          // acquireRelease finalizers run masked. Re-enable interruption for
          // the race so the losing grace timer does not delay a prompt exit.
          Effect.raceFirst(awaitExit, forceAfterGrace).pipe(Effect.interruptible),
        ),
      );
    }),
    Effect.timeout("5 seconds"),
    Effect.ignore,
  );

export const ProcessSpawnerLive = Layer.effect(
  ProcessSpawner,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;

    return ProcessSpawner.of({
      start: (command) =>
        Effect.acquireRelease(
          executor.start(command).pipe(Effect.mapError(failure)),
          stopProcess,
        ).pipe(
          Effect.map((process): ProcessHandle => ({
            pid: Number(process.pid),
            exitCode: process.exitCode.pipe(
              Effect.map(Number),
              Effect.mapError(failure),
            ),
            isRunning: process.isRunning.pipe(Effect.mapError(failure)),
            stdin: process.stdin.pipe(Sink.mapError(failure)),
            stdout: process.stdout.pipe(Stream.mapError(failure)),
            stderr: process.stderr.pipe(Stream.mapError(failure)),
          })),
        ),
    });
  }),
);
