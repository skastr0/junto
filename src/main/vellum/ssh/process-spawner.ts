import * as Command from "@effect/platform/Command";
import * as NodeSink from "@effect/platform-node/NodeSink";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { Context, Effect, HashMap, Layer, Option, Scope, Sink, Stream } from "effect";
import { releaseOwned, signalOwned, spawnDetachedProcessGroup, type OwnedProcess, type TerminatingSignal } from "../process-signal";

export class ProcessFailure { readonly _tag = "ProcessFailure"; }
export interface ProcessHandle {
  readonly pid: number;
  readonly exitCode: Effect.Effect<number, ProcessFailure>;
  readonly isRunning: Effect.Effect<boolean, ProcessFailure>;
  readonly stdin: Sink.Sink<void, Uint8Array, never, ProcessFailure>;
  readonly stdout: Stream.Stream<Uint8Array, ProcessFailure>;
  readonly stderr: Stream.Stream<Uint8Array, ProcessFailure>;
}
export class ProcessSpawner extends Context.Tag("@vellum/ssh/ProcessSpawner")<ProcessSpawner, { readonly start: (command: Command.Command) => Effect.Effect<ProcessHandle, ProcessFailure, Scope.Scope> }>() {}
const failure = (): ProcessFailure => new ProcessFailure();

type SpawnOutcome = { readonly _tag: "exit"; readonly code: number } | { readonly _tag: "spawn-error"; readonly error: unknown };
type TrackedSshChild = { readonly child: ReturnType<typeof spawnDetachedProcessGroup>["child"]; readonly owned: OwnedProcess; readonly mode: "group" | "child"; readonly outcome: Promise<SpawnOutcome>; readonly spawnFailed: () => boolean };
const stopProcess = (tracked: TrackedSshChild): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (tracked.spawnFailed()) {
      releaseOwned(tracked.owned);
      return Effect.void;
    }
    if (tracked.child.exitCode !== null || tracked.child.signalCode !== null) {
      releaseOwned(tracked.owned);
      return Effect.void;
    }
    const signal = (value: TerminatingSignal) => Effect.sync(() => signalOwned(tracked.owned, value));
    return signal("SIGTERM").pipe(
      Effect.zipRight(Effect.sleep("50 millis")),
      Effect.zipRight(Effect.suspend(() => tracked.child.exitCode === null && tracked.child.signalCode === null ? Effect.sleep("1450 millis") : Effect.void)),
      // The finalizer is bounded: after escalation, process exit is observed
      // by the shared promise but does not hold scope release indefinitely.
      Effect.zipRight(Effect.suspend(() => tracked.child.exitCode === null && tracked.child.signalCode === null ? signal("SIGKILL") : Effect.void)),
      Effect.ensuring(Effect.sync(() => releaseOwned(tracked.owned))),
      Effect.timeout("3 seconds"),
      Effect.ignore,
    );
  });

const startStandard = (command: Command.StandardCommand): Effect.Effect<TrackedSshChild, ProcessFailure> =>
  Effect.try({
    try: () => {
      const environment = HashMap.reduce(command.env, { ...process.env } as Record<string, string | undefined>, (acc, value, key) => ({ ...acc, [key]: value }));
      const spawned = spawnDetachedProcessGroup({
        source: "ssh.process-spawner",
        command: command.command,
        args: command.args,
        options: { cwd: Option.getOrUndefined(command.cwd), env: environment, shell: command.shell, uid: Option.getOrUndefined(command.uid), gid: Option.getOrUndefined(command.gid) },
      });
      let failed = false;
      // Resolve, never reject: async spawn errors can occur before a consumer
      // asks for exitCode, and must never become process-wide rejections.
      const outcome = new Promise<SpawnOutcome>((resolve) => {
        spawned.child.once("exit", (code) => resolve({ _tag: "exit", code: code ?? -1 }));
        spawned.child.once("error", (error) => { failed = true; resolve({ _tag: "spawn-error", error }); });
      });
      return { child: spawned.child, owned: spawned.process, mode: spawned.mode, outcome, spawnFailed: () => failed };
    },
    catch: failure,
  });

export const ProcessSpawnerLive = Layer.succeed(ProcessSpawner, ProcessSpawner.of({
  start: (command) => {
    if (command._tag !== "StandardCommand") return Effect.fail(failure());
    return Effect.acquireRelease(startStandard(command), stopProcess).pipe(Effect.map((tracked): ProcessHandle => ({
      pid: tracked.child.pid ?? -1,
      exitCode: Effect.promise(() => tracked.outcome).pipe(
        Effect.flatMap((outcome) => outcome._tag === "exit" ? Effect.succeed(outcome.code) : Effect.fail(failure())),
      ),
      isRunning: Effect.sync(() => tracked.child.exitCode === null && tracked.child.signalCode === null),
      stdin: NodeSink.fromWritable(() => tracked.child.stdin, failure, { endOnDone: true }),
      stdout: NodeStream.fromReadable(() => tracked.child.stdout, failure),
      stderr: NodeStream.fromReadable(() => tracked.child.stderr, failure),
    })));
  },
}));
