import * as Command from "@effect/platform/Command";
import * as CommandExecutor from "@effect/platform/CommandExecutor";
import { Context, Effect, Layer, Scope, Sink, Stream } from "effect";
import {
  registerOwnedProcess,
  releaseOwnedProcess,
  signalOwnedHandle,
  type OwnedProcessHandle,
} from "../process-signal";

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

type TrackedSshChild = {
  readonly child: CommandExecutor.Process;
  readonly ownedHandle: OwnedProcessHandle | undefined;
};

const stopProcess = (tracked: TrackedSshChild): Effect.Effect<void> =>
  tracked.child.isRunning.pipe(
    Effect.flatMap((running) => {
      if (!running) {
        releaseOwnedProcess(tracked.ownedHandle);
        return Effect.void;
      }
      const awaitExit = tracked.child.exitCode.pipe(Effect.exit, Effect.asVoid);
      const sig = (signal: NodeJS.Signals) =>
        Effect.sync(() => {
          if (tracked.ownedHandle) {
            signalOwnedHandle(tracked.ownedHandle, signal);
          }
          // No bare-pid fallback — unregistered means no OS kill.
        });
      const forceAfterGrace = Effect.sleep("2 seconds").pipe(
        Effect.zipRight(sig("SIGKILL")),
        Effect.zipRight(awaitExit.pipe(Effect.timeout("2 seconds"), Effect.ignore)),
      );
      return sig("SIGTERM").pipe(
        Effect.zipRight(
          Effect.raceFirst(awaitExit, forceAfterGrace).pipe(Effect.interruptible),
        ),
        Effect.ensuring(Effect.sync(() => releaseOwnedProcess(tracked.ownedHandle))),
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
          executor.start(command).pipe(
            Effect.mapError(failure),
            Effect.map((child) => {
              const pid = Number(child.pid);
              const reg = registerOwnedProcess({
                source: "ssh.process-spawner",
                pid: Number.isFinite(pid) ? pid : undefined,
                // SSH ControlMaster children are process-group leaders we own.
                ownsProcessGroup: true,
              });
              return {
                child,
                ownedHandle: reg.ok ? reg.handle : undefined,
              } satisfies TrackedSshChild;
            }),
          ),
          stopProcess,
        ).pipe(
          Effect.map(
            (tracked): ProcessHandle => ({
              pid: Number(tracked.child.pid),
              exitCode: tracked.child.exitCode.pipe(
                Effect.map(Number),
                Effect.mapError(failure),
              ),
              isRunning: tracked.child.isRunning.pipe(Effect.mapError(failure)),
              stdin: tracked.child.stdin.pipe(Sink.mapError(failure)),
              stdout: tracked.child.stdout.pipe(Stream.mapError(failure)),
              stderr: tracked.child.stderr.pipe(Stream.mapError(failure)),
            }),
          ),
        ),
    });
  }),
);
