import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from "electron";
import { Effect, Option, Schema } from "effect";
import terminalEntryPath from "../../terminal/entry?modulePath";
import type { CoreMessage } from "../../contract/core/port";
import { TERMINAL_CONNECT, TerminalInbound } from "../../contract/terminal/protocol";
import { terminalClient, type TerminalClient } from "../../node/terminals/client";

/** How long a stopping terminal process has to report its exit before it is killed again. */
const STOP_DEADLINE_MS = 10_000;

/** The terminal process did not leave within its stop bound; a quit reports this, never swallows it. */
export class TerminalsDidNotStop extends Schema.TaggedError<TerminalsDidNotStop>()("TerminalsDidNotStop", {
  detail: Schema.String,
}) {}

/** The child's `exit`, as an effect; the listener goes when the effect is interrupted. */
const exited = (child: UtilityProcess, gone: () => boolean): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (gone()) {
      resume(Effect.void);
      return;
    }
    const onExit = (): void => resume(Effect.void);
    child.once("exit", onExit);
    return Effect.sync(() => {
      child.off("exit", onExit);
    });
  });

/**
 * Main's side of the terminal process (phase 1). It forks `entry.ts` as an
 * Electron utilityProcess and gives the process plane a `TerminalClient`.
 * When the terminal process exits, every PTY it held is reported exited (its
 * children lost their terminal with it) and the next spawn starts a new one.
 */

export const startTerminalProcess = (): TerminalClient & { readonly stop: () => void } => {
  let child: UtilityProcess | undefined;
  let stopping = false;
  const handlers = new Set<(message: CoreMessage) => void>();

  const fork = (): UtilityProcess => {
    const forked = utilityProcess.fork(terminalEntryPath, [], { serviceName: "Junto Terminals", stdio: "inherit" });
    forked.on("message", (message: CoreMessage) => {
      for (const handler of handlers) handler(message);
    });
    forked.once("exit", (code) => {
      if (child !== forked) return;
      child = undefined;
      client.fail(`the Junto terminal process exited with code ${code}`);
    });
    return forked;
  };

  const client = terminalClient({
    post: (message) => {
      if (stopping) return;
      child ??= fork();
      child.postMessage(message);
    },
    listen: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  }, (message, surface) => {
    // Behind every spawn on the same port, so it reaches a PTY that exists.
    if (stopping || child === undefined) return (surface as MessagePortMain).close();
    child.postMessage(message, [surface as MessagePortMain]);
  });

  return {
    ...client,
    stop: () => {
      stopping = true;
      child?.kill();
    },
  };
};

export type TerminalProcessForCore = {
  /** A new port to the terminal process, forking it first if it is not running. */
  readonly connect: () => MessagePortMain;
  /** Told when a terminal process that exited has a successor to connect to. */
  readonly onRestart: (listener: () => void) => () => void;
  /** Signal it to stop and finish when it has left, bounded, or fail tagged. */
  readonly stop: () => Effect.Effect<void, TerminalsDidNotStop>;
};

const RESTART_FIRST_MS = 1_000;
const RESTART_MAX_MS = 30_000;
const RESTART_SETTLED_MS = 60_000;

/**
 * The terminal process when the core runs in its own process (one plane, in
 * the core): main forks it and hands the core a port to it, and serves no
 * terminal itself. When it exits, its PTYs went with it (the core's client
 * reports them exited as its port closes) and a successor is connected after
 * 1 s, doubling to 30 s while it keeps exiting.
 */
export const startTerminalProcessForCore = (): TerminalProcessForCore => {
  let child: UtilityProcess | undefined;
  let stopping = false;
  let stops = 0;
  let startedAt = 0;
  /** Children that have already emitted `exit`; a stop waits on nothing for them. */
  const gone = new WeakSet<UtilityProcess>();
  const restarted = new Set<() => void>();

  const fork = (): UtilityProcess => {
    const forked = utilityProcess.fork(terminalEntryPath, [], { serviceName: "Junto Terminals", stdio: "inherit" });
    startedAt = Date.now();
    forked.once("exit", () => {
      gone.add(forked);
      if (child !== forked) return;
      child = undefined;
      if (stopping) return;
      if (Date.now() - startedAt > RESTART_SETTLED_MS) stops = 0;
      setTimeout(() => {
        if (stopping) return;
        for (const listener of [...restarted]) listener();
      }, Math.min(RESTART_MAX_MS, RESTART_FIRST_MS * 2 ** stops)).unref();
      stops += 1;
    });
    return forked;
  };

  return {
    connect: () => {
      const { port1, port2 } = new MessageChannelMain();
      if (stopping) {
        port1.close();
        return port2;
      }
      child ??= fork();
      child.postMessage({ kind: "push", channel: TERMINAL_CONNECT, payload: {} }, [port1]);
      return port2;
    },
    onRestart: (listener) => {
      restarted.add(listener);
      return () => restarted.delete(listener);
    },
    stop: () => {
      stopping = true;
      const leaving = child;
      if (leaving === undefined) return Effect.void;
      // Which hangup is authoritative: with a live core, the core's. Its drain
      // posts `pty.hangupAll` on its own port (junto/term/core-seats.ts) before
      // it exits, and the children scope runs the core's finalizer before this
      // one, so by the time this stop runs the PTYs have been hung up by their
      // owner. This `pty.shutdown` is the backstop for a core that is already
      // gone — crashed or killed — whose PTYs kept running, detached, for the
      // next core to adopt; an orderly quit must not leave them behind.
      //
      // A second hangup is safe. `pty.hangupAll` walks the PTYs the process
      // still holds: a PTY whose exit has arrived has left that table, and one
      // whose exit has not is signalled only if its pid is still the child that
      // was spawned (the epoch guard). So either hangup may run first, and both
      // may run: the worst a repeat is, is a second SIGHUP to the same child,
      // never a signal to a pid that was reaped or reused.
      try {
        leaving.postMessage({ kind: "push", channel: TerminalInbound.shutdown, payload: {} });
      } catch {
        // The child is already gone: its exit is the answer, and the wait sees it.
      }
      return Effect.suspend(() =>
        exited(leaving, () => gone.has(leaving)).pipe(
          Effect.timeoutOption(STOP_DEADLINE_MS),
          Effect.flatMap(
            Option.match({
              onSome: () => Effect.void,
              onNone: () =>
                Effect.sync(() => leaving.kill()).pipe(
                  Effect.andThen(
                    Effect.fail(new TerminalsDidNotStop({
                      detail: `the Junto terminal process did not exit within ${STOP_DEADLINE_MS} ms of its stop; killed`,
                    })),
                  ),
                ),
            }),
          ),
        ),
      );
    },
  };
};
