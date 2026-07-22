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

type SpawnOutcome = { readonly _tag: "exit"; readonly code: number } | { readonly _tag: "pre-spawn-error"; readonly error: unknown };
type TrackedSshChild = { readonly child: ReturnType<typeof spawnDetachedProcessGroup>["child"]; readonly owned: OwnedProcess; readonly mode: "group" | "child"; readonly outcome: Promise<SpawnOutcome>; readonly preSpawnFailed: () => boolean };
const stopProcess = (tracked: TrackedSshChild): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (tracked.preSpawnFailed()) {
      releaseOwned(tracked.owned);
      return Effect.void;
    }
    if (tracked.child.exitCode !== null || tracked.child.signalCode !== null) {
      releaseOwned(tracked.owned);
      return Effect.void;
    }
    const signal = (value: TerminatingSignal) => Effect.sync(() => signalOwned(tracked.owned, value));
    const observeSettlement = () => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 50);
      tracked.outcome.then(() => { clearTimeout(timer); resolve(true); });
    });
    return Effect.promise(observeSettlement).pipe(
      Effect.flatMap((settled) => settled
        ? Effect.sync(() => releaseOwned(tracked.owned))
        : signal("SIGTERM").pipe(
          Effect.zipRight(Effect.sleep("50 millis")),
          Effect.zipRight(Effect.suspend(() => tracked.child.exitCode === null && tracked.child.signalCode === null ? Effect.sleep("1400 millis").pipe(Effect.zipRight(signal("SIGKILL"))) : Effect.void)),
          Effect.ensuring(Effect.sync(() => releaseOwned(tracked.owned))),
          Effect.timeout("3 seconds"),
          Effect.ignore,
        )),
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
      let preSpawnFailed = false;
      // Resolve, never reject: async spawn errors can occur before a consumer
      // asks for exitCode, and must never become process-wide rejections.
      const outcome = new Promise<SpawnOutcome>((resolve) => {
        spawned.child.once("exit", (code) => resolve({ _tag: "exit", code: code ?? -1 }));
        spawned.child.on("error", (error) => {
          // A missing executable has no child pid: it is the sole error that
          // proves no owned child ever started. Later errors are not exit
          // witnesses and must leave TERM→KILL authority intact.
          if (spawned.child.pid === undefined) {
            preSpawnFailed = true;
            resolve({ _tag: "pre-spawn-error", error });
          }
        });
      });
      return { child: spawned.child, owned: spawned.process, mode: spawned.mode, outcome, preSpawnFailed: () => preSpawnFailed };
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
      isRunning: Effect.sync(() => !tracked.preSpawnFailed() && tracked.child.exitCode === null && tracked.child.signalCode === null),
      stdin: NodeSink.fromWritable(() => tracked.child.stdin, failure, { endOnDone: true }),
      stdout: NodeStream.fromReadable(() => tracked.child.stdout, failure),
      stderr: NodeStream.fromReadable(() => tracked.child.stderr, failure),
    })));
  },
}));
