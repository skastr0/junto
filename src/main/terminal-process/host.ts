import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from "electron";
import terminalEntryPath from "./entry?modulePath";
import type { CoreMessage } from "../core-process/port";
import { TERMINAL_CONNECT } from "./protocol";
import { terminalClient, type TerminalClient } from "./client";

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
  readonly stop: () => void;
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
  const restarted = new Set<() => void>();

  const fork = (): UtilityProcess => {
    const forked = utilityProcess.fork(terminalEntryPath, [], { serviceName: "Junto Terminals", stdio: "inherit" });
    startedAt = Date.now();
    forked.once("exit", () => {
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
      child?.kill();
    },
  };
};
