// S7 V4: platform/Command → effect/unstable/process/ChildProcess;
//   NodeSink/NodeStream → partial Stdio / platform-node shape change on pin.
//   Map: src/cli/effect-v4-import-map.ts — no rewrite while effect@3.21
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
/**
 * S4 (effect@3.21): single canonical Tag `@vellum/ssh/ProcessSpawner`.
 * No dual Effect.Service / Context.Service until Effect V4 pin.
 * @see docs/END_STATE-effect-foundation.md §S4
 */
export class ProcessSpawner extends Context.Tag("@vellum/ssh/ProcessSpawner")<
  ProcessSpawner,
  {
    readonly start: (
      command: Command.Command,
    ) => Effect.Effect<ProcessHandle, ProcessFailure, Scope.Scope>;
  }
>() {}

export type ProcessSpawnerShape = Context.Tag.Service<typeof ProcessSpawner>;
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
  readonly closeObservation: Promise<void>;
  readonly preSpawnFailed: () => boolean;
  readonly processEnded: () => boolean;
  readonly closeObserved: () => boolean;
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
    if (tracked.closeObserved()) return;

    // An asynchronous spawn error with no pid proves that no process was
    // admitted. It is not a close witness, so still give the central
    // plane's close observer a short bounded opportunity to settle its record.
    if (tracked.preSpawnFailed()) {
      await waitBounded(tracked.closeObservation, SSH_PROCESS_TERM_GRACE_MS);
      return;
    }

    appProcessPlane.terminate(tracked.lease, "SSH Effect scope finalized");
    if (await waitBounded(
      tracked.closeObservation,
      SSH_PROCESS_TERM_GRACE_MS,
    )) return;

    // The lease, not a pid or raw ChildProcess, decides whether authority is
    // still live. A refused receipt remains visible to the aggregate app drain.
    appProcessPlane.forceTerminate(
      tracked.lease,
      "SSH Effect scope exceeded TERM grace",
    );
    await waitBounded(
      tracked.closeObservation,
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
      let processEnded = false;
      let closeObserved = false;
      let outcomeSettled = false;
      let resolveOutcome!: (outcome: SpawnOutcome) => void;
      let resolveClose!: () => void;
      const outcome = new Promise<SpawnOutcome>((resolve) => {
        resolveOutcome = resolve;
      });
      const closeObservation = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      const settleOutcome = (value: SpawnOutcome): void => {
        if (outcomeSettled) return;
        outcomeSettled = true;
        resolveOutcome(value);
      };
      const settleClose = (): void => {
        processEnded = true;
        if (closeObserved) return;
        closeObserved = true;
        resolveClose();
      };

      // Resolve, never reject: async spawn errors can occur before a consumer
      // asks for exitCode, and must never become process-wide rejections.
      lease.io.onExit(({ code }) => {
        processEnded = true;
        settleOutcome({ _tag: "exit", code: code ?? -1 });
      });
      lease.io.onClose(() => {
        settleOutcome({ _tag: "closed-without-exit" });
        settleClose();
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
        closeObservation,
        preSpawnFailed: () => preSpawnFailed,
        processEnded: () => processEnded,
        closeObserved: () => closeObserved,
      };
    },
    catch: failure,
  });

/**
 * NodeWritable/Readable emit async EPIPE after the peer closes the SSH pipe.
 * Without a listener, that becomes Electron's "JavaScript error in the main
 * process" dialog even when Effect already maps the failure into deploy stages.
 * Attach once; rethrow non-broken-pipe faults so real IO bugs stay loud.
 */
const containBrokenPipe = (stream: {
  readonly on: (
    event: "error",
    listener: (error: NodeJS.ErrnoException) => void,
  ) => unknown;
}): void => {
  stream.on("error", (error) => {
    if (
      error.code === "EPIPE" ||
      error.code === "EIO" ||
      error.code === "ERR_STREAM_DESTROYED"
    ) {
      return;
    }
    throw error;
  });
};

export const ProcessSpawnerLive = Layer.succeed(ProcessSpawner, ProcessSpawner.of({
  start: (command) => {
    if (command._tag !== "StandardCommand") return Effect.fail(failure());
    return Effect.acquireRelease(startStandard(command), stopProcess).pipe(Effect.map((tracked): ProcessHandle => {
      containBrokenPipe(tracked.lease.io.stdin);
      containBrokenPipe(tracked.lease.io.stdout);
      containBrokenPipe(tracked.lease.io.stderr);
      return {
        pid: tracked.lease.io.pidForDiagnostics ?? -1,
        exitCode: Effect.promise(() => tracked.outcome).pipe(
          Effect.flatMap((outcome) => outcome._tag === "exit" ? Effect.succeed(outcome.code) : Effect.fail(failure())),
        ),
        isRunning: Effect.sync(() =>
          !tracked.preSpawnFailed() && !tracked.processEnded()
        ),
        stdin: NodeSink.fromWritable(() => tracked.lease.io.stdin, failure, { endOnDone: true }),
        stdout: NodeStream.fromReadable(() => tracked.lease.io.stdout, failure),
        stderr: NodeStream.fromReadable(() => tracked.lease.io.stderr, failure),
      };
    }));
  },
}));
