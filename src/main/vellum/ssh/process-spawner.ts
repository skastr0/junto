import * as Command from "@effect/platform/Command";
import * as NodeSink from "@effect/platform-node/NodeSink";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { Context, Effect, HashMap, Layer, Option, Scope, Sink, Stream } from "effect";
import {
  appProcessPlane,
  type AppProcessLease,
} from "../app-process-plane";

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

const SSH_PROCESS_TERM_GRACE_MS = 1_500;
const SSH_PROCESS_KILL_GRACE_MS = 1_500;

type SpawnOutcome =
  | { readonly _tag: "exit"; readonly code: number }
  | { readonly _tag: "pre-spawn-error"; readonly error: unknown }
  | { readonly _tag: "closed-without-exit" };

type TrackedSshChild = {
  readonly lease: AppProcessLease;
  readonly outcome: Promise<SpawnOutcome>;
  readonly terminalObservation: Promise<void>;
  readonly preSpawnFailed: () => boolean;
  readonly terminalObserved: () => boolean;
};

const waitBounded = (
  observation: Promise<void>,
  milliseconds: number,
): Promise<boolean> => new Promise((resolve) => {
  let settled = false;
  const finish = (observed: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(observed);
  };
  const timer = setTimeout(() => finish(false), milliseconds);
  void observation.then(
    () => finish(true),
    () => finish(false),
  );
});

const stopProcess = (tracked: TrackedSshChild): Effect.Effect<void> =>
  Effect.promise(async () => {
    if (tracked.terminalObserved()) return;

    // An asynchronous spawn error with no pid proves that no process was
    // admitted. It is not an exit/close witness, so still give the central
    // plane's close observer a short bounded opportunity to settle its record.
    if (tracked.preSpawnFailed()) {
      await waitBounded(tracked.terminalObservation, SSH_PROCESS_TERM_GRACE_MS);
      return;
    }

    appProcessPlane.terminate(tracked.lease, "SSH Effect scope finalized");
    if (await waitBounded(
      tracked.terminalObservation,
      SSH_PROCESS_TERM_GRACE_MS,
    )) return;

    // The lease, not a pid or raw ChildProcess, decides whether authority is
    // still live. A refused receipt remains visible to the aggregate app drain.
    appProcessPlane.forceTerminate(
      tracked.lease,
      "SSH Effect scope exceeded TERM grace",
    );
    await waitBounded(
      tracked.terminalObservation,
      SSH_PROCESS_KILL_GRACE_MS,
    );
  });

const startStandard = (command: Command.StandardCommand): Effect.Effect<TrackedSshChild, ProcessFailure> =>
  Effect.try({
    try: () => {
      const environment = HashMap.reduce(command.env, { ...process.env } as Record<string, string | undefined>, (acc, value, key) => ({ ...acc, [key]: value }));
      const lease = appProcessPlane.spawnGroup({
        source: "ssh.process-spawner",
        purpose: "SSH transport command",
        command: command.command,
        args: command.args,
        cwd: Option.getOrUndefined(command.cwd),
        env: environment,
        shell: command.shell,
        uid: Option.getOrUndefined(command.uid),
        gid: Option.getOrUndefined(command.gid),
      });
      let preSpawnFailed = false;
      let terminalObserved = false;
      let outcomeSettled = false;
      let resolveOutcome!: (outcome: SpawnOutcome) => void;
      let resolveTerminal!: () => void;
      const outcome = new Promise<SpawnOutcome>((resolve) => {
        resolveOutcome = resolve;
      });
      const terminalObservation = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
      });
      const settleOutcome = (value: SpawnOutcome): void => {
        if (outcomeSettled) return;
        outcomeSettled = true;
        resolveOutcome(value);
      };
      const settleTerminal = (): void => {
        if (terminalObserved) return;
        terminalObserved = true;
        resolveTerminal();
      };

      // Resolve, never reject: async spawn errors can occur before a consumer
      // asks for exitCode, and must never become process-wide rejections.
      lease.io.onExit(({ code }) => {
        settleOutcome({ _tag: "exit", code: code ?? -1 });
        settleTerminal();
      });
      lease.io.onClose(() => {
        settleOutcome({ _tag: "closed-without-exit" });
        settleTerminal();
      });
      lease.io.onError((error) => {
        // A missing executable has no child pid: it is the sole error that
        // proves no owned child ever started. Later errors are diagnostic and
        // must not fabricate an exit/close witness or cancel TERM→KILL.
        if (lease.io.pidForDiagnostics === undefined) {
          preSpawnFailed = true;
          settleOutcome({ _tag: "pre-spawn-error", error });
        }
      });
      return {
        lease,
        outcome,
        terminalObservation,
        preSpawnFailed: () => preSpawnFailed,
        terminalObserved: () => terminalObserved,
      };
    },
    catch: failure,
  });

export const ProcessSpawnerLive = Layer.succeed(ProcessSpawner, ProcessSpawner.of({
  start: (command) => {
    if (command._tag !== "StandardCommand") return Effect.fail(failure());
    return Effect.acquireRelease(startStandard(command), stopProcess).pipe(Effect.map((tracked): ProcessHandle => ({
      pid: tracked.lease.io.pidForDiagnostics ?? -1,
      exitCode: Effect.promise(() => tracked.outcome).pipe(
        Effect.flatMap((outcome) => outcome._tag === "exit" ? Effect.succeed(outcome.code) : Effect.fail(failure())),
      ),
      isRunning: Effect.sync(() =>
        !tracked.preSpawnFailed() && !tracked.terminalObserved()
      ),
      stdin: NodeSink.fromWritable(() => tracked.lease.io.stdin, failure, { endOnDone: true }),
      stdout: NodeStream.fromReadable(() => tracked.lease.io.stdout, failure),
      stderr: NodeStream.fromReadable(() => tracked.lease.io.stderr, failure),
    })));
  },
}));
