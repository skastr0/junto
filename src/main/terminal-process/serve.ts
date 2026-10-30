import type { IPty } from "node-pty";
import type { CoreMessage, CorePort } from "../core-process/port";
import { readSingleProcessEpochSnapshotAsync, type ChildProcessEpoch } from "../junto/process-epoch";
import {
  TERMINAL_SPAWN,
  TerminalInbound,
  TerminalOutbound,
  type TerminalData,
  type TerminalError,
  type TerminalExitEvent,
  type TerminalKill,
  type TerminalResize,
  type TerminalSpawnInput,
  type TerminalWrite,
} from "./protocol";

/**
 * The terminal process's side (phase 1): it holds every PTY, runs what the
 * core asks of them, and pushes their output and exit back on the same port.
 * It decides nothing about seats; the core keeps every gate.
 *
 * A signal reaches a PTY only while its pid still names the process this
 * side spawned: the start epoch is taken at spawn and read again before each
 * kill, as the plane does for a local PTY (process-signal.ts). node-pty can
 * report an exit after the child was reaped, so the exit alone does not
 * close that window. A PTY that has exited takes no more input.
 *
 * Both reads are the asynchronous one-pid `ps`, never the synchronous one:
 * this process carries every PTY's bytes, and a blocking fork would stall
 * them all at each spawn and each signal.
 */
export type SpawnPty = (command: string, args: readonly string[], options: {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}) => IPty;

/** The pid identity reads behind a signal; the process table by default. */
export type PtyEpochs = {
  readonly capture: (pid: number) => Promise<ChildProcessEpoch | undefined>;
  readonly isCurrent: (pid: number, epoch: ChildProcessEpoch) => Promise<boolean>;
};

const rowOf = async (pid: number): Promise<ChildProcessEpoch | undefined> => {
  const row = (await readSingleProcessEpochSnapshotAsync(pid))?.find((candidate) => candidate.pid === pid);
  return row === undefined ? undefined : { pid: row.pid, startKey: row.startKey };
};

const systemEpochs: PtyEpochs = {
  capture: rowOf,
  isCurrent: async (pid, epoch) => epoch.pid === pid && (await rowOf(pid))?.startKey === epoch.startKey,
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const serveTerminals = (
  port: CorePort,
  spawnPty: SpawnPty,
  epochs: PtyEpochs = systemEpochs,
): { readonly close: () => void; readonly live: () => number } => {
  const ptys = new Map<number, IPty>();
  // Taken at spawn; a PTY whose epoch could not be read is never signalled.
  const epochOf = new Map<number, Promise<ChildProcessEpoch | undefined>>();
  const push = (channel: string, payload: TerminalData | TerminalExitEvent | TerminalError): void =>
    port.post({ kind: "push", channel, payload });

  const spawn = (input: TerminalSpawnInput): number | undefined => {
    if (ptys.has(input.id)) throw new Error(`terminal ${input.id} already exists`);
    const pty = spawnPty(input.command, input.args, {
      name: "xterm-256color",
      cols: input.cols,
      rows: input.rows,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.env === undefined
        ? {}
        : { env: Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) }),
      // Never node-pty `handleFlowControl`: it swallows a lone Ctrl+S and
      // pauses the read with no resume (app-process-plane.ts spawnTerminal).
    });
    ptys.set(input.id, pty);
    epochOf.set(input.id, epochs.capture(pty.pid).catch(() => undefined));
    // The exit witness first, then the stream, as the plane installs them.
    pty.onExit(({ exitCode, signal }) => {
      ptys.delete(input.id);
      epochOf.delete(input.id);
      push(TerminalOutbound.exit, { id: input.id, code: exitCode ?? undefined, signal: signal ?? undefined });
    });
    pty.onData((data) => push(TerminalOutbound.data, { id: input.id, data }));
    return pty.pid;
  };

  const inbound = (channel: string, payload: unknown): void => {
    if (channel === TerminalInbound.write) {
      const { id, data } = payload as TerminalWrite;
      const pty = ptys.get(id);
      if (pty === undefined) return push(TerminalOutbound.error, { id, message: "terminal process already exited" });
      try {
        pty.write(data);
      } catch (error) {
        push(TerminalOutbound.error, { id, message: errorMessage(error) });
      }
      return;
    }
    if (channel === TerminalInbound.resize) {
      const { id, cols, rows } = payload as TerminalResize;
      try {
        ptys.get(id)?.resize(cols, rows);
      } catch (error) {
        push(TerminalOutbound.error, { id, message: errorMessage(error) });
      }
      return;
    }
    if (channel === TerminalInbound.kill) {
      const { id, signal } = payload as TerminalKill;
      const pty = ptys.get(id);
      const captured = epochOf.get(id);
      if (pty === undefined || captured === undefined) return;
      void (async () => {
        const epoch = await captured;
        // Gone, reaped or reused: the signal is dropped, never sent to a pid.
        if (epoch === undefined || !(await epochs.isCurrent(pty.pid, epoch).catch(() => false))) return;
        // The exit may have been reported while the table was read.
        if (ptys.get(id) !== pty) return;
        try {
          pty.kill(signal);
        } catch {
          // The child is already gone; its exit witness reports it.
        }
      })();
    }
  };

  const close = port.listen((message: CoreMessage) => {
    if (message.kind === "push") return inbound(message.channel, message.payload);
    if (message.kind !== "call") return;
    if (message.name !== TERMINAL_SPAWN) {
      port.post({ kind: "answer", id: message.id, ok: false, failure: { tag: "UnknownTerminalOp", message: `no terminal operation named ${message.name}` } });
      return;
    }
    try {
      const pid = spawn(message.input as TerminalSpawnInput);
      port.post({ kind: "answer", id: message.id, ok: true, value: { pid } });
    } catch (error) {
      port.post({ kind: "answer", id: message.id, ok: false, failure: { tag: "TerminalBackendUnavailable", message: errorMessage(error) } });
    }
  });

  return { close, live: () => ptys.size };
};
